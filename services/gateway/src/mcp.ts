import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "./identity.js";
import { invokeTool, listExposedTools } from "./tools.js";

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
    return invokeTool({ user, source: "mcp" }, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
