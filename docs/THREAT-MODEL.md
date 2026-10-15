# Threat model

This note covers what the gateway protects, who might attack it, the controls in place, and the gaps that remain. Gaps are marked **Gap**. Each control points to the code that enforces it.

## Assets

1. **Upstream credentials:** WooCommerce consumer keys, and any shared header or bearer credential an admin adds.
2. **Member identities:** passwords, dashboard sessions, API keys, and OAuth tokens for MCP clients.
3. **Member upstream tokens:** a member's own GitHub or Slack token, obtained through browser sign-in.
4. **Store data:** orders, customers, products, and the WordPress database.
5. **Roles and permissions:** who can change what.
6. **Audit log:** the record of who did what.

## Actors

- **Member:** a signed-in user with a role, server grants and tool rules.
- **Admin:** a user with the permissions to manage members, roles, servers and the model. "Admin" here means a role with those permissions; any role can be given them.
- **External client:** an MCP client holding a member's API key or OAuth token.
- **Malicious or compromised upstream:** an MCP server an admin added, or one that was taken over.
- **Network attacker:** anyone who can reach the public ingress.

## Controls by asset

### 1. Upstream credentials

- Encrypted with AES-256-GCM before they reach Postgres (`crypto.ts`). The key comes from a Kubernetes Secret.
- Never returned by the API. The dashboard shows only that a credential exists.
- Sent only to their own upstream, as a header, when the gateway connects (`upstreams.ts`, `connect`).
- woo-mcp signs each WooCommerce call with OAuth 1.0a. WooCommerce stores only a hash of the consumer key.

**Gap:** the encryption key and the ciphertext live in the same cluster. Anyone who can read the gateway's Secret and the database can decrypt the credentials. An external KMS would close this; it isn't built.

### 2. Member identities

- **Passwords** are stored with scrypt and a per-password salt (`crypto.ts`).
- **Sessions** last 12 hours, in an HttpOnly, SameSite=Strict cookie. Revoking a member's access deletes their sessions at once.
- **API keys** are 32 random bytes, shown once, and stored as SHA-256 hashes. A member revokes their own keys. Revoking access rejects every key on the next call (`identityFromApiKey` checks `NOT disabled`).
- **OAuth tokens** for MCP clients use PKCE (S256). Access tokens are short-lived, and refresh tokens rotate on use and last 30 days. Upstream sign-in flows expire after 10 minutes.
- **Sign-in attempts** are throttled to 10 failures per client address in 15 minutes (`api.ts`).

**Gap:** the throttle is per IP address, so an attacker with many addresses can keep guessing. There is no per-account lockout and no per-key rate limit. API keys never expire.

### 3. Member upstream tokens

- Stored encrypted, and decrypted only for the owning member's calls (`tools.ts`, `callerFor`).
- The gateway's own OAuth token is never forwarded upstream. The only token an upstream receives is the member's own provider token, and only for their own calls (`upstreams.ts`).

### 4. Store data and the store

- The store's network policies deny ingress by default. MariaDB accepts only WordPress and the setup Job. WordPress accepts only the ingress controller and woo-mcp. woo-mcp accepts only the gateway, and can reach only WordPress. Tested on Calico with allowed and blocked paths.
- Dashboard requests reach the store only through the gateway.

**Gap:** the WordPress admin password is one credential that controls the whole store. It is stored in a Secret; rotating it is a manual step.

### 5. Roles and permissions

- Each API route checks the permission it needs before doing work.
- The server, not the dashboard, decides. Hiding a button is never the only control.
- Built-in Admin cannot be edited or deleted. A role with members can't be deleted.
- The last active member who can manage roles can't be disabled or deleted.
- A member can't disable or change their own role.

**Gap, delegated escalation:** a member with `members.manage` can assign any role to anyone, including Admin. A member with `roles.manage` can add any permission to any custom role they hold. The code doesn't check that the person making the change already holds the permissions they grant. The fix is to allow granting only permissions the actor holds, and to block assigning a role that has more permissions than the actor.

### 6. Audit log

- Every tool call writes a row with user, server, tool, duration and outcome (`mcp.ts`, `tools.ts`).
- Members see their own entries. Only members with `audit.view_all` see everyone's.

**Gap:** anyone with database access can edit the log, so it is not tamper-evident. Shipping it to an append-only store would fix that.

## Threats

### A member with a shared server credential

On a shared server, every member with access uses the same credential. A member never sees it, but can do anything that credential allows, within their grant and tool rules. Per-tool rules and the read or read-and-write levels limit this, and the audit log records each call.

**Gap:** the credential's reach is the same for everyone who has access. Per-member credentials would limit this.

### Why client tokens are not passed upstream

A client holds a credential for the gateway, not for the upstream. Passing it upstream would let the upstream act as the gateway, and would expose the gateway's identity to a third party. The gateway sends only the upstream's own credential, or the member's own upstream token for browser sign-in servers.

### Untrusted upstream tool descriptions

A server's tool descriptions go to the model and to clients unchanged (`tools.ts`, `mcp.ts`). A malicious server can write instructions into a description, and the model may follow them.

**Gap, not mitigated.** The gateway doesn't inspect descriptions. What limits the damage now:
- only members with `servers.manage` can add a server;
- the permission rule decides whether a tool can be called at all, so a hostile description can't make a member call a tool they were not allowed to call.

Next steps: show each description to the admin when the server is added, and flag descriptions that contain instructions.

### A malicious or compromised server, added by an admin

- **Its credential:** it receives the shared credential, or the member's own token, on each call.
- **Its results:** they go to the model and the member. Chat results are cut to 3,000 characters, which limits flooding but not a targeted injection.
- **Internal addresses:** blocked for loopback, link-local, metadata and private names (`ssrf.ts`). The check reads the literal host only.
- **Hanging the gateway:** each call has a timeout, and an unreachable server is marked as such.

**Gap:** DNS rebinding is not defended. The fix is to resolve the host and check the resulting address before connecting.

### Stolen or leaked keys

- Revoking a key rejects the next call. Revoking access rejects every key of that member.
- Keys are random, so guessing one is not feasible.
- The audit log attributes every call to the member.

**Gap:** keys don't expire, and there is no alert on unusual use.

### What one member can do to another

- A member can't see another member's keys, sessions or chats. Those lists are scoped to the signed-in user.
- A member can't change another member's permissions without `members.manage`.
- A member with `members.manage` can change other members' roles, which is the delegated escalation gap above.

### Network attacker

- Only the ingress controller is exposed. Every other service is `ClusterIP`.
- The ingress routes only the gateway and dashboard paths. Admin APIs require a session with the right permission.
- The gateway sends a Content-Security-Policy header. The dashboard's nginx does not set one.
- Network policies stop pods from reaching anything they don't need (tested locally).

**Gap:** on the VPS the bare IP serves a self-signed certificate, which browsers warn about.

### Compromised administrator

An admin can change any setting, read the audit log and reset passwords. That's expected. The controls are the audit log and the fact that roles and permissions are explicit.

**Gap:** there is no second approver for adding a server or changing a role, and no alert on a permission change.

## Summary of gaps

1. Upstream credentials can be decrypted by anyone who can read the gateway's Secret and the database.
2. Sign-in is throttled per IP only. There is no per-account lockout and no per-key rate limit.
3. API keys never expire.
4. Tool descriptions from untrusted servers are passed through unchecked.
5. DNS rebinding is not blocked by the SSRF check.
6. Shared server credentials give every member with access the same upstream reach.
7. A member who can manage members or roles can grant permissions they don't hold.
8. The audit log can be edited by anyone with database access.
9. The WordPress admin password controls the whole store.
