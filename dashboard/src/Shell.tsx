import { useState } from "react";
import { api, type Me } from "./api";
import { ServersPage } from "./ServersPage";
import { MembersPage } from "./MembersPage";
import { AuditPage } from "./AuditPage";
import { ChatPage } from "./ChatPage";
import { ConnectPage } from "./ConnectPage";
import { LlmPage } from "./LlmPage";

type Tab = "servers" | "members" | "audit" | "chat" | "connect" | "model";

export function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("servers");
  const isAdmin = me.role === "admin";
  const tabs: [Tab, string][] = [
    ["servers", "MCP servers"],
    ["members", isAdmin ? "Members & keys" : "My keys"],
    ["audit", "Audit log"],
    ["chat", "Chat"],
    ["connect", "Connect a client"],
    ...(isAdmin ? [["model", "Model"] as [Tab, string]] : []),
  ];

  async function logout() {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    onLogout();
  }

  return (
    <div className="layout">
      <header className="topbar">
        <strong>MCP Gateway</strong>
        <nav>
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="muted">
          {me.name} · {me.role}{" "}
          <button className="link" onClick={logout}>
            Sign out
          </button>
        </span>
      </header>
      <main>
        {tab === "servers" && <ServersPage isAdmin={isAdmin} />}
        {tab === "members" && <MembersPage me={me} />}
        {tab === "audit" && <AuditPage />}
        {tab === "chat" && <ChatPage />}
        {tab === "connect" && <ConnectPage />}
        {tab === "model" && isAdmin && <LlmPage />}
      </main>
    </div>
  );
}
