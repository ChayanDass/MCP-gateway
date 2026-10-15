// A small Kubernetes API client for the provisioner. It uses the pod's service account
// token and cluster CA, and applies objects with server-side apply, so applying the same
// object twice changes nothing. That is what makes provisioning safe to retry.
import { readFileSync } from "node:fs";
import { request } from "node:https";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [field: string]: unknown;
}

// Only the kinds the provisioner creates.
const KINDS: Record<string, { base: string; plural: string; namespaced: boolean }> = {
  Namespace: { base: "/api/v1", plural: "namespaces", namespaced: false },
  Secret: { base: "/api/v1", plural: "secrets", namespaced: true },
  ConfigMap: { base: "/api/v1", plural: "configmaps", namespaced: true },
  Service: { base: "/api/v1", plural: "services", namespaced: true },
  PersistentVolumeClaim: { base: "/api/v1", plural: "persistentvolumeclaims", namespaced: true },
  ResourceQuota: { base: "/api/v1", plural: "resourcequotas", namespaced: true },
  LimitRange: { base: "/api/v1", plural: "limitranges", namespaced: true },
  Deployment: { base: "/apis/apps/v1", plural: "deployments", namespaced: true },
  StatefulSet: { base: "/apis/apps/v1", plural: "statefulsets", namespaced: true },
  Job: { base: "/apis/batch/v1", plural: "jobs", namespaced: true },
  NetworkPolicy: { base: "/apis/networking.k8s.io/v1", plural: "networkpolicies", namespaced: true },
  Ingress: { base: "/apis/networking.k8s.io/v1", plural: "ingresses", namespaced: true },
};

function pathFor(kind: string, name: string, namespace?: string): string {
  const k = KINDS[kind];
  if (!k) throw new Error(`Kind ${kind} is not supported by the provisioner`);
  if (k.namespaced && !namespace) throw new Error(`${kind} ${name} needs a namespace`);
  const scope = k.namespaced ? `/namespaces/${namespace}` : "";
  return `${k.base}${scope}/${k.plural}/${name}`;
}

function call(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<{ status: number; body: any }> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT ?? 443);
  if (!host) return Promise.reject(new Error("Not running inside a Kubernetes cluster"));
  const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
  const ca = readFileSync(`${SA_DIR}/ca.crt`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        method,
        ca,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(payload ? { "Content-Type": contentType, "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: any = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = { message: data.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Kubernetes API timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Creates or updates an object. The field manager makes it the provisioner's object.
export async function apply(obj: K8sObject): Promise<void> {
  const path = `${pathFor(obj.kind, obj.metadata.name, obj.metadata.namespace)}?fieldManager=kmcp-provisioner&force=true`;
  const r = await call("PATCH", path, obj, "application/apply-patch+yaml");
  if (r.status >= 300) throw new Error(`apply ${obj.kind} ${obj.metadata.name}: ${r.status} ${r.body?.message ?? ""}`);
}

// Returns the object, or null when it does not exist.
export async function get(kind: string, name: string, namespace?: string): Promise<any | null> {
  const r = await call("GET", pathFor(kind, name, namespace));
  if (r.status === 404) return null;
  if (r.status >= 300) throw new Error(`get ${kind} ${name}: ${r.status} ${r.body?.message ?? ""}`);
  return r.body;
}

// Deletes the object. Missing objects are fine: deleting twice is not an error.
export async function remove(kind: string, name: string, namespace?: string): Promise<void> {
  const r = await call("DELETE", pathFor(kind, name, namespace));
  if (r.status === 404) return;
  if (r.status >= 300) throw new Error(`delete ${kind} ${name}: ${r.status} ${r.body?.message ?? ""}`);
}
