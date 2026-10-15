// Creates, watches and removes stores. It runs inside the gateway as a background loop
// that reads the stores table, so it picks up unfinished work after a restart.
// Every step is idempotent: a store can be retried, and a restart mid-way resumes it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { config } from "../config.js";
import { decrypt, encrypt } from "../crypto.js";
import { upstreams } from "../upstreams.js";
import * as k8s from "./k8s.js";
import { storeObjects, type StoreParams } from "./objects.js";

const SETUP_SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "setup.sh"), "utf8");

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  namespace: string;
  url: string;
  status: string;
  started_at: string;
  secrets_enc: string | null;
  owner_email: string;
}

const running = new Set<string>();

export function startProvisioner(): void {
  setInterval(() => {
    void tick().catch((e) => console.error("provisioner:", errorText(e)));
  }, 5000);
}

async function tick(): Promise<void> {
  const { rows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM stores WHERE status IN ('provisioning', 'deleting') ORDER BY created_at`,
  );
  for (const row of rows) {
    if (running.has(row.id)) continue;
    running.add(row.id);
    const work = row.status === "deleting" ? removeStore(row.id) : provisionStore(row.id);
    void work
      .catch((e) => console.error(`provisioner ${row.id}:`, errorText(e)))
      .finally(() => running.delete(row.id));
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadStore(id: string): Promise<StoreRow | null> {
  const { rows } = await pool.query<StoreRow>(
    `SELECT s.id, s.name, s.slug, s.namespace, s.url, s.status, s.started_at, s.secrets_enc, u.email AS owner_email
       FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function setStatus(id: string, status: string, error: string | null): Promise<void> {
  await pool.query(`UPDATE stores SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [id, status, error]);
}

async function setError(id: string, error: string): Promise<void> {
  await pool.query(`UPDATE stores SET error = $2, updated_at = now() WHERE id = $1`, [id, error]);
}

// The store's passwords and WooCommerce key. They are generated once, stored encrypted,
// and reused on every retry, so a retry never changes a password the database already uses.
async function ensureSecrets(row: StoreRow): Promise<StoreParams["secrets"]> {
  if (!row.secrets_enc) {
    const fresh = {
      mariadbRoot: randomBytes(16).toString("hex"),
      mariadbUser: randomBytes(16).toString("hex"),
      wpAdmin: randomBytes(16).toString("hex"),
      wooKey: `ck_${randomBytes(20).toString("hex")}`,
      wooSecret: `cs_${randomBytes(20).toString("hex")}`,
    };
    // Only written if still empty, so two gateway replicas can't overwrite each other.
    await pool.query(`UPDATE stores SET secrets_enc = $2 WHERE id = $1 AND secrets_enc IS NULL`, [row.id, encrypt(JSON.stringify(fresh))]);
  }
  const { rows } = await pool.query<{ secrets_enc: string }>(`SELECT secrets_enc FROM stores WHERE id = $1`, [row.id]);
  return JSON.parse(decrypt(rows[0].secrets_enc));
}

export async function provisionStore(id: string): Promise<void> {
  const row = await loadStore(id);
  if (!row || row.status !== "provisioning") return;
  if (Date.now() - new Date(row.started_at).getTime() > config.storeProvisionTimeoutMs) {
    await setStatus(id, "failed", "Provisioning timed out. Retry to start again.");
    return;
  }
  try {
    const secrets = await ensureSecrets(row);
    const params: StoreParams = {
      slug: row.slug,
      namespace: row.namespace,
      host: new URL(row.url).host,
      url: row.url,
      title: row.name,
      adminEmail: row.owner_email,
      setupScript: SETUP_SCRIPT,
      storageClass: config.storeStorageClass,
      images: config.storeImages,
      tlsIssuer: config.storeTlsIssuer,
      secrets,
    };
    for (const obj of storeObjects(params)) await k8s.apply(obj);

    const state = await storeState(row.namespace);
    if (state.failed) {
      await setStatus(id, "failed", state.failed);
      return;
    }
    if (!state.ready) {
      await setError(id, `Waiting for ${state.waiting}`);
      return;
    }
    await registerServer(row);
    await setStatus(id, "ready", null);
  } catch (e) {
    // Kubernetes or the database was unavailable, or a step failed. The next tick tries
    // again; the timeout above stops it from retrying forever.
    await setError(id, `Retrying: ${errorText(e)}`);
  }
}

// What the store still needs before it's usable.
async function storeState(namespace: string): Promise<{ ready: boolean; waiting: string; failed?: string }> {
  const job = await k8s.get("Job", "store-setup", namespace);
  const failure = job?.status?.conditions?.find((c: { type: string; status: string }) => c.type === "Failed" && c.status === "True");
  if (failure) return { ready: false, waiting: "", failed: `The setup job failed: ${failure.message ?? failure.reason ?? "see its logs"}` };

  const [db, wp, mcp] = await Promise.all([
    k8s.get("StatefulSet", "mariadb", namespace),
    k8s.get("Deployment", "wordpress", namespace),
    k8s.get("Deployment", "woo-mcp", namespace),
  ]);
  const missing: string[] = [];
  if ((db?.status?.readyReplicas ?? 0) < 1) missing.push("the database");
  if ((wp?.status?.readyReplicas ?? 0) < 1) missing.push("WordPress");
  if ((mcp?.status?.readyReplicas ?? 0) < 1) missing.push("the MCP server");
  if ((job?.status?.succeeded ?? 0) < 1) missing.push("the setup job");
  return { ready: missing.length === 0, waiting: missing.join(", ") };
}

// Adds the store's MCP server to the gateway. The name starts with the store's slug,
// so every tool shows which store it acts on (store-acme-x7k2__list_orders).
async function registerServer(row: StoreRow): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO mcp_servers (slug, name, url, auth_header, credential_enc, enabled, is_system, chat_enabled, auth_mode)
     VALUES ($1, $2, $3, NULL, NULL, true, true, true, 'static')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, enabled = true
     RETURNING id`,
    [serverSlug(row), `Store: ${row.name}`, `http://woo-mcp.${row.namespace}.svc.cluster.local:8080/mcp`],
  );
  upstreams.invalidate(rows[0].id);
}

export function serverSlug(row: { slug: string }): string {
  return `store-${row.slug}`;
}

async function removeStore(id: string): Promise<void> {
  const row = await loadStore(id);
  if (!row || row.status !== "deleting") return;
  // Unregister first, so the gateway stops offering the store's tools.
  const { rows } = await pool.query<{ id: string }>(`DELETE FROM mcp_servers WHERE slug = $1 RETURNING id`, [serverSlug(row)]);
  for (const r of rows) upstreams.invalidate(r.id);
  // The namespace holds the database, volumes and secrets, so deleting it removes them all.
  await k8s.remove("Namespace", row.namespace);
  if ((await k8s.get("Namespace", row.namespace)) === null) {
    await pool.query(`DELETE FROM stores WHERE id = $1`, [id]);
  }
}
