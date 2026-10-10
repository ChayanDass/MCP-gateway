import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import { navigate } from "./router";
import { Modal } from "./Modal";

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  outcome: "ok" | "error" | "denied" | string;
  durationMs: number;
  result: string;
}

interface Message {
  id: string | number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  model: string | null;
  toolCalls: ToolCall[];
  pending?: boolean;
}

interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
  message_count: string;
}

// The last open conversation and unsent drafts are kept in this browser, so a reload
// brings back the same chat with what was being typed.
const LAST_KEY = "kmcp.chat.last";
const draftKey = (id: string | null) => `kmcp.chat.draft.${id ?? "new"}`;
function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the page still works without it */
  }
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const STARTERS = ["What orders came in today?", "List the products in the store", "Which orders are still open?"];

// Chat with saved conversations. The list on the left is the member's own history.
export function ChatPage({ id }: { id: string | null }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState("New chat");
  const [input, setInput] = useState(() => read(draftKey(id)) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const loadList = useCallback(() => {
    api<ConversationSummary[]>("GET", "/api/chat/conversations").then(setConversations).catch(() => undefined);
  }, []);

  const loadOne = useCallback((convId: string) => {
    api<{ title: string; messages: Message[] }>("GET", `/api/chat/conversations/${convId}`)
      .then((c) => {
        setTitle(c.title);
        setMessages(c.messages);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Reload: with no chat open, go back to the last one the member had open.
  useEffect(() => {
    const last = read(LAST_KEY);
    if (!id && last) navigate(`chat/${last}`);
  }, []);

  useEffect(() => {
    setError(null);
    setInput(read(draftKey(id)) ?? "");
    if (id) {
      store(LAST_KEY, id);
      loadOne(id);
    } else {
      setMessages([]);
      setTitle("New chat");
    }
  }, [id, loadOne]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  // Sends one message. With no conversation open, a new one is created.
  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    store(draftKey(id), null);
    setError(null);
    setBusy(true);
    const optimistic: Message = { id: `tmp-${Date.now()}`, role: "user", content: message, createdAt: new Date().toISOString(), model: null, toolCalls: [] };
    setMessages((m) => [...m, optimistic]);
    try {
      const res = id
        ? await api<{ conversationId: string }>("POST", `/api/chat/conversations/${id}/messages`, { message })
        : await api<{ conversationId: string }>("POST", "/api/chat", { message });
      loadList();
      if (!id) navigate(`chat/${res.conversationId}`);
      else loadOne(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
      if (id) loadOne(id);
    } finally {
      setBusy(false);
    }
  }

  // New chat is an explicit choice, so the reload memory of the last chat is cleared.
  async function newChat() {
    store(LAST_KEY, null);
    navigate("chat");
  }

  async function remove(convId: string) {
    if (!window.confirm("Delete this conversation? It cannot be recovered.")) return;
    await api("DELETE", `/api/chat/conversations/${convId}`).catch(() => undefined);
    loadList();
    if (convId === id) {
      store(LAST_KEY, null);
      navigate("chat");
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  const empty = messages.length === 0 && !busy;

  return (
    <div className="chat-shell">
      <section className="chat-main">
        <header className="chat-head">
          <div className="chat-title">
            <strong>{id ? title : "New chat"}</strong>
            {id && <span className="muted small">Saved to your history</span>}
          </div>
          <div className="row">
            <button onClick={() => setHistoryOpen(true)}>History</button>
            <button className="primary" onClick={newChat}>
              New chat
            </button>
          </div>
        </header>

        <div className="chat-scroll">
          {empty && (
            <div className="chat-empty">
              <div className="chat-empty-mark">✦</div>
              <h3>How can I help?</h3>
              <p className="muted small">Ask in plain language. The agent uses only the tools your account can use, and every call is logged.</p>
              <div className="chips">
                {STARTERS.map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <MessageRow key={m.id} m={m} />
          ))}

          {busy && (
            <div className="msg assistant">
              <div className="msg-avatar assistant">AI</div>
              <div className="msg-body typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {error && <p className="status-line err">{error}</p>}
          <div ref={endRef} />
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={taRef}
            value={input}
            rows={1}
            placeholder="Message the agent. Enter to send, Shift+Enter for a new line."
            onChange={(e) => {
              setInput(e.target.value);
              store(draftKey(id), e.target.value || null);
              grow();
            }}
            onKeyDown={onKey}
            disabled={busy}
            aria-label="Message"
          />
          <button type="submit" className="primary send" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </section>

      {historyOpen && (
        <Modal title="Chat history" subtitle="Your saved conversations. Open one to continue it." onClose={() => setHistoryOpen(false)} wide>
          <div className="history-list">
            {conversations.map((c) => (
              <div key={c.id} className={`history-item ${c.id === id ? "on" : ""}`}>
                <button
                  className="history-open"
                  onClick={() => {
                    setHistoryOpen(false);
                    navigate(`chat/${c.id}`);
                  }}
                >
                  <strong>{c.title}</strong>
                  <span className="muted small">
                    {new Date(c.updated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {c.message_count} messages
                  </span>
                </button>
                <button className="small-btn danger" onClick={() => remove(c.id)}>
                  Delete
                </button>
              </div>
            ))}
            {conversations.length === 0 && <p className="muted small">No saved conversations yet. Start one with New chat.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  const isUser = m.role === "user";
  return (
    <div className={`msg ${isUser ? "user" : "assistant"}`}>
      <div className={`msg-avatar ${isUser ? "user" : "assistant"}`}>{isUser ? "You" : "AI"}</div>
      <div className="msg-col">
        {m.toolCalls.length > 0 && <ToolBlock calls={m.toolCalls} />}
        {m.content && (
          <div className="msg-body">
            {isUser ? (
              <div className="plain">{m.content}</div>
            ) : (
              <div className="md">
                <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
              </div>
            )}
          </div>
        )}
        <div className="msg-meta muted small">
          {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {m.model && ` · ${m.model}`}
        </div>
      </div>
    </div>
  );
}

// The tools a reply used: name, outcome, time taken, and the arguments and result on demand.
function ToolBlock({ calls }: { calls: ToolCall[] }) {
  const total = calls.reduce((n, c) => n + (c.durationMs ?? 0), 0);
  return (
    <details className="tool-block">
      <summary>
        <span className="tool-count">
          {calls.length} tool call{calls.length === 1 ? "" : "s"}
        </span>
        <span className="muted small">{total} ms</span>
      </summary>
      <div className="tool-list">
        {calls.map((c, i) => (
          <details key={i} className="tool-item">
            <summary>
              <code>{c.name}</code>
              <span className={`badge ${c.outcome === "ok" ? "read" : c.outcome === "denied" ? "write" : "blocked"}`}>{c.outcome}</span>
              <span className="muted small">{c.durationMs} ms</span>
            </summary>
            <div className="tool-detail">
              <div className="tool-label">Arguments</div>
              <pre>{JSON.stringify(c.args, null, 2)}</pre>
              <div className="tool-label">Result</div>
              <pre>{c.result || "(no output)"}</pre>
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
