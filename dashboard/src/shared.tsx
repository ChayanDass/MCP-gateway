// Small building blocks shared by every page: modal and confirmation dialogs,
// status badges, loading and empty states, and the labelled rows used on detail pages.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// A dialog over the page. Closes on Escape, on the backdrop, or the close button.
export function Modal({ title, subtitle, onClose, children, wide }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn("max-h-[85vh] overflow-y-auto", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

// A confirmation before anything destructive.
export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel, danger = true }: {
  open: boolean; title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type Tone = "ok" | "danger" | "warn" | "muted";
const TONE: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  danger: "bg-destructive/15 text-destructive",
  warn: "bg-warning-soft text-warning",
  muted: "text-muted-foreground",
};

// A status pill with a coloured dot.
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 border-transparent font-medium", TONE[tone])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </Badge>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "ok" },
  unreachable: { label: "Unreachable", tone: "danger" },
  disabled: { label: "Disabled", tone: "muted" },
  reconnect: { label: "Reconnect", tone: "warn" },
  not_connected: { label: "Not connected", tone: "muted" },
  unknown: { label: "Checking", tone: "muted" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.unknown;
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

// Access and tool-class labels, e.g. read / write / blocked.
export function ClassBadge({ value }: { value: string }) {
  const tone: Tone = value === "read" || value === "allowed" || value === "ok" ? "ok" : value === "write" || value === "denied" ? "warn" : value === "blocked" ? "danger" : "muted";
  return <Pill tone={tone}>{value}</Pill>;
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
      <p className="font-medium">{title}</p>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {action}
    </div>
  );
}

// A titled panel. Used for every block on a page.
export function Panel({ title, description, actions, children, className }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-4 py-5", className)}>
      {(title || actions) && (
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            {title && <CardTitle className="text-base">{title}</CardTitle>}
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

// A label and value pair, used on detail pages.
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

// The header of every page: title, a one-line hint, and optional actions.
export function PageHeader({ title, hint, actions }: { title: string; hint?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// A message line for success and error results.
export function Notice({ tone, children }: { tone: "ok" | "err"; children: ReactNode }) {
  return (
    <p className={cn("rounded-md border px-3 py-2 text-sm", tone === "ok" ? "border-success/30 bg-success-soft text-success" : "border-destructive/30 bg-destructive/10 text-destructive")}>
      {children}
    </p>
  );
}
