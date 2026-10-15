// The Kubernetes objects for one store. Every store gets its own namespace, so its
// database, secrets, volumes and network rules are separate from every other store.
// Deleting the namespace removes all of it.
import type { K8sObject } from "./k8s.js";

export interface StoreParams {
  slug: string; // the store's short name, e.g. "acme-x7k2"
  namespace: string; // store-<slug>
  host: string; // the public host for the store's ingress
  url: string; // the public address, used by WordPress and WooCommerce
  title: string;
  adminEmail: string;
  setupScript: string;
  storageClass: string;
  images: { wordpress: string; mariadb: string; wpCli: string; wooMcp: string };
  tlsIssuer: string; // empty when the cluster serves plain HTTP
  secrets: { mariadbRoot: string; mariadbUser: string; wpAdmin: string; wooKey: string; wooSecret: string };
}

const LABELS = (slug: string) => ({ "app.kubernetes.io/part-of": "woocommerce-store", "kmcp.io/store": slug });
const COMPONENT = (name: string) => ({ "app.kubernetes.io/name": name, "app.kubernetes.io/part-of": "woocommerce-store" });
const PRIVILEGE_OFF = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };

export function storeObjects(p: StoreParams): K8sObject[] {
  const ns = p.namespace;
  const dns = { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } };
  const dbEnv = [
    { name: "WORDPRESS_DB_HOST", value: "mariadb:3306" },
    { name: "WORDPRESS_DB_NAME", value: "wordpress" },
    { name: "WORDPRESS_DB_USER", value: "wordpress" },
    { name: "WORDPRESS_DB_PASSWORD", valueFrom: { secretKeyRef: { name: "store-secrets", key: "mariadb-password" } } },
  ];

  return [
    // Guardrails: the namespace can't take more than its share of the cluster.
    { apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels: { ...LABELS(p.slug), "kmcp.io/managed": "true" } } },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "store-quota", namespace: ns, labels: LABELS(p.slug) },
      spec: {
        hard: {
          "requests.cpu": "1500m",
          "requests.memory": "1536Mi",
          "limits.cpu": "3",
          "limits.memory": "2560Mi",
          pods: "12",
          persistentvolumeclaims: "3",
          "requests.storage": "12Gi",
          services: "6",
          secrets: "10",
          configmaps: "10",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "store-limits", namespace: ns, labels: LABELS(p.slug) },
      spec: {
        limits: [
          {
            type: "Container",
            max: { cpu: "1", memory: "1Gi" },
            default: { cpu: "500m", memory: "512Mi" },
            defaultRequest: { cpu: "50m", memory: "64Mi" },
          },
        ],
      },
    },

    // Secrets. The values are generated once and kept encrypted by the provisioner.
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "store-secrets", namespace: ns, labels: LABELS(p.slug) },
      type: "Opaque",
      stringData: {
        "mariadb-root-password": p.secrets.mariadbRoot,
        "mariadb-password": p.secrets.mariadbUser,
        "wp-admin-password": p.secrets.wpAdmin,
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "woo-mcp-credentials", namespace: ns, labels: LABELS(p.slug) },
      type: "Opaque",
      stringData: { "consumer-key": p.secrets.wooKey, "consumer-secret": p.secrets.wooSecret },
    },

    // Network isolation: nothing reaches this namespace unless a rule below allows it.
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "default-deny-ingress", namespace: ns }, spec: { podSelector: {}, policyTypes: ["Ingress"] } },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "mariadb-from-store-only", namespace: ns },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/name": "mariadb" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wordpress" } } }, { podSelector: { matchLabels: { "app.kubernetes.io/name": "setup" } } }], ports: [{ port: 3306 }] }],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "wordpress-from-ingress-and-woo-mcp", namespace: ns },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/name": "wordpress" } },
        policyTypes: ["Ingress"],
        ingress: [
          { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } }, podSelector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx" } } }], ports: [{ port: 80 }] },
          { from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "woo-mcp" } } }], ports: [{ port: 80 }] },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "woo-mcp-from-gateway", namespace: ns },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/name": "woo-mcp" } },
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "gateway" } }, podSelector: { matchLabels: { "app.kubernetes.io/name": "gateway" } } }], ports: [{ port: 8080 }] }],
        egress: [
          { to: [dns], ports: [{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }] },
          { to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wordpress" } } }], ports: [{ port: 80 }] },
        ],
      },
    },

    // Database.
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "mariadb", namespace: ns, labels: COMPONENT("mariadb") },
      spec: { selector: { "app.kubernetes.io/name": "mariadb" }, ports: [{ name: "mysql", port: 3306, targetPort: "mysql" }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name: "mariadb", namespace: ns, labels: COMPONENT("mariadb") },
      spec: {
        serviceName: "mariadb",
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "mariadb" } },
        template: {
          metadata: { labels: COMPONENT("mariadb") },
          spec: {
            containers: [
              {
                name: "mariadb",
                image: p.images.mariadb,
                ports: [{ name: "mysql", containerPort: 3306 }],
                env: [
                  { name: "MARIADB_ROOT_PASSWORD", valueFrom: { secretKeyRef: { name: "store-secrets", key: "mariadb-root-password" } } },
                  { name: "MARIADB_DATABASE", value: "wordpress" },
                  { name: "MARIADB_USER", value: "wordpress" },
                  { name: "MARIADB_PASSWORD", valueFrom: { secretKeyRef: { name: "store-secrets", key: "mariadb-password" } } },
                ],
                args: ["--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci"],
                readinessProbe: { exec: { command: ["sh", "-c", 'mariadb-admin ping -h127.0.0.1 -uroot -p"$MARIADB_ROOT_PASSWORD" --silent'] }, initialDelaySeconds: 10, periodSeconds: 5 },
                livenessProbe: { exec: { command: ["sh", "-c", 'mariadb-admin ping -h127.0.0.1 -uroot -p"$MARIADB_ROOT_PASSWORD" --silent'] }, initialDelaySeconds: 60, periodSeconds: 15 },
                resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "768Mi" } },
                volumeMounts: [{ name: "data", mountPath: "/var/lib/mysql" }],
              },
            ],
          },
        },
        volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: p.storageClass, resources: { requests: { storage: "5Gi" } } } }],
      },
    },

    // WordPress.
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "wordpress-html", namespace: ns, labels: COMPONENT("wordpress") }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: p.storageClass, resources: { requests: { storage: "5Gi" } } } },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "wordpress", namespace: ns, labels: COMPONENT("wordpress") },
      spec: { selector: { "app.kubernetes.io/name": "wordpress" }, ports: [{ name: "http", port: 80, targetPort: "http" }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "wordpress", namespace: ns, labels: COMPONENT("wordpress") },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { "app.kubernetes.io/name": "wordpress" } },
        template: {
          metadata: { labels: COMPONENT("wordpress") },
          spec: {
            securityContext: { fsGroup: 33 },
            containers: [
              {
                name: "wordpress",
                image: p.images.wordpress,
                ports: [{ name: "http", containerPort: 80 }],
                env: [
                  ...dbEnv,
                  { name: "WORDPRESS_CONFIG_EXTRA", value: `define('WP_HOME', '${p.url}');\ndefine('WP_SITEURL', '${p.url}');\nif (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }` },
                ],
                readinessProbe: { httpGet: { path: "/wp-login.php", port: "http" }, initialDelaySeconds: 20, periodSeconds: 10, failureThreshold: 12 },
                livenessProbe: { httpGet: { path: "/wp-login.php", port: "http" }, initialDelaySeconds: 90, periodSeconds: 20, failureThreshold: 5 },
                resources: { requests: { cpu: "250m", memory: "384Mi" }, limits: { cpu: "1", memory: "768Mi" } },
                volumeMounts: [{ name: "html", mountPath: "/var/www/html" }],
              },
            ],
            volumes: [{ name: "html", persistentVolumeClaim: { claimName: "wordpress-html" } }],
          },
        },
      },
    },

    // One-time setup: installs WordPress and WooCommerce and registers the WooCommerce key.
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "store-setup-script", namespace: ns, labels: LABELS(p.slug) }, data: { "setup.sh": p.setupScript } },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "store-setup", namespace: ns, labels: COMPONENT("setup") },
      spec: {
        backoffLimit: 5,
        template: {
          metadata: { labels: COMPONENT("setup") },
          spec: {
            restartPolicy: "Never",
            securityContext: { runAsUser: 33, runAsGroup: 33, fsGroup: 33 },
            containers: [
              {
                name: "setup",
                image: p.images.wpCli,
                command: ["sh", "/scripts/setup.sh"],
                env: [
                  ...dbEnv,
                  { name: "WOO_CONSUMER_KEY", valueFrom: { secretKeyRef: { name: "woo-mcp-credentials", key: "consumer-key" } } },
                  { name: "WOO_CONSUMER_SECRET", valueFrom: { secretKeyRef: { name: "woo-mcp-credentials", key: "consumer-secret" } } },
                  { name: "WP_ADMIN_PASSWORD", valueFrom: { secretKeyRef: { name: "store-secrets", key: "wp-admin-password" } } },
                  { name: "SITE_URL", value: p.url },
                  { name: "STORE_TITLE", value: p.title },
                  { name: "STORE_ADMIN_EMAIL", value: p.adminEmail },
                  { name: "HOME", value: "/tmp" },
                  { name: "WP_CLI_CACHE_DIR", value: "/tmp/wp-cli-cache" },
                ],
                resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
                volumeMounts: [
                  { name: "html", mountPath: "/var/www/html" },
                  { name: "script", mountPath: "/scripts" },
                ],
              },
            ],
            volumes: [
              { name: "html", persistentVolumeClaim: { claimName: "wordpress-html" } },
              { name: "script", configMap: { name: "store-setup-script" } },
            ],
          },
        },
      },
    },

    // The store's own MCP server. The gateway is the only caller.
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "woo-mcp", namespace: ns, labels: COMPONENT("woo-mcp") },
      spec: {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "woo-mcp" } },
        template: {
          metadata: { labels: COMPONENT("woo-mcp") },
          spec: {
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
            containers: [
              {
                name: "woo-mcp",
                image: p.images.wooMcp,
                imagePullPolicy: "IfNotPresent",
                ports: [{ name: "http", containerPort: 8080 }],
                env: [
                  { name: "PORT", value: "8080" },
                  { name: "WOO_BASE_URL", value: `http://wordpress.${ns}.svc.cluster.local/wp-json/wc/v3` },
                  { name: "WOO_HOME_URL", value: p.url },
                  { name: "WOO_CONSUMER_KEY", valueFrom: { secretKeyRef: { name: "woo-mcp-credentials", key: "consumer-key" } } },
                  { name: "WOO_CONSUMER_SECRET", valueFrom: { secretKeyRef: { name: "woo-mcp-credentials", key: "consumer-secret" } } },
                ],
                readinessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 3, periodSeconds: 10 },
                livenessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 10, periodSeconds: 20 },
                resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "300m", memory: "192Mi" } },
                securityContext: PRIVILEGE_OFF,
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "woo-mcp", namespace: ns, labels: COMPONENT("woo-mcp") },
      spec: { selector: { "app.kubernetes.io/name": "woo-mcp" }, ports: [{ name: "http", port: 8080, targetPort: "http" }] },
    },

    // The public address of the store.
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: "store",
        namespace: ns,
        labels: LABELS(p.slug),
        ...(p.tlsIssuer ? { annotations: { "cert-manager.io/cluster-issuer": p.tlsIssuer } } : {}),
      },
      spec: {
        ingressClassName: "nginx",
        ...(p.tlsIssuer ? { tls: [{ hosts: [p.host], secretName: `${p.slug}-tls` }] } : {}),
        rules: [{ host: p.host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "wordpress", port: { name: "http" } } } }] } }],
      },
    },
  ];
}
