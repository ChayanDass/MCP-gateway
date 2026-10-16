# Operations, capacity, and scaling

The current deployment is a compact single-cluster stack intended for local development and small-team evaluation. Dev and prod values run two gateway replicas against the same PostgreSQL Service. The chart configures a gateway PodDisruptionBudget and best-effort spreading across node hostnames when more than one replica is requested. There is no HPA, database replication, or automated backup system. Increasing gateway replicas does not make the full system highly available.

## Current capacity shape

The chart defaults in `charts/*/values.yaml` are starting resource requests and limits, not measured capacity guarantees. The main workloads are:

| Workload | Default replicas | State / dependency | Scaling guidance |
|---|---:|---|---|
| Dashboard | 1 | Static files in the image | Can scale behind its Service; check ingress and browser/API load |
| Gateway | 2 in dev/prod values (chart default 1) | PostgreSQL for durable state and shared rate-limit/OAuth-flow state; upstream connection/health caches remain per process | Can scale for request concurrency with caveats below |
| `woo-mcp` | 1 | WordPress REST API and WooCommerce | Can scale if WordPress, MariaDB, and WooCommerce API throughput support it |
| PostgreSQL | 1 | `ReadWriteOnce` PVC | Do not scale the StatefulSet replicas; use a planned HA database design first |
| WordPress | 1 | Shared files PVC and MariaDB; `Recreate` update strategy | Do not scale this deployment; current file storage and PHP configuration are single-instance |
| MariaDB | 1 | `ReadWriteOnce` PVC | Do not scale the StatefulSet replicas; use a database replication/HA design first |
| ingress-nginx | 1 in the provided stack values | Host port 80/443 and one local node | Kind binds a single node; production ingress capacity depends on node/network design |

Local Kind uses one node and is constrained by the host's available CPU, memory, and disk. The production Terraform creates two small EC2 instances, but the application charts do not enforce placement across them or provide redundant storage. Verify actual node sizes and allocatable capacity before tuning requests.

## What can be scaled now

Dashboard, gateway, and `woo-mcp` have configurable replica values:

```yaml
gateway:
  replicas:
    gateway: 2
    dashboard: 2
mcp:
  replicas:
    wooMcp: 2
```

For local development, apply with Helm and observe the rollout:

```sh
helm upgrade kube-mcp charts/stack -n kube-mcp \
  -f charts/stack/values-dev.yaml \
  --set gateway.replicas.gateway=2 \
  --set gateway.replicas.dashboard=2 \
  --set mcp.replicas.wooMcp=2
kubectl -n kube-mcp get pods -o wide
kubectl -n kube-mcp rollout status deployment/gateway
kubectl -n kube-mcp rollout status deployment/dashboard
kubectl -n kube-mcp rollout status deployment/woo-mcp
```

For production, change the values in Git and let Argo CD apply them. Do not make long-lived production replica changes only with `kubectl scale`; Argo CD self-heal will reconcile back to Git.

### Gateway replica behavior and limits

- Requests are served by the Service across ready pods. Durable identity and configuration are in PostgreSQL, and schema migrations use an advisory lock.
- MCP request counters and failed-login windows are stored in PostgreSQL, so replicas share their limits. This makes rate limiting consistent across replicas, but adds a database operation to requests that enter those limits. The MCP limit defaults to 120 requests per minute per member.
- Upstream OAuth flow state, including the PKCE verifier in encrypted form, is stored briefly in PostgreSQL and consumed once by the callback. OAuth callbacks can therefore reach any gateway replica.
- Upstream health checks and connection caches are per process. Each replica may establish its own upstream connections and perform its own health checks.
- PostgreSQL remains a single point of failure and can become the throughput limit. More gateway pods do not increase database capacity. The default pool allows up to 10 PostgreSQL connections per gateway pod; budget `replicas × databasePoolMax` plus other clients against PostgreSQL's connection limit.
- Before production use, verify session behavior during rolling updates and plan graceful shutdown, disruption budgets, and DB connection limits.

### `woo-mcp` replica caveats

