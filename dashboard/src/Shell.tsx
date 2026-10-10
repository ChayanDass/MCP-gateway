import { useState } from "react";
import { api, type Me } from "./api";
import { navigate, useRoute } from "./router";
import { ServersPage } from "./ServersPage";
import { ServerDetailPage } from "./ServerDetailPage";
import { ProvidersPage } from "./ProvidersPanel";
import { MembersPage } from "./MembersPage";
import { AuditPage } from "./AuditPage";
import { ChatPage } from "./ChatPage";
import { ClientsPage } from "./ClientsPage";
import { LlmPage } from "./LlmPage";
import { OverviewPage } from "./OverviewPage";
import { ToolPermissionsPage } from "./ToolPermissionsPage";

interface Item {
  key: string; // the address, e.g. "security/members"
  label: string;
  adminOnly?: boolean;
}

interface Group {
  key: string;
  label: string;
  icon: string;
  items: Item[];
}

type Entry = (Item & { icon: string }) | Group;

// Top-level pages and expandable groups. A group opens in place, like GitHub's sidebar.
const NAV: Entry[] = [
  { key: "overview", label: "Overview", icon: "⌂" },
  { key: "servers", label: "MCP servers", icon: "◎" },
  { key: "clients", label: "Clients", icon: "⇄" },
  { key: "chat", label: "Chat", icon: "✦" },
  {
    key: "security",
    label: "Security",
    icon: "◉",
    items: [
      { key: "security/members", label: "Members", adminOnly: true },
      { key: "security/tools", label: "Tool permissions", adminOnly: true },
      { key: "security/audit", label: "Audit log" },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    icon: "⚙",
    items: [
      { key: "settings/providers", label: "Sign-in providers", adminOnly: true },
      { key: "settings/model", label: "Model", adminOnly: true },
    ],
  },
];

const isGroup = (n: Entry): n is Group => "items" in n;

// Old addresses still work.
const ALIASES: Record<string, string> = {
  members: "security/members",
  audit: "security/audit",
  tools: "security/tools",
  model: "settings/model",
  providers: "settings/providers",
  connect: "clients",
};

const TITLES: Record<string, { title: string; hint: string }> = {
  overview: { title: "Overview", hint: "Live status of the gateway, your tools and recent activity." },
  servers: { title: "MCP servers", hint: "Every server the gateway connects to, and whether you can use it." },
  clients: { title: "Clients", hint: "Connect Claude Code, Cursor, VS Code, Codex or any MCP client, with a key or browser sign-in." },
  chat: { title: "Chat", hint: "Ask in plain language. The agent uses the tools your account can use." },
  "security/members": { title: "Members", hint: "Create members, and give or revoke their access to each server." },
  "security/tools": { title: "Tool permissions", hint: "Allow or deny individual tools for each member. Deny always wins." },
  "security/audit": { title: "Audit log", hint: "Every tool call through the gateway, with who made it and the outcome." },
  "settings/providers": { title: "Sign-in providers", hint: "The services members sign in to, with their client credentials." },
  "settings/model": { title: "Model", hint: "The model the chat agent uses. Any OpenAI-compatible or Anthropic model works." },
};

export function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const route = useRoute();
  const isAdmin = me.role === "admin";
  const requested = route.join("/");
  const current = ALIASES[requested] ?? (requested || "overview");
  // The page family: "servers" for the list and detail, "security/members" and so on.
  const active = route[0] === "servers" ? "servers" : route[0] === "security" || route[0] === "settings" ? route.slice(0, 2).join("/") : route[0] || "overview";
  const [open, setOpen] = useState<Record<string, boolean>>({});

  async function logout() {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    onLogout();
  }

  const visible = NAV.map((n) => (isGroup(n) ? { ...n, items: n.items.filter((i) => !i.adminOnly || isAdmin) } : n)).filter((n) => !isGroup(n) || n.items.length > 0);
  const groupFor = (key: string) => visible.find((n): n is Group => isGroup(n) && n.items.some((i) => i.key === key));
  const activeGroup = groupFor(active);
  const isOpen = (g: Group) => open[g.key] ?? g.key === activeGroup?.key;

  const info = TITLES[active] ?? TITLES[current] ?? TITLES.overview;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⬡</span>
          <div>
            <div className="brand-name">MCP Gateway</div>
            <div className="brand-sub">Team tools in one place</div>
          </div>
        </div>
        <nav className="nav">
          {visible.map((n) =>
            isGroup(n) ? (
              <div key={n.key} className="nav-group">
                <button className={`nav-item nav-parent ${activeGroup?.key === n.key ? "in" : ""}`} aria-expanded={isOpen(n)} onClick={() => setOpen({ ...open, [n.key]: !isOpen(n) })}>
                  <span className="nav-icon">{n.icon}</span>
                  <span className="nav-label">{n.label}</span>
                  <span className={`nav-chev ${isOpen(n) ? "up" : ""}`}>▾</span>
                </button>
                {isOpen(n) && (
                  <div className="nav-sub">
                    {n.items.map((i) => (
                      <a
                        key={i.key}
                        href={`#/${i.key}`}
                        className={active === i.key ? "nav-sub-item active" : "nav-sub-item"}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(i.key);
                        }}
                      >
                        {i.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <a
                key={n.key}
                href={`#/${n.key}`}
                className={active === n.key ? "nav-item active" : "nav-item"}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(n.key);
                }}
              >
                <span className="nav-icon">{n.icon}</span>
                <span className="nav-label">{n.label}</span>
              </a>
            ),
          )}
        </nav>
        <div className="account">
          <div className="avatar">{me.name.slice(0, 1).toUpperCase()}</div>
          <div className="account-text">
            <div className="account-name">{me.name}</div>
            <div className="account-role">{me.role}</div>
          </div>
          <button className="ghost small-btn" onClick={logout} title="Sign out">
            Sign out
          </button>
        </div>
      </aside>

      <div className="content">
        <div className="container">
          <header className="page-head">
            <h1>{route[0] === "servers" && route[1] ? "MCP servers" : info.title}</h1>
            <p className="muted">{route[0] === "servers" && route[1] ? "One server, its tools and its settings." : info.hint}</p>
          </header>
          <main>
            {route[0] === "servers" && route[1] ? (
              <ServerDetailPage id={route[1]} tab={(route[2] as "overview" | "tools" | "settings") || "overview"} isAdmin={isAdmin} />
            ) : (
              <>
                {active === "overview" && <OverviewPage isAdmin={isAdmin} />}
                {active === "servers" && <ServersPage isAdmin={isAdmin} />}
                {active === "clients" && <ClientsPage userId={me.id} />}
                {active === "chat" && <ChatPage id={route[1] ?? null} />}
                {active === "security/members" && isAdmin && <MembersPage me={me} />}
                {active === "security/tools" && isAdmin && <ToolPermissionsPage />}
                {active === "security/audit" && <AuditPage />}
                {active === "settings/providers" && isAdmin && <ProvidersPage />}
                {active === "settings/model" && isAdmin && <LlmPage />}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
