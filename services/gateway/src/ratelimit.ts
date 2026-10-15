// Fixed one-minute window per identity. Each gateway replica keeps its own counts,
// so with N replicas the effective limit is up to N times the configured value.
const WINDOW_MS = 60_000;
const windows = new Map<string, { count: number; start: number }>();

export function takeToken(key: string, limit: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (windows.size > 10_000) {
    for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k);
  }
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { count: 0, start: now };
    windows.set(key, w);
  }
  w.count++;
  if (w.count > limit) return { ok: false, retryAfter: Math.ceil((w.start + WINDOW_MS - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}
