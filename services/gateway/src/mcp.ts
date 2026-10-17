import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "./identity.js";
import { invokeTool, listExposedTools } from "./tools.js";
import { searchTools } from "./tool-search.js";
import { config } from "./config.js";

// Meta tools offered instead of the full list when a member has many tools.
const SEARCH_TOOL = "kmcp__search_tools";
const CALL_TOOL = "kmcp__call_tool";
const SERVER_INSTRUCTIONS = [
  "You are connected to kube-mcp, a team MCP gateway. Only tools allowed for the current user are listed or returned by search.",
  "Tool names are prefixed with the upstream server slug and a double underscore, for example woocommerce__list_products or github__search_issues.",
  `If the tools/list response contains ${SEARCH_TOOL} and ${CALL_TOOL}, first call ${SEARCH_TOOL} with a short natural-language query or keywords. Search matches names and descriptions; queries can use different word order.`,
  `Then call ${CALL_TOOL} with the exact returned tool name and the arguments object matching its inputSchema. Example: {"name":"woocommerce__list_products","arguments":{"per_page":10}}.`,
  `If tools/list returns the upstream tools directly, call the desired tool by its exact name instead of using ${CALL_TOOL}.`,
  "Use tools from different server prefixes when a request needs multiple sources. Do not guess arguments that the tool schema or user has not supplied.",
].join(" ");

const DISCOVERY_TOOLS = [
  {
    name: SEARCH_TOOL,
    description: "Search available tools with a short natural-language query or keywords. Results are ranked across tool names and descriptions and include input schemas; use kmcp__call_tool with the returned tool name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short task description or keywords, e.g. 'create GitHub issue' or 'list WooCommerce products'" },
        limit: { type: "number", description: "Maximum number of matches to return (1-50, defaults to 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: CALL_TOOL,
    description: "Call a tool found with kmcp__search_tools. Pass its exact returned name and an arguments object matching its inputSchema.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name returned by kmcp__search_tools" },
        arguments: { type: "object", description: "Arguments matching the selected tool's inputSchema" },
      },
      required: ["name"],
    },
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
    { capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
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
      const query = String(args.query ?? "").trim().slice(0, 300);
      const requestedLimit = Number(args.limit ?? 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 50) : 10;
      const matches = searchTools(await listExposedTools(user), query, limit)
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
