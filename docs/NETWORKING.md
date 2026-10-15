# Networking, addresses and ingress

This explains how traffic reaches the stack, locally and on AWS: how the servers get their addresses, how the ingress routes requests, and where each name and certificate comes from.

## 1. The short version

- A request from your browser goes to a **public IP** on port 80 or 443.
- On AWS, that IP belongs to the **server EC2 instance** (through an Elastic IP).
- The **ingress controller** runs on that server and reads the request's **hostname** (the `Host` header).
- The ingress picks a **Service** based on the hostname and path, and the Service sends the request to a **pod**.
- Pods talk to each other on **private** addresses inside the cluster. Only the ingress is reachable from the internet.

## 2. What the AWS setup creates

The Terraform code in `infra/aws/k3s` creates:

| Resource | What it is | Why |
|---|---|---|
| Two `t3.small` EC2 instances (Ubuntu 24.04) | `kube-mcp-k3s-server` and `kube-mcp-k3s-agent` | One runs the k3s control plane and most workloads; the other runs workloads |
| A key pair | `kube-mcp-k3s`, your SSH key | Lets you log in to both instances |
| A security group | `kube-mcp-k3s`, the firewall for both instances | Lists which ports are open and to whom |
| An Elastic IP | Attached to the server | A fixed public address for the server |
| Default VPC and subnets | The existing network in `ap-south-1` | No NAT gateway is needed, so it costs less |

Terraform creates them in this order:
1. The key pair and the security group.
2. The two instances, each placed in a subnet of the default VPC. They get **private** addresses from that subnet's range, `172.31.x.x`.
3. The Elastic IP, attached to the server instance.

**What happens when an instance starts:** AWS gives it a private IP from its subnet, and, if it has a public address, a public IP from AWS's pool. The public IP is temporary: it changes when the instance is stopped and started. An Elastic IP is a public IP that you own. It stays the same until you release it, and it follows the instance it is attached to.

## 3. Public IP, Elastic IP and private IP

| Kind | Example here | Who can use it | Changes when | Used for |
|---|---|---|---|---|
| Private IP | `172.31.24.164` (server), `172.31.2.241` (worker) | Only machines inside the VPC | Rarely; it stays with the instance | Nodes talking to each other: API calls and pod traffic |
| Public IP (automatic) | `65.2.83.8` (worker) | The internet | Every stop and start | Reaching the instance from outside. The worker's is not used by anything |
| Elastic IP | `13.200.126.173` (server) | The internet | Only if you release it | The server's fixed address for the browser, the API and SSH |

So the server has two relevant addresses: `13.200.126.173` for outside traffic, and `172.31.24.164` for the worker to reach its API. The worker's address is only used for SSH.

## 4. How the addresses get used

**The Kubernetes API** (port 6443): `kubectl` connects to `https://13.200.126.173:6443`. The k3s certificate lists that address as a valid name. We added it with `tls-san` in `/etc/rancher/k3s/config.yaml`, otherwise `kubectl` would reject the certificate.

**The worker joining the cluster:** the worker connects to `https://172.31.24.164:6443` using the private address and the join token. It doesn't need the public address.

**Pods and services:** inside the cluster, each pod gets an address in the pod network `10.42.0.0/16`, and each Service gets an address in `10.43.0.0/16`. The two nodes are connected by **flannel** (VXLAN, UDP port 8472), which carries pod traffic between them over the private network.

**Ports:** `80` and `443` on the server are the web entry points. The ingress controller listens on them directly (`hostPort`), so no load balancer is needed.

## 5. Request path: browser to pod

Example: you open `https://kube-mcp.13.200.126.173.nip.io/`.

1. **DNS:** your computer asks for `kube-mcp.13.200.126.173.nip.io`. The `nip.io` service answers with `13.200.126.173` (see section 7).
2. **TCP and TLS:** your browser connects to `13.200.126.173:443`. The ingress controller presents the certificate for that hostname, which cert-manager obtained from Let's Encrypt. The TLS handshake uses the name in the request (SNI), so the controller knows which certificate to show.
3. **Ingress routing:** the controller reads the `Host` header and the path, and compares them with the Ingress rules in `charts/ingress`:
   - `kube-mcp.13.200.126.173.nip.io` with `/api`, `/mcp`, `/oauth`, `/.well-known`, `/healthz` goes to the `gateway` Service.
   - The same host with `/` goes to the `dashboard` Service.
   - `store.13.200.126.173.nip.io` with `/` goes to the `wordpress` Service.
   - A request to the bare IP `13.200.126.173` (no hostname) matches the rule with no host, which sends it to the store.
