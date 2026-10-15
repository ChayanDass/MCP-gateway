import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "./api";
import { ConfirmDialog, EmptyState, Modal, Notice, Pill, type Tone } from "./shared";

export interface StoreView {
  id: string;
  name: string;
  slug: string;
  status: "provisioning" | "ready" | "failed" | "deleting";
  error: string | null;
  url: string;
  created_at: string;
}

const STATUS: Record<StoreView["status"], { label: string; tone: Tone }> = {
  provisioning: { label: "Provisioning", tone: "warn" },
  ready: { label: "Ready", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  deleting: { label: "Deleting", tone: "muted" },
};

// Each store is its own WooCommerce install on the cluster, in its own namespace, with its
// own MCP server registered in the gateway. The list refreshes while anything is in progress.
export function StoresPage() {
  const [stores, setStores] = useState<StoreView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<StoreView | null>(null);

  function load() {
    api<StoreView[]>("GET", "/api/stores").then(setStores).catch((e) => setError(e.message));
  }
  useEffect(load, []);

  const working = stores?.some((s) => s.status === "provisioning" || s.status === "deleting") ?? false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [working]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/stores", { name });
      setName("");
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the store");
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, method: "POST" | "DELETE") {
    setError(null);
    try {
      await api(method, path);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Create a store and the gateway connects it automatically. Each store's tools are named after the store.</p>
        <Button onClick={() => setCreating(true)}>New store</Button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      {stores && stores.length === 0 && <EmptyState title="No stores yet" body="Create one. It takes a few minutes to install WordPress and WooCommerce." />}

      {stores && stores.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">{s.slug}</div>
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    <Pill tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Pill>
                    {s.error && <div className="mt-1 text-xs text-muted-foreground">{s.error}</div>}
                  </TableCell>
                  <TableCell>
                    {s.status === "ready" ? (
                      <a className="text-sm underline" href={s.url} target="_blank" rel="noreferrer">
                        {s.url}
                      </a>
                    ) : (
                      <span className="text-sm text-muted-foreground">{s.url}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(s.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {s.status === "failed" && (
                        <Button variant="outline" size="sm" onClick={() => act(`/api/stores/${s.id}/retry`, "POST")}>
                          Retry
                        </Button>
                      )}
                      <Button variant="destructive" size="sm" disabled={s.status === "deleting"} onClick={() => setConfirm(s)}>
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && (
        <Modal title="New store" subtitle="The store installs in its own namespace with its own database and volumes." onClose={() => setCreating(false)}>
          <form className="space-y-4" onSubmit={create}>
            <div className="space-y-2">
              <Label htmlFor="store-name">Store name</Label>
              <Input id="store-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Outlet" minLength={2} maxLength={40} required />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create store"}</Button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={`Delete ${confirm?.name ?? "this store"}?`}
        body="Its database, files, orders and MCP connection are removed. This cannot be undone."
        confirmLabel="Delete store"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) void act(`/api/stores/${confirm.id}`, "DELETE");
          setConfirm(null);
        }}
      />
    </div>
  );
}
