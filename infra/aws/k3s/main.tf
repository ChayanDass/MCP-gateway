# Two small Ubuntu machines: one k3s server (control plane) and one k3s agent (worker).
# Uses the default VPC in the region, so no NAT gateway is needed.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "k3s" {
  key_name   = var.name
  public_key = file(var.public_key_path)
}

resource "aws_security_group" "k3s" {
  name        = var.name
  description = "k3s cluster: admin access from one IP, HTTP/HTTPS public, node traffic inside"
  vpc_id      = data.aws_vpc.default.id

  # SSH and the Kubernetes API: only from your IP.
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "Kubernetes API"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  # The store and dashboard on the public internet.
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # The agent joins the server's API between the two nodes only.
  ingress {
    description = "Kubernetes API between nodes"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    self        = true
  }

  # Flannel VXLAN and kubelet, between the two nodes only.
  ingress {
    description = "Flannel VXLAN"
    from_port   = 8472
    to_port     = 8472
    protocol    = "udp"
    self        = true
  }
  ingress {
    description = "Kubelet"
    from_port   = 10250
    to_port     = 10250
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = var.name }
}

resource "aws_instance" "server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  key_name               = aws_key_pair.k3s.key_name
  vpc_security_group_ids = [aws_security_group.k3s.id]

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  tags = { Name = "${var.name}-server", Role = "server" }
}

resource "aws_instance" "agent" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[1 % length(data.aws_subnets.default.ids)]
  key_name               = aws_key_pair.k3s.key_name
  vpc_security_group_ids = [aws_security_group.k3s.id]

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  tags = { Name = "${var.name}-agent", Role = "agent" }
}

output "server_public_ip" {
  value = aws_instance.server.public_ip
}

output "agent_public_ip" {
  value = aws_instance.agent.public_ip
}

output "ssh_server" {
  value = "ssh -i ~/.ssh/kube-mcp-k3s ubuntu@${aws_instance.server.public_ip}"
}

# Fixed public address for the server, so the hostnames and certificates stay valid
# across stop and start of the instances.
resource "aws_eip" "server" {
  domain   = "vpc"
  instance = aws_instance.server.id
  tags     = { Name = "${var.name}-server" }
}
