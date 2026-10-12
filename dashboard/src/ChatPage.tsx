import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { History, Plus, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { navigate } from "./router";
import { Modal, Notice, Pill } from "./shared";

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

// Chat with saved conversations. The member's own history opens from the History button.
export function ChatPage({ id }: { id: string | null }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState("New chat");
  const [input, setInput] = useState(() => read(draftKey(id)) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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
  function newChat() {
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

  const empty = messages.length === 0 && !busy;

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[28rem] flex-col overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{id ? title : "New chat"}</div>
          {id && <div className="text-xs text-muted-foreground">Saved to your history</div>}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="size-4" />
            History
          </Button>
          <Button size="sm" onClick={newChat}>
            <Plus className="size-4" />
            New chat
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4 md:p-6">
        {empty && (
          <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-10 text-center">
            <div className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
              <Sparkles className="size-5" />
            </div>
            <h3 className="text-lg font-semibold">How can I help?</h3>
            <p className="text-sm text-muted-foreground">Ask in plain language. The agent uses only the tools your account can use, and every call is logged.</p>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              {STARTERS.map((s) => (
                <Button key={s} variant="outline" size="sm" className="rounded-full" onClick={() => send(s)} disabled={busy}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}

        {busy && (
          <div className="flex gap-3">
            <Avatar label="AI" assistant />
            <div className="flex items-center gap-1 rounded-2xl bg-muted px-4 py-3">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </div>
          </div>
        )}
        {error && <Notice tone="err">{error}</Notice>}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-end gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Textarea
          value={input}
          rows={1}
          placeholder="Message the agent. Enter to send, Shift+Enter for a new line."
          className="max-h-44 min-h-10 resize-none"
          onChange={(e) => {
            setInput(e.target.value);
            store(draftKey(id), e.target.value || null);
          }}
          onKeyDown={onKey}
          disabled={busy}
          aria-label="Message"
        />
        <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Send">
          <Send className="size-4" />
        </Button>
      </form>

      {historyOpen && (
        <Modal title="Chat history" subtitle="Your saved conversations. Open one to continue it." onClose={() => setHistoryOpen(false)} wide>
          <div className="space-y-2">
            {conversations.map((c) => (
              <div key={c.id} className={cn("flex items-center gap-3 rounded-lg border p-3", c.id === id && "border-primary bg-accent/50")}>
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setHistoryOpen(false);
                    navigate(`chat/${c.id}`);
                  }}
                >
                  <div className="truncate font-medium">{c.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(c.updated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {c.message_count} messages
                  </div>
                </button>
                <Button variant="destructive" size="sm" onClick={() => remove(c.id)}>
                  Delete
                </Button>
              </div>
            ))}
            {conversations.length === 0 && <p className="text-sm text-muted-foreground">No saved conversations yet. Start one with New chat.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Avatar({ label, assistant }: { label: string; assistant?: boolean }) {
  return (
    <div className={cn("grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold", assistant ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
      {label}
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  const isUser = m.role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <Avatar label={isUser ? "You" : "AI"} assistant={!isUser} />
      <div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1", isUser && "items-end")}>
        {m.toolCalls.length > 0 && <ToolBlock calls={m.toolCalls} />}
        {m.content && (
          <div className={cn("rounded-2xl px-4 py-2.5 text-sm break-words", isUser ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-muted")}>
            {isUser ? (
              <div className="whitespace-pre-wrap">{m.content}</div>
            ) : (
              <div className="space-y-2 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background/60 [&_pre]:p-2 [&_table]:text-xs [&_ul]:list-disc [&_ul]:pl-5">
                <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
              </div>
            )}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
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
    <details className="w-full rounded-lg border bg-background text-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
        <span className="font-medium">
          {calls.length} tool call{calls.length === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground">{total} ms</span>
      </summary>
      <div className="space-y-1 border-t p-2">
        {calls.map((c, i) => (
          <details key={i} className="rounded-md border p-2">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <code className="text-xs">{c.name}</code>
              <Pill tone={c.outcome === "ok" ? "ok" : c.outcome === "denied" ? "warn" : "danger"}>{c.outcome}</Pill>
              <span className="text-xs text-muted-foreground">{c.durationMs} ms</span>
            </summary>
            <div className="mt-2 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Arguments</div>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(c.args, null, 2)}</pre>
              <div className="text-xs font-medium text-muted-foreground">Result</div>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{c.result || "(no output)"}</pre>
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
