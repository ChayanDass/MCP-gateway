import { sha256 } from "./crypto.js";
import { pool } from "./db.js";

interface BucketRow {
  request_count: number;
  retry_after: number;
}

// Store buckets in PostgreSQL so every gateway replica observes the same window.
// Only a one-way hash of the key is persisted (login keys contain client IPs).
export async function takeToken(key: string, limit: number, windowMs = 60_000): Promise<{ ok: boolean; retryAfter: number }> {
  const { rows } = await pool.query<BucketRow>(
    `INSERT INTO rate_limit_buckets AS bucket (bucket_key, request_count, window_started_at)
       VALUES ($1, 1, now())
     ON CONFLICT (bucket_key) DO UPDATE SET
       request_count = CASE
         WHEN bucket.window_started_at <= now() - ($2::double precision * interval '1 millisecond') THEN 1
         ELSE bucket.request_count + 1
       END,
       window_started_at = CASE
         WHEN bucket.window_started_at <= now() - ($2::double precision * interval '1 millisecond') THEN now()
         ELSE bucket.window_started_at
       END
     RETURNING request_count,
       GREATEST(1, ceil(extract(epoch FROM (window_started_at + ($2::double precision * interval '1 millisecond') - now()))))::integer AS retry_after`,
    [sha256(key), windowMs],
  );
  const row = rows[0];
  return { ok: row.request_count <= limit, retryAfter: row.request_count <= limit ? 0 : row.retry_after };
}

export async function isRateLimited(key: string, limit: number, windowMs: number): Promise<boolean> {
  const { rows } = await pool.query<{ blocked: boolean }>(
    `SELECT request_count >= $2 AS blocked
       FROM rate_limit_buckets
      WHERE bucket_key = $1
        AND window_started_at > now() - ($3::double precision * interval '1 millisecond')`,
    [sha256(key), limit, windowMs],
  );
  return rows[0]?.blocked ?? false;
}

export async function clearRateLimit(key: string): Promise<void> {
  await pool.query(`DELETE FROM rate_limit_buckets WHERE bucket_key = $1`, [sha256(key)]);
}

// Prune temporary distributed state. Multiple replicas can safely run cleanup.
export function startSharedStateCleanup(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void Promise.all([
      pool.query(`DELETE FROM rate_limit_buckets WHERE window_started_at < now() - interval '1 hour'`),
      pool.query(`DELETE FROM upstream_oauth_flows WHERE expires_at < now()`),
    ]).catch((error) => console.error("shared state cleanup failed", error));
  }, 10 * 60 * 1000);
  timer.unref();
  return timer;
}
