// Counters for the gateway, rendered in the Prometheus text format at /metrics.
// /metrics is served on the gateway's port but is not routed by the ingress, so
// only pods inside the cluster can scrape it.
const toolCalls = new Map<string, number>(); // "server|outcome" -> count
const latency = new Map<string, { sum: number; count: number }>(); // server -> seconds
const limited = new Map<string, number>(); // scope -> count
const requestBuckets = [0.1, 0.3, 1, 3, 10];
const httpRequests = new Map<string, { count: number; sum: number; buckets: number[] }>();

export function recordHttpRequest(method: string, route: string, status: number, durationMs: number): void {
  const key = `${method}|${route}|${Math.floor(status / 100)}xx`;
  const metric = httpRequests.get(key) ?? { count: 0, sum: 0, buckets: requestBuckets.map(() => 0) };
  const seconds = durationMs / 1000;
  metric.count += 1;
  metric.sum += seconds;
  requestBuckets.forEach((bound, index) => { if (seconds <= bound) metric.buckets[index] += 1; });
  httpRequests.set(key, metric);
}

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

export function renderMetrics(upstreamStatus: { slug: string; status: string }[], upstreamStatusCollectionError = false): string {
  const out: string[] = [];
  out.push("# HELP kmcp_metrics_upstream_status_collection_error 1 when upstream status could not be collected.", "# TYPE kmcp_metrics_upstream_status_collection_error gauge");
  out.push(`kmcp_metrics_upstream_status_collection_error ${upstreamStatusCollectionError ? 1 : 0}`);
  out.push("# HELP kmcp_http_requests_total Completed HTTP requests by method, route template, and status class.", "# TYPE kmcp_http_requests_total counter");
  for (const [key, metric] of httpRequests) {
    const [method, route, status] = key.split("|");
    out.push(`kmcp_http_requests_total{method="${method}",route="${route}",status="${status}"} ${metric.count}`);
  }
  out.push("# HELP kmcp_http_request_duration_seconds HTTP request duration in seconds.", "# TYPE kmcp_http_request_duration_seconds histogram");
  for (const [key, metric] of httpRequests) {
    const [method, route, status] = key.split("|");
    requestBuckets.forEach((bound, index) => {
      out.push(`kmcp_http_request_duration_seconds_bucket{method="${method}",route="${route}",status="${status}",le="${bound}"} ${metric.buckets[index]}`);
    });
    out.push(`kmcp_http_request_duration_seconds_bucket{method="${method}",route="${route}",status="${status}",le="+Inf"} ${metric.count}`);
    out.push(`kmcp_http_request_duration_seconds_sum{method="${method}",route="${route}",status="${status}"} ${metric.sum.toFixed(3)}`);
    out.push(`kmcp_http_request_duration_seconds_count{method="${method}",route="${route}",status="${status}"} ${metric.count}`);
  }
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
