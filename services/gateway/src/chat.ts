import { loadLlm, llmStep, type Message, type ToolDef } from "./llm.js";
import type { Identity } from "./identity.js";
import { invokeTool, listExposedTools } from "./tools.js";

const MAX_STEPS = 8;
// Tool output goes back to the model as context. Long JSON results can exceed a
// provider's per-minute token limit (free tiers are often ~8k tokens/minute), so
// the model gets a bounded excerpt. The full result is still returned to the
// caller and written to the audit log.
const MAX_TOOL_RESULT_CHARS = 3000;

export interface ChatResult {
  reply: string;
  toolCalls: { name: string; isError: boolean }[];
}

const SYSTEM =
  "You are an operations assistant for a WooCommerce hosting team. Use the available tools to answer. " +
  "Tool names are prefixed with the server slug. If a tool fails, say so plainly and do not invent data. " +
  "Format answers as Markdown. Put every table row on its own line, with a header separator row.";

// The chat agent is a tool-use loop over the same tools the MCP endpoint
// exposes. It runs as the logged-in user: every tool call goes through
// invokeTool with that user's identity, so the audit log attributes it to them.
export async function runChat(user: Identity, message: string): Promise<ChatResult> {
  const cfg = await loadLlm();
  if (!cfg) throw new Error("No model is configured. An admin can set one under Model in the dashboard.");

  const exposed = await listExposedTools(user, { forChat: true });
  const tools: ToolDef[] = exposed.map((t) => {
    const { $schema: _ignored, ...schema } = (t.inputSchema ?? { type: "object" }) as Record<string, unknown>;
    return { name: t.name, description: t.description ?? "", inputSchema: { type: "object", ...schema } };
  });

  const history: Message[] = [{ role: "user", content: message }];
  const toolCalls: ChatResult["toolCalls"] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llmStep(cfg, SYSTEM, history, tools);
    history.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) {
      return { reply: res.text, toolCalls };
    }
    for (const call of res.toolCalls) {
      const result = await invokeTool({ user, source: "chat" }, call.name, call.args);
      const isError = Boolean(result.isError);
      toolCalls.push({ name: call.name, isError });
      history.push({
        role: "tool",
        toolCallId: call.id,
        isError,
        content: truncate(result.content.map((c) => ("text" in c ? c.text : JSON.stringify(c))).join("\n")),
      });
    }
  }
  return { reply: "Stopped after the maximum number of tool steps.", toolCalls };
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters]`;
}
