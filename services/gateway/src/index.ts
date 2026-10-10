import Fastify from "fastify";
import { config } from "./config.js";
import { hashPassword } from "./crypto.js";
import { migrate, pool } from "./db.js";
import { registerApi, serveDashboard } from "./api.js";
import { upstreams } from "./upstreams.js";

// Startup is idempotent: schema, the first admin and the WooCommerce system
// server are created only when missing, so restarts and Helm upgrades are safe.
async function bootstrap(): Promise<void> {
  await migrate();

  const { rows: admins } = await pool.query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
  if (admins.length === 0) {
    await pool.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)
       ON CONFLICT (email) DO NOTHING`,
      [config.bootstrapAdminEmail.toLowerCase(), await hashPassword(config.bootstrapAdminPassword)],
    );
    console.log(`bootstrapped admin ${config.bootstrapAdminEmail}`);
  }

  // The WooCommerce MCP server is registered first, as a system server.
  await pool.query(
    `INSERT INTO mcp_servers (slug, name, url, enabled, is_system, chat_enabled)
     VALUES ('woocommerce', 'WooCommerce store', $1, true, true, true)
     ON CONFLICT (slug) DO UPDATE SET url = EXCLUDED.url`,
    [config.wooMcpUrl],
  );
}

async function main(): Promise<void> {
  await bootstrap();

  const app = Fastify({ logger: { level: "info" }, bodyLimit: 1024 * 1024, trustProxy: true });
  app.get("/healthz", async () => "ok");
  app.get("/readyz", async () => {
    await pool.query("SELECT 1");
    return "ok";
  });
  // Security headers for every response. The MCP endpoint is hijacked and
  // writes its own headers, so it is not affected.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; script-src 'self' https://accounts.google.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; frame-ancestors 'none'",
    );
    return payload;
  });
  registerApi(app);
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return serveDashboard(req, reply);
  });

  upstreams.start();
  await app.listen({ port: config.port, host: "0.0.0.0" });

  const stop = async () => {
    upstreams.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

main().catch((e) => {
  console.error("gateway failed to start", e);
  process.exit(1);
});
