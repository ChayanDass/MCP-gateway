// Shared building blocks. Pages use these so buttons, status and empty states look the same everywhere.
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function Button({ variant = "secondary", size, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" }) {
  return <button className={`btn btn-${variant}${size === "sm" ? " btn-sm" : ""} ${className}`.trim() + ""} {...rest} />;
}

export type Status = "connected" | "unreachable" | "disabled" | "reconnect" | "not_connected" | "unknown";

const STATUS: Record<Status, { label: string; tone: "ok" | "danger" | "muted" | "warn" }> = {
  connected: { label: "Connected", tone: "ok" },
  unreachable: { label: "Unreachable", tone: "danger" },
  disabled: { label: "Disabled", tone: "muted" },
  reconnect: { label: "Reconnect", tone: "warn" },
  not_connected: { label: "Not connected", tone: "muted" },
  unknown: { label: "Checking", tone: "muted" },
};

export function StatusBadge({ status }: { status: Status | string }) {
  const s = STATUS[status as Status] ?? STATUS.unknown;
  return (
    <span className={`badge badge-${s.tone}`} role="status">
      <span className="badge-dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {body && <p className="empty-body">{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className="skeleton-line" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

// A confirmation before anything destructive. Escape cancels.
export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel, danger = true }: {
  open: boolean; title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onCancel} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="dialog-title">{title}</h3>
        <p className="muted">{body}</p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