The service handles requests without local durable application state, so multiple pods can serve calls. More pods may increase concurrent requests against the same WooCommerce site. WordPress and MariaDB remain single instances, and can become the bottleneck or hit plugin/API limits first.

### Stateful workloads

PostgreSQL, MariaDB, and WordPress use persistent volumes and run as one replica. A `ReadWriteOnce` volume normally attaches to one node at a time; adding replicas can create scheduling or data-corruption problems. WordPress also uses a `Recreate` strategy because its files are shared through one volume. There is no automated backup/restore system in this repository.

Before operating a non-disposable environment:

1. Choose storage with known durability, capacity, and restore behavior.
2. Back up PostgreSQL, MariaDB, and WordPress uploads/files on a schedule appropriate to the data.
3. Store backups outside the cluster and protect them with encryption and access controls.
4. Test restoring into a separate namespace or cluster; a successful backup job alone does not prove recovery.
5. Keep the gateway encryption key backed up separately and securely. Without it, encrypted upstream credentials in PostgreSQL cannot be decrypted.

## Autoscaling and a growth path

There are no HPAs in the charts. Replica counts are static Helm values; Kubernetes will keep that count but will not automatically scale based on CPU, memory, or request volume. The gateway PDB is created when its configured replica count exceeds one; it protects against some voluntary disruptions, not node or database failure.

For a measured small-team deployment, a practical order is:

1. Collect CPU/memory usage, gateway request rate/latency, upstream error rate, and database saturation. `/metrics` exposes gateway application counters in Prometheus text format inside the cluster.
2. Set resource requests from observed normal and peak usage; set limits with enough headroom for startup and chat/tool bursts. Watch for CPU throttling and memory restarts.
3. Scale dashboard and gateway replicas and confirm database connections, rate-limit behavior, and rolling behavior.
4. Scale `woo-mcp` only after measuring WordPress/MariaDB and upstream limits.
5. Address database backups, restore drills, storage availability, and database failover before treating replica counts as availability.
6. Add HPA only with a metrics source, resource requests, and a strategy for per-replica limits and graceful scale-down. HPA resources are not currently supplied.

For larger or availability-sensitive deployments, consider managed PostgreSQL, managed or replicated MariaDB, shared/replicated WordPress uploads, durable network storage, multiple ingress replicas behind a load balancer, pod topology spread, PodDisruptionBudgets, and a shared rate-limit store. These are design steps, not features enabled by this repository today.

## Operational checks

```sh
kubectl get nodes
kubectl -n kube-mcp get pods -o wide
kubectl -n kube-mcp get pvc
kubectl -n kube-mcp top nodes
kubectl -n kube-mcp top pods
kubectl -n kube-mcp get events --sort-by=.lastTimestamp
kubectl -n kube-mcp logs deployment/gateway --tail=100
kubectl -n kube-mcp logs deployment/woo-mcp --tail=100
kubectl -n kube-mcp logs job/store-setup --tail=100
helm -n kube-mcp status kube-mcp
```

`kubectl top` needs Metrics Server; if it is not installed, use provider/host telemetry instead. The gateway `/metrics` endpoint is not exposed through ingress. Use an in-cluster scraper or a secured port-forward for manual inspection; do not expose it publicly without an authentication/network plan.

## Upgrade and recovery notes

- Local chart upgrade: `helm upgrade kube-mcp charts/stack -n kube-mcp -f charts/stack/values-dev.yaml`.
- Local rollback: inspect `helm -n kube-mcp history kube-mcp`, then `helm -n kube-mcp rollback kube-mcp <revision>`.
- Production: revert the Git commit that changed the chart or image references; Argo CD reconciles the revert.
- Helm history and rollback do not restore PVC contents or reverse database migrations. Take and validate backups before changing database images, schemas, or storage.
- Removing the Kind cluster deletes the local data and generated Secrets stored in it.

See [System design](SYSTEM-DESIGN-AND-TRADEOFFS.md) for state ownership and [Networking](NETWORKING.md) for traffic boundaries.
