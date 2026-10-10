// MCP servers the gateway knows how to connect to. An admin installs one with a
// click; the URL and auth mode are fixed here, so the URL cannot be typed wrong.
export interface CatalogEntry {
  key: string;
  slug: string;
  name: string;
  description: string;
  url: string;
  authMode: "static" | "oauth";
  // OAuth provider used when authMode is "oauth".
  provider?: "github";
  // Set for servers that belong to the store itself, which are never shared with
  // a third-party token.
  system?: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    key: "github",
    slug: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests, code search and releases. Each member connects their own GitHub account.",
    url: "https://api.githubcopilot.com/mcp/",
    authMode: "oauth",
    provider: "github",
  },
];

export function catalogEntry(key: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.key === key);
}
