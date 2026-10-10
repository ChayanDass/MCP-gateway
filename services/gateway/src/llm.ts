import { decrypt } from "./crypto.js";
import { pool } from "./db.js";

// Provider settings for the chat agent. One row, set from the dashboard by an
// admin. Two wire protocols cover the common providers:
//  - "openai": POST {baseUrl}/chat/completions. Groq, Google Gemini (OpenAI
//    compatibility endpoint), OpenRouter, Ollama, OpenAI and most others.
//  - "anthropic": Anthropic's native Messages API.
export type LlmProvider = "openai" | "anthropic";

export interface LlmSettings {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  // The model's own assistant message. Some providers (Gemini 3) attach a thought
  // signature to tool calls and reject the next request if it is not sent back.
  raw?: Record<string, unknown>;
}

// Chat history in the OpenAI shape. The Anthropic path converts it on the way out.
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: Record<string, unknown> }
  | { role: "tool"; toolCallId: string; content: string; isError: boolean };

const CALL_TIMEOUT_MS = 60_000;

export async function loadLlm(): Promise<LlmSettings | null> {
  const { rows } = await pool.query<{ provider: LlmProvider; base_url: string; model: string; api_key_enc: string | null }>(
    `SELECT provider, base_url, model, api_key_enc FROM llm_settings WHERE id = 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    provider: r.provider,
    baseUrl: r.base_url,
    model: r.model,
    apiKey: r.api_key_enc ? decrypt(r.api_key_enc) : null,
  };
}

// One model call. Returns text and any tool calls the model asked for.
export async function llmStep(cfg: LlmSettings, system: string, messages: Message[], tools: ToolDef[]): Promise<StepResult> {
  return cfg.provider === "anthropic"
    ? anthropicStep(cfg, system, messages, tools)
    : openaiStep(cfg, system, messages, tools);
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Model provider returned ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function openaiStep(cfg: LlmSettings, system: string, messages: Message[], tools: ToolDef[]): Promise<StepResult> {
  const msgs: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") {
      msgs.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant" && m.raw) {
      // Send back exactly what the model returned, so provider-specific fields survive.
      msgs.push(m.raw);
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      msgs.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  const body: Record<string, unknown> = { model: cfg.model, messages: msgs, max_tokens: 1024 };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  const headers: Record<string, string> = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  const data = await post(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, headers, body);
  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
    id: c.id || `call_${i}`,
    name: c.function?.name,
    args: safeJson(c.function?.arguments),
  }));
  return { text: (msg.content ?? "").trim(), toolCalls, raw: { role: "assistant", ...msg } };
}

async function anthropicStep(cfg: LlmSettings, system: string, messages: Message[], tools: ToolDef[]): Promise<StepResult> {
  const msgs: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError }],
      });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      msgs.push({ role: "assistant", content: blocks.length ? blocks : m.content });
    } else if (m.role === "user") {
      msgs.push({ role: "user", content: m.content });
    }
  }
  const body: Record<string, unknown> = { model: cfg.model, max_tokens: 1024, system, messages: msgs };
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  const data = await post(`${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": "2023-06-01",
  }, body);
  const blocks: any[] = data.content ?? [];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
    toolCalls: blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> })),
  };
}

function safeJson(s: unknown): Record<string, unknown> {
  try {
    return typeof s === "string" ? JSON.parse(s || "{}") : ((s as Record<string, unknown>) ?? {});
  } catch {
    return {};
  }
}
