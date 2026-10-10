import { useEffect, useRef, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatReply } from "./api";

interface Turn {
  role: "user" | "assistant";
  text: string;
  tools?: ChatReply["toolCalls"];
  error?: boolean;
}

const STARTERS = ["What orders came in today?", "List the products in the store", "Which orders are still open?"];

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: message }]);
    try {
      const r = await api<ChatReply>("POST", "/api/chat", { message });
      setTurns((t) => [...t, { role: "assistant", text: r.reply, tools: r.toolCalls }]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", text: err instanceof Error ? err.message : "Chat failed", error: true }]);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  return (
    <div className="chat-panel">
      <div className="chat-scroll">
        {turns.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-mark">✦</div>
            <h3>How can I help with the store today?</h3>
            <p className="muted small">The agent uses only the tools your account is allowed to use, and every call is logged under your name.</p>
            <div className="chips">
              {STARTERS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>
            <div className={`msg-avatar ${t.role}`}>{t.role === "user" ? "You" : "AI"}</div>
            <div className={`msg-body${t.error ? " error" : ""}`}>
              {t.role === "assistant" && !t.error ? (
                <div className="md">
                  <Markdown remarkPlugins={[remarkGfm]}>{t.text}</Markdown>
                </div>
              ) : (
                <div>{t.text}</div>
              )}
              {t.tools && t.tools.length > 0 && (
                <div className="tool-calls">
                  {t.tools.map((c, j) => (
                    <span key={j} className={c.isError ? "tool-chip error" : "tool-chip"}>
                      {c.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
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
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about orders, products or GitHub…"
          aria-label="Message"
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
