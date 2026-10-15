// Counters for the gateway, rendered in the Prometheus text format at /metrics.
// /metrics is served on the gateway's port but is not routed by the ingress, so
// only pods inside the cluster can scrape it.
const toolCalls = new Map<string, number>(); // "server|outcome" -> count
const latency = new Map<string, { sum: number; count: number }>(); // server -> seconds
const limited = new Map<string, number>(); // scope -> count

export function recordToolCall(server: string, outcome: string, durationMs: number): void {
  const key = `${server}|${outcome}`;
  toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
  const l = latency.get(server) ?? { sum: 0, count: 0 };
  l.sum += durationMs / 1000;
  l.count += 1;
  latency.set(server, l);
}

export function recordRateLimited(scope: string): void {
  limited.set(scope, (limited.get(scope) ?? 0) + 1);
}

export function renderMetrics(upstreamStatus: { slug: string; status: string }[]): string {
  const out: string[] = [];
  out.push("# HELP kmcp_tool_calls_total Tool calls through the gateway, by server and outcome.", "# TYPE kmcp_tool_calls_total counter");
  for (const [k, n] of toolCalls) {
    const [server, outcome] = k.split("|");
    out.push(`kmcp_tool_calls_total{server="${server}",outcome="${outcome}"} ${n}`);
  }
  out.push("# HELP kmcp_tool_call_duration_seconds Time spent in tool calls, by server.", "# TYPE kmcp_tool_call_duration_seconds summary");
  for (const [server, l] of latency) {
    out.push(`kmcp_tool_call_duration_seconds_sum{server="${server}"} ${l.sum.toFixed(3)}`);
    out.push(`kmcp_tool_call_duration_seconds_count{server="${server}"} ${l.count}`);
  }
  out.push("# HELP kmcp_rate_limited_total Requests refused by the rate limiter.", "# TYPE kmcp_rate_limited_total counter");
  for (const [scope, n] of limited) out.push(`kmcp_rate_limited_total{scope="${scope}"} ${n}`);
  out.push("# HELP kmcp_upstream_up 1 when the upstream answered its last health check.", "# TYPE kmcp_upstream_up gauge");
  for (const u of upstreamStatus) out.push(`kmcp_upstream_up{server="${u.slug}"} ${u.status === "connected" ? 1 : 0}`);
  return out.join("\n") + "\n";
}
