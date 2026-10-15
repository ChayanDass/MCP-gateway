import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "./identity.js";
import { invokeTool, listExposedTools } from "./tools.js";
import { config } from "./config.js";

// Meta tools offered instead of the full list when a member has many tools.
const SEARCH_TOOL = "kmcp__search_tools";
const CALL_TOOL = "kmcp__call_tool";
const DISCOVERY_TOOLS = [
  {
    name: SEARCH_TOOL,
    description: "Search the tools you can use. Returns matching names, descriptions and input schemas. Call a result with kmcp__call_tool.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: CALL_TOOL,
    description: "Call a tool found with kmcp__search_tools. Pass its name and its arguments.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] },
  },
];

// The gateway's single MCP endpoint. A fresh Server and transport are created
// per HTTP request and hold no session state; the upstream connections live in
// UpstreamManager, which is per process. Any gateway replica can therefore
// serve any request, and a pod restart loses nothing a client depends on.
export async function handleMcpRequest(
  user: Identity,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = new Server(
    { name: "kube-mcp-gateway", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await listExposedTools(user);
    if (tools.length > config.toolDiscoveryThreshold) return { tools: DISCOVERY_TOOLS };
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (request.params.name === SEARCH_TOOL) {
      const q = String(args.query ?? "").trim().toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
      const matches = (await listExposedTools(user))
        .filter((t) => !q || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q))
        .slice(0, limit)
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      return { content: [{ type: "text" as const, text: JSON.stringify(matches, null, 2) }] };
    }
    if (request.params.name === CALL_TOOL) {
      return invokeTool({ user, source: "mcp" }, String(args.name ?? ""), (args.arguments ?? {}) as Record<string, unknown>);
    }
    return invokeTool({ user, source: "mcp" }, request.params.name, args);
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
