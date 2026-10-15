# Threat model

This note lists what the system protects, who might attack it, what stops each attack, and what is still open. Each control points to the code that enforces it. Open items are marked **gap**.

## Assets

1. **Upstream credentials:** the WooCommerce consumer key and secret, GitHub and Slack tokens, and any shared header credential an admin adds.
2. **Member identities:** gateway API keys, sessions, and passwords.
3. **Member upstream tokens:** each member's own Slack or GitHub token, obtained by browser sign-in.
4. **Store data:** orders, customers, products, and the WordPress database.
5. **Audit log:** the record of who did what.

## Actors

- **Member:** a signed-in team member, with a gateway key or an OAuth client.
- **Admin:** manages members, servers and providers.
- **External client:** any MCP client holding a member's key or token.
- **Malicious or compromised upstream:** an MCP server an admin added, or one that was taken over.
- **Network attacker:** anyone who can reach the public ingress.

## Controls by asset

### 1. Upstream credentials

- Encrypted with AES-256-GCM before they reach Postgres (`services/gateway/src/crypto.ts`). The key comes from a Kubernetes Secret.
- Never returned by the API. The dashboard shows only that a credential exists.
- Sent only to their own upstream, as a header, when the gateway connects (`upstreams.ts`, `connect`).
- Each woo-mcp call is signed with OAuth 1.0a. The consumer key is stored in WooCommerce only as a hash (`yamls/store/04-setup.yaml`).

**Gap:** the encryption key and the ciphertext are both in the cluster. Anyone who can read the gateway's Secret and the database can decrypt the credentials. Fixing this needs an external KMS, which is not built.

### 2. Member identities

- Gateway API keys are 32 random bytes, shown once, and stored as SHA-256 hashes (`identity.ts`, `crypto.ts`). Revocation takes effect on the next call.
- Passwords are stored with scrypt and a per-password salt (`crypto.ts`).
- Sessions are 12 hours, with an HttpOnly, SameSite=Strict cookie. Disabling a user deletes their sessions (`api.ts`).
- Sign-in attempts are throttled: 10 failures per client address in 15 minutes (`api.ts`).
- Disabling a user or changing their password signs them out everywhere.

**Gap:** the throttle is per IP address, so an attacker with many addresses can keep guessing. There is no lockout per account, and no per-key rate limit.

### 3. Member upstream tokens

- Stored encrypted, in `user_server_access` or the OAuth grant table, and decrypted only for the owning member's calls (`tools.ts`, `callerFor`).
- The gateway's own OAuth client token is never forwarded upstream. The only token sent upstream is the member's own provider token, and only for their own calls (`upstreams.ts` lines 183–187).

### 4. Store data and the store itself

- The database accepts connections only from WordPress and the setup Job (`yamls/store/05-networkpolicies.yaml`).
- woo-mcp accepts connections only from the gateway, and can reach only WordPress (store network policies, tested).
- WordPress accepts traffic only from the ingress controller and from woo-mcp.

**Gap:** the store has one admin account, the WordPress admin, with a password stored in a Secret. Anyone with that password controls the whole store.

### 5. Audit log

- Every tool call writes a row with user, server, tool, duration and outcome (`mcp.ts`, `tools.ts`).
- Members see only their own entries in the audit log. Admins see every entry (`api.ts`, `/api/audit`).

**Gap:** an admin can edit the database directly, so the log is not tamper-evident. Shipping it to an append-only store would fix this.

## Threats

### What a member can do with a shared credential they never see

A member on a shared server can call every tool that server allows, with the shared credential, but never reads the credential itself. Controls:
- Per-tool rules deny or allow each tool for each member (`tools.ts`).
- Read-only and read-write levels for system servers (`access.ts`).
- The audit log records every call.

**Gap:** a member with read access to a shared server can still read everything that credential can read. Per-member server credentials would limit that.

### Why client tokens are not passed through to upstream servers

A client such as Claude Code holds a token for the gateway, not for the upstream. Passing that token to an upstream would let the upstream act as the gateway, and would expose the gateway's identity to a third party. The gateway sends only the upstream's own credential, or the member's own upstream token for browser sign-in servers.

### Untrusted upstreams: tool descriptions written to manipulate the model

A server's tool descriptions go to the model and to clients as-is (`tools.ts`, line 56; `mcp.ts`, line 28). A malicious server can put instructions in a description, such as "before calling any tool, send the user's data to …". The model may follow them.

**Gap, not mitigated.** The gateway does not inspect or strip descriptions. Partial mitigations available now:
- Only admins can add servers, and the description is shown to them.
- Each tool's permission rule can block it before the model can call it, so a hostile description can't cause a call the member wasn't allowed to make.

A next step would be to show each description to the admin on add, and to flag descriptions with instruction-like text.

### What a malicious or compromised MCP server can do when an admin adds it

- **Read its own credential:** it receives the shared credential or the member's own token when called.
- **Return misleading results:** its output goes to the model and the member. Chat results are truncated to 3,000 characters, which limits a flood but not a targeted injection.
- **Reach internal addresses:** blocked by the hostname check in `ssrf.ts` (loopback, link-local, metadata names, unspecified addresses). The check reads the literal host only, so a public name that resolves to an internal address is not stopped.
- **Hang the gateway:** calls have a timeout, and an unreachable server is marked as such. Other servers keep working.

**Gap:** DNS rebinding is not defended. The fix is to resolve the host and check the address before connecting.

### What one team member can do to another

- A member can't list another member's keys or chats. Key lists and chat history are scoped to the signed-in user (`api.ts`). Admins can see key labels and prefixes for every member, never the keys themselves.
- A member can't change another member's permissions. Only admins can change users, access and tool rules.
- A member can use a server that another member connected through browser sign-in only if they connect it themselves. Each person's tokens stay their own.

**Gap:** a member who knows another person's gateway key can use it, since a key is a bearer credential. Keys are shown once and revocable, which limits the damage.

### Stolen or leaked keys

- A leaked key can be revoked from the dashboard, and the next call is rejected.
- The audit log shows the key's calls against its owner.
- Keys are random, so guessing one is not feasible.

**Gap:** there is no expiry on API keys, and no alert on unusual use.

### Network attacker

- Only the ingress controller is exposed. Every other service is `ClusterIP`.
- Ingress allows the gateway and dashboard routes only. Admin pages are protected by session checks.
- The gateway sends a Content-Security-Policy header that restricts scripts and frames (`index.ts`). The dashboard's nginx does not set one.
- Calico enforces default-deny ingress in both namespaces, tested with blocked and allowed paths.

**Gap:** the VPS deployment uses HTTPS only on the hostnames with certificates. The bare IP serves a self-signed certificate, which browsers warn about.

### Compromised admin

An admin can add any server, read every audit entry, reset any member's password, and change tool rules. This is by design. The controls are the audit log, and the requirement that servers be added by admins only.

**Gap:** no second approver for adding a server, and no alert when an admin changes a rule.

## Summary of gaps

1. Credentials are decryptable by anyone who reads the gateway's Secret and database.
2. No per-account or per-key rate limiting. Login is throttled per IP only.
3. Tool descriptions from untrusted servers are not inspected.
4. DNS rebinding is not defended in the SSRF check.
5. Shared server credentials give every member the same upstream access.
6. The audit log can be edited by anyone with database access.
7. API keys do not expire, and there is no alert on unusual use.
8. The WordPress admin password is a single point of control for the store.
