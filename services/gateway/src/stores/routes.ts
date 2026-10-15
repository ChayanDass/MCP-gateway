// API for stores: list, create, retry and delete. The work itself happens in the
// provisioner, so these calls return at once with the store's status.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { currentUser } from "../api.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import * as k8s from "./k8s.js";

export function registerStoreRoutes(app: FastifyInstance): void {
  app.get("/api/stores", async (req, reply) => {
    if (!(await currentUser(req, reply, "stores.manage"))) return;
    const { rows } = await pool.query(`SELECT id, name, slug, status, error, url, created_at FROM stores ORDER BY created_at DESC`);
    return rows;
  });

  app.post<{ Body: { name?: string } }>("/api/stores", async (req, reply) => {
    const user = await currentUser(req, reply, "stores.manage");
    if (!user) return;
    const name = (req.body?.name ?? "").trim();
    if (name.length < 2 || name.length > 40) return reply.code(400).send({ error: "A store name needs 2 to 40 characters" });

    const { rows: count } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM stores WHERE owner_id = $1`, [user.id]);
    if (count[0].n >= config.maxStoresPerUser) return reply.code(409).send({ error: `You can have at most ${config.maxStoresPerUser} stores` });

    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = makeSlug(name);
      const url = `${config.storeScheme}://${slug}.${config.storeBaseDomain}`;
      try {
        const { rows } = await pool.query(
          `INSERT INTO stores (owner_id, name, slug, namespace, status, url)
           VALUES ($1, $2, $3, $4, 'provisioning', $5)
           RETURNING id, name, slug, status, error, url, created_at`,
          [user.id, name, slug, `store-${slug}`, url],
        );
        return reply.code(201).send(rows[0]);
      } catch (e) {
        if ((e as { code?: string }).code !== "23505") throw e; // slug taken: try another suffix
      }
    }
    return reply.code(409).send({ error: "Could not pick a free address. Try again." });
  });

  // Retrying a failed store is safe: the setup job is recreated and the rest is re-applied.
  app.post<{ Params: { id: string } }>("/api/stores/:id/retry", async (req, reply) => {
    if (!(await currentUser(req, reply, "stores.manage"))) return;
    const { rows } = await pool.query<{ namespace: string; status: string }>(`SELECT namespace, status FROM stores WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "Store not found" });
    if (rows[0].status !== "failed") return reply.code(409).send({ error: "Only a failed store can be retried" });
    await k8s.remove("Job", "store-setup", rows[0].namespace);
    await pool.query(`UPDATE stores SET status = 'provisioning', error = NULL, started_at = now(), updated_at = now() WHERE id = $1`, [req.params.id]);
    return reply.code(202).send({ ok: true });
  });

  // Deleting marks the store; the provisioner removes its namespace and registration.
  app.delete<{ Params: { id: string } }>("/api/stores/:id", async (req, reply) => {
    if (!(await currentUser(req, reply, "stores.manage"))) return;
    const { rowCount } = await pool.query(`UPDATE stores SET status = 'deleting', error = NULL, updated_at = now() WHERE id = $1 AND status <> 'deleting'`, [req.params.id]);
    if (!rowCount) {
      const { rows } = await pool.query(`SELECT 1 FROM stores WHERE id = $1`, [req.params.id]);
      return rows.length ? reply.code(202).send({ ok: true }) : reply.code(404).send({ error: "Store not found" });
    }
    return reply.code(202).send({ ok: true });
  });
}

function makeSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "") || "store";
  return `${base}-${randomBytes(2).toString("hex")}`;
}
