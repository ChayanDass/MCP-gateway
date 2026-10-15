// The permission registry. Every capability the gateway checks is listed here once.
// The dashboard reads this list from GET /api/permissions, so adding a permission
// means adding one entry here and one check where it's used.
export interface PermissionDef {
  key: string;
  label: string;
  group: "Team" | "Servers" | "Settings" | "Access" | "Use";
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  { key: "members.manage", label: "Manage members", group: "Team", description: "Create, edit, revoke and delete members, and set their server access and passwords." },
  { key: "roles.manage", label: "Manage roles", group: "Team", description: "Create and edit roles, and choose what each role can do." },
  { key: "tools.manage", label: "Set tool permissions", group: "Team", description: "Allow or block individual tools, for each server and for each member." },
  { key: "servers.manage", label: "Set up MCP servers", group: "Servers", description: "Add, edit, turn off and remove MCP servers." },
  { key: "stores.manage", label: "Create and delete stores", group: "Servers", description: "Create, retry and delete WooCommerce stores that run on the cluster." },
  { key: "providers.manage", label: "Set up sign-in providers", group: "Settings", description: "Add and edit the services members sign in to for their own server accounts." },
  { key: "model.manage", label: "Set up the model", group: "Settings", description: "Choose the model and provider the chat agent uses." },
  { key: "servers.full_access", label: "Use every server", group: "Access", description: "Use every server and tool without per-server grants." },
  { key: "audit.view_all", label: "See everyone's audit log", group: "Access", description: "See audit entries for every member, not only your own." },
  { key: "chat.use", label: "Use the chat agent", group: "Use", description: "Ask questions in the dashboard chat, which calls tools as you." },
  { key: "mcp.use", label: "Connect MCP clients", group: "Use", description: "Create keys and connect clients such as Claude Code through the gateway." },
];

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);

export const BUILTIN_ROLES: { name: string; description: string; permissions: string[] }[] = [
  { name: "Admin", description: "Full control of the gateway. Cannot be edited or deleted.", permissions: ALL_PERMISSIONS },
  { name: "Member", description: "Uses the servers they are granted, through chat and MCP clients.", permissions: ["chat.use", "mcp.use"] },
];

export function isKnownPermission(key: string): boolean {
  return ALL_PERMISSIONS.includes(key);
}

export function can(user: { permissions: string[] }, permission: string): boolean {
  return user.permissions.includes(permission);
}
