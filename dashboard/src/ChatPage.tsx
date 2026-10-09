import { useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatReply } from "./api";

interface Turn {
  role: "user" | "assistant";
  text: string;
  tools?: ChatReply["toolCalls"];
}

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: message }]);
    try {
      const r = await api<ChatReply>("POST", "/api/chat", { message });
      setTurns((t) => [...t, { role: "assistant", text: r.reply, tools: r.toolCalls }]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", text: err instanceof Error ? err.message : "Chat failed" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Chat</h2>
      <p className="muted">The agent calls tools through the gateway as you. Its calls appear in the audit log under your name.</p>
      <div className="chat">
        {turns.map((t, i) => (
          <div key={i} className={`bubble ${t.role}`}>
            <div className="md">
              {t.role === "assistant" ? <Markdown remarkPlugins={[remarkGfm]}>{t.text}</Markdown> : t.text}
            </div>
            {t.tools && t.tools.length > 0 && (
              <div className="small muted">
                Tools called: {t.tools.map((c) => (c.isError ? `${c.name} (error)` : c.name)).join(", ")}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="muted">Thinking…</div>}
      </div>
      <form className="row" onSubmit={send}>
        <input
          className="grow"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. What orders came in today?"
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </section>
  );
}
