import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { WooClient, WooError } from "./woo.js";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
};

const woo = new WooClient({
  baseUrl: env("WOO_BASE_URL"),
  homeUrl: env("WOO_HOME_URL"),
  consumerKey: env("WOO_CONSUMER_KEY"),
  consumerSecret: env("WOO_CONSUMER_SECRET"),
  timeoutMs: Number(env("WOO_TIMEOUT_MS", "8000")),
});

const port = Number(env("PORT", "8080"));

const stamp = () => new Date().toISOString();

// Build a fresh McpServer per request. The server holds no session state, so
// any gateway replica can serve any call and the pod can be restarted freely.
function buildServer(): McpServer {
  const server = new McpServer({ name: "woocommerce", version: "0.1.0" });

  // Log each tool call with its arguments, outcome and duration. Wrapping
  // registerTool covers every tool without touching the tool definitions.
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content?: { text?: string }[] }>) =>
    register(name, config, async (args: unknown, extra: unknown) => {
      const started = Date.now();
      const input = JSON.stringify(args);
      try {
        const result = await handler(args, extra);
        const detail = result.isError ? `error="${result.content?.[0]?.text ?? ""}"` : "ok";
        console.log(`${stamp()} tool=${name} ${detail} ${Date.now() - started}ms args=${input}`);
        return result;
      } catch (e) {
        console.log(`${stamp()} tool=${name} threw ${Date.now() - started}ms args=${input} ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    })) as unknown as typeof server.registerTool;

  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });
  const fail = (err: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  });

  server.registerTool(
    "list_products",
    {
      description: "List products in the WooCommerce store. Optionally filter by name with `search`.",
      inputSchema: {
        search: z.string().optional().describe("Substring to match against product names"),
        per_page: z.number().int().min(1).max(100).optional().describe("Max results, default 20"),
      },
    },
    async ({ search, per_page }) => {
      try {
        const products = await woo.listProducts({ search, per_page });
        return ok(products.map((p) => ({ id: p.id, name: p.name, price: p.price, status: p.status, stock: p.stock_status })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_product",
    {
      description: "Create a new published simple product with a name and regular price.",
      inputSchema: {
        name: z.string().min(1).describe("Product name"),
        regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Price as a decimal string, e.g. \"19.99\""),
        description: z.string().optional(),
      },
    },
    async ({ name, regular_price, description }) => {
      try {
        const p = await woo.createProduct({ name, regular_price, description });
        return ok({ id: p.id, name: p.name, price: p.regular_price, status: p.status, permalink: p.permalink });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      description:
        "List orders, newest first. Use `after` (ISO 8601 date-time) to get orders since a point in time, e.g. start of today.",
      inputSchema: {
        status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]).optional(),
        after: z.string().optional().describe("ISO 8601 date-time, e.g. 2026-10-09T00:00:00"),
        per_page: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, after, per_page }) => {
      try {
        const orders = await woo.listOrders({ status, after, per_page });
        return ok(orders.map(summarizeOrder));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Get full details of one order by its numeric ID, including line items.",
      inputSchema: { order_id: z.number().int().positive() },
    },
    async ({ order_id }) => {
      try {
        const o = await woo.getOrder(order_id);
        return ok({ ...summarizeOrder(o), line_items: o.line_items });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_order_status",
    {
      description: "Change the status of an order, e.g. processing, completed, cancelled.",
      inputSchema: {
        order_id: z.number().int().positive(),
        status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]),
      },
    },
    async ({ order_id, status }) => {
      try {
        const o = await woo.updateOrderStatus(order_id, status);
        return ok(summarizeOrder(o));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

function summarizeOrder(o: Awaited<ReturnType<WooClient["getOrder"]>>) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    date: o.date_created,
    total: `${o.total} ${o.currency}`,
    customer: `${o.billing.first_name} ${o.billing.last_name}`.trim(),
    items: o.line_items.map((i) => `${i.quantity} x ${i.name}`),
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get(["/healthz", "/readyz"], (_req: Request, res: Response) => {
  res.type("text/plain").send("ok");
});

// Stateless MCP endpoint: a fresh server and transport per request, so any
// replica can answer and a restart loses no session.
app.all("/mcp", async (req: Request, res: Response) => {
  const started = Date.now();
  const rpc = Array.isArray(req.body) ? "batch" : (req.body?.method ?? "-");
  const tool = rpc === "tools/call" ? req.body.params?.name : undefined;
  console.log(`${stamp()} request ${req.method} rpc=${rpc}${tool ? ` tool=${tool}` : ""} from=${req.ip} agent="${req.get("user-agent") ?? "-"}"`);
  res.on("finish", () => console.log(`${stamp()} response rpc=${rpc} status=${res.statusCode} ${Date.now() - started}ms`));

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Last-resort error handler, so a failed request never leaves a socket hanging.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("mcp request failed", err instanceof WooError ? err.message : err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

app.listen(port, () => console.log(`woo-mcp listening on :${port}/mcp`));
