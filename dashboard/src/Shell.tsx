import { lazy, Suspense, useState } from "react";
import { ChevronDown, LayoutDashboard, LogOut, Monitor, Moon, MessageSquare, Plug, Server, Settings, Shield, Sparkles, Sun, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { api, type Me } from "./api";
import { getTheme, setTheme, type ThemeChoice } from "./theme";
import { navigate, useRoute } from "./router";
import { GatewayMark } from "./Logo";
import { Loading, PageHeader } from "./shared";

const ServersPage = lazy(() => import("./ServersPage").then((m) => ({ default: m.ServersPage })));
const ServerDetailPage = lazy(() => import("./ServerDetailPage").then((m) => ({ default: m.ServerDetailPage })));
const ProvidersPage = lazy(() => import("./ProvidersPanel").then((m) => ({ default: m.ProvidersPage })));
const MembersPage = lazy(() => import("./MembersPage").then((m) => ({ default: m.MembersPage })));
const AuditPage = lazy(() => import("./AuditPage").then((m) => ({ default: m.AuditPage })));
const ChatPage = lazy(() => import("./ChatPage").then((m) => ({ default: m.ChatPage })));
const ClientsPage = lazy(() => import("./ClientsPage").then((m) => ({ default: m.ClientsPage })));
const LlmPage = lazy(() => import("./LlmPage").then((m) => ({ default: m.LlmPage })));
const OverviewPage = lazy(() => import("./OverviewPage").then((m) => ({ default: m.OverviewPage })));
const ToolPermissionsPage = lazy(() => import("./ToolPermissionsPage").then((m) => ({ default: m.ToolPermissionsPage })));

interface Item {
  key: string; // the address, e.g. "security/members"
  label: string;
  adminOnly?: boolean;
}

interface Group {
  key: string;
  label: string;
  icon: LucideIcon;
  items: Item[];
}

type Entry = (Item & { icon: LucideIcon }) | Group;

// Top-level pages and expandable groups. A group opens in place, like GitHub's sidebar.
const NAV: Entry[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "servers", label: "MCP servers", icon: Server },
  { key: "clients", label: "Clients", icon: Plug },
  { key: "chat", label: "Chat", icon: MessageSquare },
  {
    key: "security",
    label: "Security",
    icon: Shield,
    items: [
      { key: "security/members", label: "Members", adminOnly: true },
      { key: "security/tools", label: "Tool permissions", adminOnly: true },
      { key: "security/audit", label: "Audit log" },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings,
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
  const onServerDetail = route[0] === "servers" && route[1];

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[15rem_1fr]">
      <aside className="flex flex-col gap-4 border-b bg-sidebar p-4 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
        <div className="flex items-center gap-3 px-2">
          <GatewayMark size={32} />
          <div className="leading-tight">
            <div className="font-semibold text-foreground">MCP Gateway</div>
            <div className="text-xs text-muted-foreground">Team tools in one place</div>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible" aria-label="Main">
          {visible.map((n) =>
            isGroup(n) ? (
              <div key={n.key} className="hidden md:block">
                <button
                  className={cn(NAV_BTN, activeGroup?.key === n.key && "text-foreground")}
                  aria-expanded={isOpen(n)}
                  onClick={() => setOpen({ ...open, [n.key]: !isOpen(n) })}
                >
                  <n.icon className="size-4" />
                  <span className="flex-1 text-left">{n.label}</span>
                  <ChevronDown className={cn("size-4 transition-transform", isOpen(n) && "rotate-180")} />
                </button>
                {isOpen(n) && (
                  <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l pl-3">
                    {n.items.map((i) => (
                      <a
                        key={i.key}
                        href={`#/${i.key}`}
                        className={cn("rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent", active === i.key ? "font-medium text-foreground" : "text-muted-foreground")}
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
                className={cn(NAV_BTN, active === n.key ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "")}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(n.key);
                }}
              >
                <n.icon className="size-4" />
                <span>{n.label}</span>
              </a>
            ),
          )}
        </nav>

        <div className="mt-auto space-y-3">
          <ThemeSwitch />
          <Separator />
          <div className="flex items-center gap-3 px-1">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary text-primary-foreground">{me.name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{me.name}</div>
              <div className="text-xs capitalize text-muted-foreground">{me.role}</div>
            </div>
            <Button variant="ghost" size="icon" onClick={logout} title="Sign out" aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0">
        <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
          <PageHeader
            title={onServerDetail ? "MCP servers" : info.title}
            hint={onServerDetail ? "One server, its tools and its settings." : info.hint}
          />
          <Suspense fallback={<Loading lines={5} />}>
            {onServerDetail ? (
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
          </Suspense>
        </div>
      </main>

      {active !== "chat" && (
        <Button className="fixed bottom-5 right-5 rounded-full shadow-lg" onClick={() => navigate("chat")} aria-label="Open the assistant">
          <Sparkles className="size-4" />
          Ask
        </Button>
      )}
    </div>
  );
}

const NAV_BTN = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground md:whitespace-normal whitespace-nowrap";

// Light, dark, or system. Cycles on click and shows the current choice.
function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme());
  const next: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
  const label: Record<ThemeChoice, string> = { system: "Auto", light: "Light", dark: "Dark" };
  const Icon = choice === "dark" ? Moon : choice === "light" ? Sun : Monitor;
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start gap-2"
      onClick={() => {
        const n = next[choice];
        setTheme(n);
        setChoice(n);
      }}
      aria-label={`Theme: ${label[choice]}. Click to change.`}
      title="Change theme"
    >
      <Icon className="size-4" />
      {label[choice]}
    </Button>
  );
}
