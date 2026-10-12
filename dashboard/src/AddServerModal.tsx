import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type ServerView } from "./api";
import type { Provider } from "./ProvidersPanel";
import { Modal, Notice } from "./shared";
import { ProviderFormModal } from "./ProvidersPanel";
import { Logo } from "./Logo";
import { cn } from "@/lib/utils";

type Auth = "none" | "oauth";

// Add or edit an MCP server. Shared servers take an optional header credential;
// browser sign-in servers take a provider, and each member connects their own account.
export function AddServerModal({
  server,
  providers,
  onSaved,
  onClose,
  onProvidersChanged,
}: {
  server: ServerView | null;
  providers: Provider[];
  onSaved: () => void;
  onClose: () => void;
  onProvidersChanged?: () => void;
}) {
  const [addingProvider, setAddingProvider] = useState(false);
  const editing = server !== null;
  const [auth, setAuth] = useState<Auth>(server?.authMode === "oauth" ? "oauth" : "none");
  const [form, setForm] = useState({
    slug: server?.slug ?? "",
    name: server?.name ?? "",
    url: server?.url ?? "",
    authHeader: server?.authHeader ?? "",
    credential: "",
    providerId: server?.providerId ?? "",
    enabled: server?.enabled ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  // When a provider was just created, select it as soon as the list has it.
  useEffect(() => {
    if (!pendingSlug) return;
    const found = providers.find((p) => p.slug === pendingSlug);
    if (found) {
      setForm((f) => ({ ...f, providerId: found.id }));
      setPendingSlug(null);
    }
  }, [providers, pendingSlug]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing && server) {
        const body: Record<string, unknown> = { name: form.name, url: form.url, enabled: form.enabled };
        if (auth === "none") {
          body.authHeader = form.authHeader;
          if (form.credential) body.credential = form.credential;
        }
        await api("PATCH", `/api/servers/${server.id}`, body);
      } else {
        const body: Record<string, unknown> = { slug: form.slug, name: form.name, url: form.url, enabled: form.enabled };
        if (auth === "oauth") {
          body.authMode = "oauth";
          body.providerId = form.providerId;
        } else {
          body.authHeader = form.authHeader;
          body.credential = form.credential;
        }
        await api("POST", "/api/servers", body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        title={editing ? `Edit ${server?.name}` : "Add an MCP server"}
        subtitle={editing ? "Change the name, address or access settings." : "Choose how members sign in, then give the server's address."}
        onClose={onClose}
        wide
      >
        <form onSubmit={save} className="space-y-5">
          {!editing && (
            <div className="space-y-2">
              <Label>How members sign in</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Choice selected={auth === "none"} onClick={() => setAuth("none")} title="Shared" body="No sign-in, or one header credential that everyone shares." />
                <Choice selected={auth === "oauth"} onClick={() => setAuth("oauth")} title="Browser sign-in" body="Each member connects their own account through a provider." />
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {!editing && (
              <Field label="Slug">
                <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} pattern="[a-z0-9-]{2,40}" required placeholder="notion" />
              </Field>
            )}
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <div className="sm:col-span-2">
              <Field label="URL (Streamable HTTP)">
                <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" required />
              </Field>
            </div>
          </div>

          {auth === "none" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Header name (optional)">
                <Input value={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.value })} placeholder="Authorization" />
              </Field>
              <Field label="Credential (optional)">
                <Input type="password" value={form.credential} onChange={(e) => setForm({ ...form, credential: e.target.value })} placeholder={editing ? "leave blank to keep" : "Bearer token or header value"} autoComplete="off" />
              </Field>
            </div>
          )}

          {auth === "oauth" && !editing && (
            <div className="space-y-2">
              <Label>Provider</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                {providers.map((p) => (
                  <Choice
                    key={p.id}
                    selected={form.providerId === p.id}
                    onClick={() => setForm({ ...form, providerId: p.id })}
                    icon={<Logo id={p.slug} size={28} />}
                    title={p.name}
                    body={p.hasSecret && p.clientId ? "Ready" : "Missing credentials"}
                  />
                ))}
                <Choice onClick={() => setAddingProvider(true)} title="Add provider" body="Set up a new sign-in service" dashed />
              </div>
              {providers.length === 0 && <p className="text-sm text-muted-foreground">No providers yet. Add one to continue.</p>}
            </div>
          )}

          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              Turned on
            </label>
          )}

          {error && <Notice tone="err">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || (auth === "oauth" && !editing && !form.providerId)}>
              {busy ? "Saving…" : editing ? "Save changes" : "Add server"}
            </Button>
          </div>
        </form>
      </Modal>
      {addingProvider && (
        <ProviderFormModal
          provider={null}
          onClose={() => setAddingProvider(false)}
          onSaved={(slug) => {
            // Select the new provider once the list refreshes.
            setAddingProvider(false);
            onProvidersChanged?.();
            setPendingSlug(slug);
          }}
        />
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Choice({ selected, onClick, title, body, icon, dashed }: { selected?: boolean; onClick: () => void; title: string; body: string; icon?: React.ReactNode; dashed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors hover:border-primary/60",
        selected && "border-primary bg-accent",
        dashed && "border-dashed",
      )}
    >
      {icon && <span className="mb-1">{icon}</span>}
      <span className="font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{body}</span>
    </button>
  );
}
