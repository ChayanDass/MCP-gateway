import { pool } from "./db.js";
import { loadLlm, llmStep, type Message, type ToolDef } from "./llm.js";
import type { Identity } from "./identity.js";
import { invokeTool, listExposedTools } from "./tools.js";

const MAX_STEPS = 8;
const HISTORY_ROWS = 60;
// Tool output goes back to the model as context. Long JSON results can exceed a
// provider's per-minute token limit, so the model gets a bounded excerpt. The full
// excerpt is kept in the saved conversation.
const MAX_TOOL_RESULT_CHARS = 3000;

const SYSTEM =
  "You are an operations assistant for a WooCommerce hosting team. Use the available tools to answer. " +
  "Tool names are prefixed with the server slug. " +
  "When a tool call fails, reason about the cause before doing anything else: " +
  "read the error text, compare the arguments you sent with the tool's input schema, and work out what is missing or wrong. " +
  "Then either retry once or twice with corrected arguments, or stop and tell the user exactly what is missing. " +
  "Do not guess values the user did not give you (for example a price or a product ID); ask for them instead. " +
  "Never invent data. In your reply, say briefly what failed, why, and what you did about it. " +
  "Format answers as Markdown. Put every table row on its own line, with a header separator row.";

// Added to a failed tool result, so the model reasons about the failure rather than
// treating the error text as the answer.
const ERROR_HINT =
  "The tool call failed. Work out why from the error (missing or invalid argument, not found, permission, timeout, or a bad signature), " +
  "correct the arguments and retry, or ask the user for the missing information. Do not report the raw error as the final answer.\n";

export interface ToolCallMeta {
  id: string;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
  outcome: string;
  result: string;
}

export interface ChatResult {
  conversationId: string;
  reply: string;
  model: string;
  toolCalls: ToolCallMeta[];
  createdAt: string;
}

// Starts a conversation for this member, or checks that an existing one is theirs.
export async function ensureConversation(user: Identity, conversationId: string | null, firstMessage: string): Promise<string> {
  if (conversationId) {
    const { rows } = await pool.query(`SELECT 1 FROM chat_conversations WHERE id = $1 AND user_id = $2`, [conversationId, user.id]);
    if (!rows[0]) throw new Error("Conversation not found");
    return conversationId;
  }
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO chat_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
    [user.id, title],
  );
  return rows[0].id;
}

// Rebuilds the model's view of the conversation from the saved rows, including the
// model's own assistant messages (so provider signatures are sent back) and tool results.
async function loadHistory(conversationId: string): Promise<Message[]> {
  const { rows } = await pool.query<{ role: "user" | "assistant"; content: string; meta: Record<string, unknown> }>(
    `SELECT role, content, meta FROM chat_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`,
    [conversationId, HISTORY_ROWS],
  );
  const ordered = rows.reverse();
  // Start at a user message, so a tool exchange is never cut in half.
  const start = ordered.findIndex((r) => r.role === "user");
  const messages: Message[] = [];
  for (const r of ordered.slice(start < 0 ? ordered.length : start)) {
    if (r.role === "user") {
      messages.push({ role: "user", content: r.content });
      continue;
    }
    const meta = r.meta as {
      raw?: Record<string, unknown>;
      toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
      toolResults?: { toolCallId: string; content: string; isError: boolean }[];
    };
    messages.push({
      role: "assistant",
      content: r.content,
      toolCalls: meta.toolCalls?.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      raw: meta.raw,
    });
    for (const t of meta.toolResults ?? []) {
      messages.push({ role: "tool", toolCallId: t.toolCallId, content: t.content, isError: t.isError });
    }
  }
  return messages;
}

async function saveAssistant(conversationId: string, content: string, meta: Record<string, unknown>): Promise<string> {
  const { rows } = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO chat_messages (conversation_id, role, content, meta) VALUES ($1, 'assistant', $2, $3::jsonb) RETURNING id, created_at`,
    [conversationId, content, JSON.stringify(meta)],
  );
  await pool.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  return rows[0].created_at;
}

// The chat agent: a tool-use loop over the tools this member can use. It runs as the
// member, so each call is audited under their name. Every turn is saved.
export async function runChat(user: Identity, conversationId: string | null, message: string): Promise<ChatResult> {
  const cfg = await loadLlm();
  if (!cfg) throw new Error("No model is configured. An admin can set one under Settings → Model.");

  const convId = await ensureConversation(user, conversationId, message);
  const history = await loadHistory(convId);
  await pool.query(`INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, [convId, message]);
  history.push({ role: "user", content: message });

  const exposed = await listExposedTools(user, { forChat: true });
  const tools: ToolDef[] = exposed.map((t) => {
    const { $schema: _ignored, ...schema } = (t.inputSchema ?? { type: "object" }) as Record<string, unknown>;
    return { name: t.name, description: t.description ?? "", inputSchema: { type: "object", ...schema } };
  });

  const allCalls: ToolCallMeta[] = [];
  let createdAt = new Date().toISOString();
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llmStep(cfg, SYSTEM, history, tools);
    history.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls, raw: res.raw });

    const calls: ToolCallMeta[] = [];
    const results: { toolCallId: string; content: string; isError: boolean }[] = [];
    for (const call of res.toolCalls) {
      const started = Date.now();
      const result = await invokeTool({ user, source: "chat" }, call.name, call.args);
      const text = result.content.map((c) => ("text" in c ? c.text : JSON.stringify(c))).join("\n");
      const isError = Boolean(result.isError);
      const outcome = isError ? (/not allowed/i.test(text) ? "denied" : "error") : "ok";
      const modelText = isError ? ERROR_HINT + truncate(text) : truncate(text);
      calls.push({ id: call.id, name: call.name, args: call.args, isError, durationMs: Date.now() - started, outcome, result: text.slice(0, 1200) });
      results.push({ toolCallId: call.id, content: modelText, isError });
      history.push({ role: "tool", toolCallId: call.id, isError, content: modelText });
    }
    allCalls.push(...calls);

    const finished = res.toolCalls.length === 0;
    const reply = finished ? res.text : "";
    createdAt = await saveAssistant(convId, reply, {
      model: cfg.model,
      raw: res.raw,
      toolCalls: calls.map(({ result: _r, ...c }) => c),
      toolResults: results,
      toolPreview: calls.map((c) => ({ name: c.name, args: c.args, outcome: c.outcome, durationMs: c.durationMs, result: c.result })),
    });
    if (finished) return { conversationId: convId, reply, model: cfg.model, toolCalls: allCalls, createdAt };
  }

  const reply = "Stopped after the maximum number of tool steps.";
  createdAt = await saveAssistant(convId, reply, { model: cfg.model, toolCalls: [], toolResults: [] });
  return { conversationId: convId, reply, model: cfg.model, toolCalls: allCalls, createdAt };
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters]`;
}
