# Roadmap

Priorities: **P0** blocks the assignment or breaks something users rely on. **P1** needed for a complete submission. **P2** polish and stretch items.

## Done
- WooCommerce store, WooCommerce MCP server (five tools), gateway with aggregation, routing and audit log.
- Roles, per-user keys (hashed), per-member and per-tool permissions, MCP OAuth server, per-member OAuth for GitHub and Slack.
- Chat agent with saved conversations and error reasoning.
- Helm charts (`store`, `mcp`, `gateway`, `ingress`, umbrella `stack`), dev and prod values.
- AWS k3s with HTTPS (Let's Encrypt on hostnames, self-signed on the bare IP), GitOps with Argo CD, image and chart publishing to GHCR.
- Test workflow: builds, chart lint and render, script checks, Kind install on `main`.
- Dashboard: light and dark themes, shared components, status badges, confirmation dialogs, crash and retry screens, failure notifications.

## P0: needed before the demo
- [ ] Run the full definition-of-done flow on AWS with two users: store checkout, chat product creation, external client with a member key, key revocation, server disable, pod kill, audit attribution.
- [ ] Register two more upstream servers (the requirement is three). Pick public, keyless MCP servers.
- [ ] Check that the chat agent lists only the tools each user may call.

## P1: needed for a complete submission
- [ ] `README.md`: VPS setup, how to place an order, how to connect an external MCP client, how to use the chat.
- [ ] `docs/SYSTEM-DESIGN.md`: components, tool aggregation and routing, collision scheme (`slug__tool`), timeouts, dead-upstream handling, what changes for production.
- [ ] `docs/THREAT-MODEL.md`: shared upstream credentials, why client tokens are not passed upstream, untrusted tool descriptions, what one member can do to another.
- [ ] `docs/UPGRADE.md`: Helm and Argo CD upgrade and rollback steps.
- [ ] Demo video (you record it).

## P1: dashboard
- [ ] Apply the shared components to the audit, tool permissions, providers and model pages.
- [ ] Paging and search on the audit log and the member list (needs gateway support).
- [ ] Check the light theme in a browser.
- [ ] Keyboard and screen-reader pass on the sidebar, dialogs and tables.

## P2: stretch
- [ ] Hosted MCP servers from a container image, with their own Secret, limits and NetworkPolicy.
- [ ] Tool search, so ten servers do not mean hundreds of tools in one prompt.
- [ ] Metrics per server (calls, errors, latency) and rate limits per key.
- [ ] Multi-store provisioning (bonus).
