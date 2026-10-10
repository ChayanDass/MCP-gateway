// Brand badges for providers and servers. Monogram badges in each brand's colour,
// drawn here, so no third-party logo files are fetched or bundled. Swap in the
// official SVG for any entry by replacing its `mark`.
const BRANDS: Record<string, { name: string; color: string; mark: string }> = {
  groq: { name: "Groq", color: "#f55036", mark: "G" },
  gemini: { name: "Google Gemini", color: "#4285f4", mark: "G" },
  openrouter: { name: "OpenRouter", color: "#6467f2", mark: "OR" },
  ollama: { name: "Ollama", color: "#111827", mark: "O" },
  openai: { name: "OpenAI", color: "#10a37f", mark: "AI" },
  anthropic: { name: "Anthropic", color: "#d97757", mark: "A" },
  custom: { name: "Custom", color: "#64748b", mark: "{}" },
  github: { name: "GitHub", color: "#24292f", mark: "GH" },
  woocommerce: { name: "WooCommerce", color: "#7f54b3", mark: "Wc" },
};

export function GatewayMark({ size = 36 }: { size?: number }) {
  return (
    <span className="gateway-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <path d="M20 4.5 33.5 12v16L20 35.5 6.5 28V12L20 4.5Z" />
        <path d="M13 20h14M20 13v14" />
        <circle cx="20" cy="20" r="3.5" />
      </svg>
    </span>
  );
}

export function brandOf(id: string) {
  return BRANDS[id] ?? { name: id, color: "#64748b", mark: id.slice(0, 2).toUpperCase() };
}

export function Logo({ id, size = 36 }: { id: string; size?: number }) {
  const b = brandOf(id);
  return (
    <span
      className="logo"
      style={{ width: size, height: size, background: b.color, fontSize: size * (b.mark.length > 1 ? 0.36 : 0.44) }}
      aria-label={b.name}
      title={b.name}
    >
      {b.mark}
    </span>
  );
}
