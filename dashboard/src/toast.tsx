// Short messages that appear in a corner and fade away. Any part of the app can call notify().
import { useEffect, useState } from "react";

export type Tone = "ok" | "error" | "info";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

let nextId = 1;
let listeners: ((items: Toast[]) => void)[] = [];
let items: Toast[] = [];

function publish(next: Toast[]) {
  items = next;
  listeners.forEach((l) => l(items));
}

export function notify(message: string, tone: Tone = "info") {
  const id = nextId++;
  publish([...items, { id, message, tone }].slice(-4));
  setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4000);
}

export function dismiss(id: number) {
  publish(items.filter((t) => t.id !== id));
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>(items);
  useEffect(() => {
    listeners.push(setList);
    return () => {
      listeners = listeners.filter((l) => l !== setList);
    };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
          <span className="toast-text">{t.message}</span>
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
