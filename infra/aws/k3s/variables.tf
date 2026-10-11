variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "name" {
  type    = string
  default = "kube-mcp-k3s"
}

# Your public IP, for SSH and the Kubernetes API. Set with -var 'admin_cidr=x.x.x.x/32'.
variable "admin_cidr" {
  type = string
}

variable "public_key_path" {
  type    = string
  default = "~/.ssh/kube-mcp-k3s.pub"
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}
