// Brand badges for providers, servers and clients. Monogram badges in each brand's colour,
// drawn here, so no third-party logo files are fetched or bundled.
import { cn } from "@/lib/utils";

const BRANDS: Record<string, { name: string; color: string; mark: string }> = {
  groq: { name: "Groq", color: "#f55036", mark: "G" },
  gemini: { name: "Google Gemini", color: "#4285f4", mark: "G" },
  openrouter: { name: "OpenRouter", color: "#6467f2", mark: "OR" },
  ollama: { name: "Ollama", color: "#1f2328", mark: "O" },
  openai: { name: "OpenAI", color: "#10a37f", mark: "AI" },
  anthropic: { name: "Anthropic", color: "#d97757", mark: "A" },
  custom: { name: "Custom", color: "#656d76", mark: "{}" },
  github: { name: "GitHub", color: "#24292f", mark: "GH" },
  slack: { name: "Slack", color: "#4a154b", mark: "Sl" },
  "claude-code": { name: "Claude Code", color: "#d97757", mark: "CC" },
  cursor: { name: "Cursor", color: "#111111", mark: "Cu" },
  vscode: { name: "VS Code", color: "#0078d4", mark: "VS" },
  codex: { name: "OpenAI Codex", color: "#10a37f", mark: "Cx" },
  inspector: { name: "MCP Inspector", color: "#6d28d9", mark: "In" },
  other: { name: "Other MCP client", color: "#656d76", mark: "+" },
  woocommerce: { name: "WooCommerce", color: "#7f54b3", mark: "Wc" },
};

export function brandOf(id: string) {
  return BRANDS[id] ?? { name: id, color: "#656d76", mark: id.slice(0, 2).toUpperCase() };
}

export function Logo({ id, size = 36 }: { id: string; size?: number }) {
  const b = brandOf(id);
  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-md font-bold tracking-tight text-white")}
      style={{ width: size, height: size, background: b.color, fontSize: size * (b.mark.length > 1 ? 0.36 : 0.44) }}
      aria-label={b.name}
      title={b.name}
    >
      {b.mark}
    </span>
  );
}

// The gateway's own mark, shown in the sidebar and on the sign-in page.
export function GatewayMark({ size = 36 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-md border bg-muted text-foreground" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 40 40" className="size-[70%] fill-none stroke-current" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 4.5 33.5 12v16L20 35.5 6.5 28V12L20 4.5Z" />
        <path d="M13 20h14M20 13v14" />
        <circle cx="20" cy="20" r="3.5" />
      </svg>
    </span>
  );
}
