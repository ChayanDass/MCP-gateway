import { api, type Me } from "./api";
import { navigate, useRoute } from "./router";
import { ServersPage } from "./ServersPage";
import { MembersPage } from "./MembersPage";
import { AuditPage } from "./AuditPage";
import { ChatPage } from "./ChatPage";
import { ConnectPage } from "./ConnectPage";
import { LlmPage } from "./LlmPage";
import { OverviewPage } from "./OverviewPage";
import { GatewayMark } from "./Logo";

interface NavItem {
  key: string;
  label: string;
  adminOnly?: boolean;
  icon: string;
}

const NAV: NavItem[] = [
  { key: "overview", label: "Overview", icon: "⌂" },
  { key: "servers", label: "MCP servers", icon: "◎" },
  { key: "members", label: "Members & keys", icon: "◉" },
  { key: "audit", label: "Audit log", icon: "≡" },
  { key: "chat", label: "Chat", icon: "✦" },
  { key: "connect", label: "Connect a client", icon: "⇄" },
  { key: "model", label: "Model", adminOnly: true, icon: "⚙" },
];

export function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const route = useRoute();
  const section = route[0] || "overview";
  const isAdmin = me.role === "admin";
  const items = NAV.filter((n) => !n.adminOnly || isAdmin);

  async function logout() {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    onLogout();
  }

  const active = items.find((n) => n.key === section) ?? items[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <GatewayMark />
          <div>
            <div className="brand-name">MCP Gateway</div>
            <div className="brand-sub">Team tools in one place</div>
          </div>
        </div>
        <nav className="nav">
          {items.map((n) => (
            <a
              key={n.key}
              href={`#/${n.key}`}
              className={active.key === n.key ? "nav-item active" : "nav-item"}
              onClick={(e) => {
                e.preventDefault();
                navigate(n.key);
              }}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </a>
          ))}
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
            <h1>{active.label}</h1>
            <p className="muted">{pageHint(active.key)}</p>
          </header>
          <main>
          {active.key === "overview" && <OverviewPage isAdmin={isAdmin} />}
          {active.key === "servers" && <ServersPage isAdmin={isAdmin} />}
          {active.key === "members" && <MembersPage me={me} route={route} />}
          {active.key === "audit" && <AuditPage />}
          {active.key === "chat" && <ChatPage />}
          {active.key === "connect" && <ConnectPage />}
          {active.key === "model" && isAdmin && <LlmPage />}
          </main>
        </div>
      </div>
    </div>
  );
}

function pageHint(key: string): string {
  switch (key) {
    case "overview":
      return "Live status of the gateway, your tools and recent activity.";
    case "servers":
      return "Upstream servers, their status, and which tools each one exposes.";
    case "members":
      return "Team members, their access to each server, and their API keys.";
    case "audit":
      return "Every tool call through the gateway, with who made it and the outcome.";
    case "chat":
      return "Ask questions in plain language. The agent uses the tools your account can use.";
    case "connect":
      return "Set up Claude Code, Cursor, VS Code, Codex or any MCP client.";
    case "model":
      return "The model the chat agent uses. Any OpenAI-compatible or Anthropic model works.";
    default:
      return "";
  }
}
