import { useEffect, useState } from "react";
import { api, type AuditRow } from "./api";
import { ClassBadge, Notice } from "./shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api<AuditRow[]>("GET", "/api/audit?limit=200").then(setRows).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-4">
      {error && <Notice tone="err">{error}</Notice>}
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Via</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(r.ts).toLocaleString()}</TableCell>
                <TableCell>{r.user_email}</TableCell>
                <TableCell>{r.server_slug}</TableCell>
                <TableCell>
                  <code className="text-xs">{r.tool}</code>
                </TableCell>
                <TableCell>{r.source}</TableCell>
                <TableCell className="whitespace-nowrap">{r.duration_ms} ms</TableCell>
                <TableCell title={r.error ?? ""}>
                  <ClassBadge value={r.outcome === "ok" ? "allowed" : r.outcome === "denied" ? "denied" : "blocked"} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