4. **Service to pod:** each Service (`gateway`, `dashboard`, `wordpress`) forwards to its pods on a private pod address.
5. **Response:** the reply goes back the same way, encrypted by the ingress.

**MCP client path:** a client calls `https://kube-mcp.13.200.126.173.nip.io/mcp` with its Bearer key. The gateway checks the key, then calls the upstream server it needs. For WooCommerce, the gateway sends the call to `woo-mcp` on the private network, `woo-mcp` calls WordPress's REST API over plain HTTP inside the cluster, and WordPress reads the data from MariaDB.

**Why internal calls use plain HTTP:** TLS ends at the ingress. Traffic between pods is on the private network, and the NetworkPolicies limit who can reach each pod. WooCommerce then checks the request signature against the scheme it sees, which is `http`, so `woo-mcp` signs with an `http://` address (see `charts/stack/values-prod.yaml`).

## 6. Certificates: how HTTPS works

**Hostnames (Let's Encrypt):**
1. The Ingress for a hostname has a `tls` section, and a `cert-manager.io/cluster-issuer: letsencrypt-prod` annotation.
2. cert-manager sees the Ingress and asks Let's Encrypt for a certificate for that hostname.
3. Let's Encrypt checks that you control the hostname. It makes an HTTP request to `http://<hostname>/.well-known/acme-challenge/...` on port 80. The ingress serves that challenge, which is why port 80 must be open to the internet.
4. The certificate is saved in a Kubernetes Secret (`store-tls`, `dashboard-tls`), and the ingress uses it.
5. cert-manager renews the certificate before it expires, so renewal is automatic.

**The bare IP (self-signed):** Let's Encrypt won't sign a certificate for a bare IP in this setup, so the bootstrap script creates a self-signed certificate for `13.200.126.173` and stores it as the Secret `ip-tls`. The ingress controller uses it as its default certificate (`--default-ssl-certificate`). Browsers show a warning, because nothing vouches for the certificate. The connection is still encrypted.

## 7. What nip.io is, and why we use it

`nip.io` is a public DNS service. Any name that ends in `.<an IP address>.nip.io` resolves to that IP. For example:
- `store.13.200.126.173.nip.io` → `13.200.126.173`
- `kube-mcp.13.200.126.173.nip.io` → `13.200.126.173`

**Why it helps:** it gives us real hostnames, so the ingress can route by name and Let's Encrypt can issue certificates, without buying a domain.

**Limits to know about:**
- **Shared domain:** `nip.io` is used by many people. Let's Encrypt limits how many certificates a registered domain can receive in a week, so the limit is shared. If it's reached, new certificates wait until the limit resets.
- **Google sign-in:** the OAuth client must list the exact origin, and Google's rules for domains that aren't yours are strict. Treat a `nip.io` origin as temporary, and check that Google accepts it. Your own domain is the reliable option.
- **The IP is part of the name:** if the Elastic IP changes, every hostname and certificate must change too. That's why the Elastic IP is important.

**To move to your own domain:**
1. Point DNS records (`store.example.com`, `kube-mcp.example.com`) at `13.200.126.173`.
2. Change the hostnames in `charts/stack/values-prod.yaml`: the store and dashboard hosts, `siteUrl`, `publicBaseUrl` and the `mcp.store.siteUrl`.
3. Commit and push. Argo CD rolls it out, and cert-manager issues new certificates for the new names.
4. Update the Google OAuth origins and the provider callback URLs (GitHub, Slack) to the new names.

## 8. Firewall: what is open and to whom

Security group `kube-mcp-k3s`:

| Port | Protocol | Open to | Why |
|---|---|---|---|
| 22 | TCP | Your IP only | SSH to the instances |
| 6443 | TCP | Your IP, and the other node | The Kubernetes API (`kubectl`), and the worker joining |
| 80 | TCP | Everyone | The store and dashboard over HTTP (they redirect to HTTPS), and Let's Encrypt's checks |
| 443 | TCP | Everyone | The store and dashboard over HTTPS |
| 8472 | UDP | The other node | Flannel VXLAN, pod traffic between nodes |
| 10250 | TCP | The other node | The kubelet, used by the control plane |

Outbound traffic is open, because the pods pull images and call external services (GitHub, Slack, Google, Let's Encrypt).

**Your IP:** the restriction uses the IP you had when you applied Terraform (`admin_cidr`). If your IP changes, you lose SSH and `kubectl`. Fix it by updating `admin_cidr` and applying again.

## 9. Traffic inside the cluster: NetworkPolicies

By default Kubernetes lets any pod talk to any other pod. We restrict it with NetworkPolicies:

| Target | Allowed from |
|---|---|
| gateway | The ingress controller and the dashboard |
| dashboard | The ingress controller only; it makes no outbound calls |
| woo-mcp | The gateway only |
| gateway Postgres | The gateway only |
| WordPress | The ingress controller and woo-mcp |
| MariaDB | WordPress and the setup job only |

This means a compromised dashboard can't reach the database, and a member's request can't reach WordPress or the WooCommerce key directly.

## 10. Local (Kind) versus AWS

| | Local (Kind) | AWS (k3s) |
|---|---|---|
| Where the cluster runs | Docker containers on your machine | Two EC2 instances |
| Public address | None. `127.0.0.1` on your machine | Elastic IP `13.200.126.173` |
| How the name resolves | `*.localtest.me` → `127.0.0.1` (public DNS, no changes needed) | `*.13.200.126.173.nip.io` → `13.200.126.173` |
| How the ingress is reached | Docker maps host port 80 to the cluster | The controller listens on the server's ports 80 and 443 |
| TLS | Plain HTTP | HTTPS: Let's Encrypt for names, self-signed for the bare IP |
| Ingress admission webhook | Off (it failed on Kind) | Off (same reason). Re-enable once it is fixed |
| Storage class | `standard` (Kind) | `local-path` (k3s) |
| Node count | One | Two |
| Who can reach it | Only your machine | The internet on ports 80 and 443; SSH and API only from your IP |
| Store and dashboard addresses | `http://store.localtest.me`, `http://localhost` | `https://store.13.200.126.173.nip.io`, `https://kube-mcp.13.200.126.173.nip.io` |

**What changes between them:** only the values files. `values-dev.yaml` holds the local settings, and `values-prod.yaml` holds the AWS settings. The charts and templates are the same. This is why the same Helm charts work in both places.

## 11. How the pieces are wired (quick reference)

| Thing | Where it is set |
|---|---|
| Public address and hostnames | `charts/stack/values-prod.yaml` (`ingress`, `store.siteUrl`, `gateway.publicBaseUrl`, `mcp.store.siteUrl`) |
| Ingress rules | `charts/ingress/templates/store.yaml` and `dashboard.yaml` |
| TLS per hostname | The `tls` section of each Ingress, set by `ingress.tls` in values |
| The bare-IP certificate | Secret `ip-tls`, created by `scripts/bootstrap.sh`; set as default cert in `charts/stack/values-prod.yaml` |
| Let's Encrypt issuer | `gitops/platform/cluster-issuer.yaml` |
| Controller on ports 80 and 443 | `hostPort` in the ingress-nginx values in `charts/stack/values.yaml`, plus the `ingress-ready=true` node label |
| Firewall | `infra/aws/k3s/main.tf` (security group) |
| Elastic IP | `infra/aws/k3s/main.tf` (`aws_eip`) |
| k3s API certificate names | `/etc/rancher/k3s/config.yaml` on the server (`tls-san`) |
| Pod and service networks | k3s defaults: pods `10.42.0.0/16`, services `10.43.0.0/16` |

## 12. Checking it yourself

```sh
# The public address of the server (should be the Elastic IP)
aws ec2 describe-addresses --region ap-south-1 --query 'Addresses[].PublicIp' --output text

# What a hostname resolves to (nip.io answers with the IP in the name)
getent hosts store.13.200.126.173.nip.io

# The certificate the server presents, and who issued it
echo | openssl s_client -connect 13.200.126.173:443 -servername store.13.200.126.173.nip.io 2>/dev/null | openssl x509 -noout -issuer -subject

# The ingress rules and their hosts
kubectl -n kube-mcp get ingress

# Which node the ingress controller runs on (it must be the server)
kubectl -n kube-mcp get pods -o wide | grep ingress
```

## 13. Common questions

**Why does the worker have a public IP that changes?** It doesn't need a fixed one. Only the server is reached from outside, through the Elastic IP.

**Can I use the worker's IP for the site?** No. The ingress runs on the server, so only the server's address serves the sites.

**What happens if the server is stopped and started?** The Elastic IP stays attached, so the hostnames still work. If it were a plain public IP, every hostname and certificate would have to change.

**Why are there two certificates?** One for each hostname, from Let's Encrypt. The bare IP has its own self-signed one, because Let's Encrypt doesn't sign bare IP addresses here.

**Why is port 6443 open at all?** `kubectl` and the worker need it. It is open only to your IP and to the other node.

**Why plain HTTP between the pods?** TLS ends at the ingress. Pod-to-pod traffic stays on the private network and is limited by NetworkPolicies.
