import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "./api";
import { copyText } from "./connect";
import { Modal, Notice, Pill } from "./shared";

export interface Provider {
  id: string;
  slug: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  scopeParam: "scope" | "user_scope";
  pkce: boolean;
  tokenPath: string;
  clientId: string;
  hasSecret: boolean;
  redirectUri: string;
}

const EMPTY = {
  name: "",
  slug: "",
  authorizeUrl: "",
  tokenUrl: "",
  scopes: "",
  scopeParam: "scope" as "scope" | "user_scope",
  pkce: true,
  tokenPath: "access_token",
  clientId: "",
  clientSecret: "",
};

// The provider form in a window. Used on the providers page and from the add-server
// window, so an admin can create a provider without leaving the server they're adding.
export function ProviderFormModal({ provider, onSaved, onClose }: { provider: Provider | null; onSaved: (slug: string) => void; onClose: () => void }) {
  const editing = provider?.slug ?? null;
  const [form, setForm] = useState(() =>
    provider
      ? { ...EMPTY, name: provider.name, slug: provider.slug, authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scopes: provider.scopes, scopeParam: provider.scopeParam, pkce: provider.pkce, tokenPath: provider.tokenPath, clientId: provider.clientId, clientSecret: "" }
      : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY, v: string | boolean) => setForm({ ...form, [k]: v });

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editing) {
        const body: Record<string, unknown> = { ...form };
        if (!form.clientSecret) delete body.clientSecret;
        await api("PUT", `/api/oauth-providers/${editing}`, body);
      } else {
        await api("POST", "/api/oauth-providers", form);
      }
      onSaved(form.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the provider");
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${provider?.name}` : "Add a sign-in provider"}
      subtitle="Create the app in the provider, then paste its client ID and secret here. You can copy the redirect address after saving."
      onClose={onClose}
      wide
    >
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="p-name" label="Name">
            <Input id="p-name" value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Notion" />
          </Field>
          <Field id="p-slug" label="Slug">
            <Input id="p-slug" value={form.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} required disabled={!!editing} pattern="[a-z0-9-]{2,40}" placeholder="notion" />
          </Field>
          <div className="sm:col-span-2">
            <Field id="p-auth" label="Authorize URL">
              <Input id="p-auth" value={form.authorizeUrl} onChange={(e) => set("authorizeUrl", e.target.value)} required placeholder="https://provider.example/oauth/authorize" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field id="p-token" label="Token URL">
              <Input id="p-token" value={form.tokenUrl} onChange={(e) => set("tokenUrl", e.target.value)} required placeholder="https://provider.example/oauth/token" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field id="p-scopes" label="Scopes (comma-separated)">
              <Input id="p-scopes" value={form.scopes} onChange={(e) => set("scopes", e.target.value)} placeholder="read write" />
            </Field>
          </div>
          <Field id="p-client" label="Client ID">
            <Input id="p-client" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} required={!editing} />
          </Field>
          <Field id="p-secret" label="Client secret">
            <Input id="p-secret" type="password" value={form.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} required={!editing} placeholder={editing ? "leave blank to keep" : ""} autoComplete="off" />
          </Field>
          <Field id="p-scopeparam" label="Scope parameter">
            <Input id="p-scopeparam" value={form.scopeParam} onChange={(e) => set("scopeParam", e.target.value)} placeholder="scope or user_scope" />
          </Field>
          <Field id="p-tokenpath" label="Token field in the response">
            <Input id="p-tokenpath" value={form.tokenPath} onChange={(e) => set("tokenPath", e.target.value)} placeholder="access_token" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={form.pkce} onCheckedChange={(v) => set("pkce", v === true)} />
          Use PKCE (turn off if the provider rejects it)
        </label>
        {error && <Notice tone="err">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit">{editing ? "Save provider" : "Add provider"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

// Sign-in providers: the services members sign in to. Each one stores its client ID
// and encrypted secret. Lives on its own page under Settings.
export function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => api<Provider[]>("GET", "/api/oauth-providers").then(setProviders).catch((e) => setStatus({ kind: "err", text: e.message }));
  useEffect(() => {
    load();
  }, []);

  async function remove(p: Provider) {
    if (!window.confirm(`Delete ${p.name}? Servers that use it stop working until you pick another provider.`)) return;
    try {
      await api("DELETE", `/api/oauth-providers/${p.slug}`);
      load();
    } catch (err) {
      setStatus({ kind: "err", text: err instanceof Error ? err.message : "Could not delete" });
    }
  }

  function close() {
    setOpen(false);
    setEditing(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Create the app in the provider, then paste its client ID and secret here. Paste the redirect address into the app's settings.</p>
        <Button
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          Add provider
        </Button>
      </div>

      {status && <Notice tone={status.kind === "ok" ? "ok" : "err"}>{status.text}</Notice>}
      {providers && providers.length === 0 && <p className="text-sm text-muted-foreground">No providers yet.</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {providers?.map((p) => (
          <Card key={p.id} className="gap-3 py-5">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">{p.name}</CardTitle>
              <Pill tone={p.hasSecret && p.clientId ? "ok" : "warn"}>{p.hasSecret && p.clientId ? "Ready" : "Missing credentials"}</Pill>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-xs text-muted-foreground">
                <code>{p.slug}</code> · {p.pkce ? "PKCE" : "no PKCE"} · <code>{p.scopeParam}</code>
              </div>
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
                <code className="min-w-0 flex-1 truncate text-xs">{p.redirectUri}</code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setCopied((await copyText(p.redirectUri)) ? p.slug : null);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  {copied === p.slug ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setEditing(p); setOpen(true); }}>
                  Edit
                </Button>
                <Button variant="destructive" size="sm" onClick={() => remove(p)}>
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {open && (
        <ProviderFormModal
          provider={editing}
          onSaved={() => {
            close();
            load();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
