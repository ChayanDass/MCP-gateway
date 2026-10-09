import { config } from "./config.js";

// Admins can register arbitrary upstream URLs, so the gateway must not become
// a proxy into the cloud metadata service or the host's loopback interface.
// Denied: loopback, link-local (covers 169.254.169.254), cloud metadata names,
// and unspecified addresses. Cluster-internal service names are allowed,
// because the WooCommerce server lives there.
// Limitation: this checks the literal hostname only. It does not defend
// against DNS rebinding, which needs a resolver-level check.
const DENIED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

export function validateUpstreamUrl(raw: string, opts: { allowLoopback?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http or https");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (config.upstreamHostAllowlist.includes(host)) return url.toString();

  if (!opts.allowLoopback) {
    if (DENIED_HOSTS.has(host)) throw new Error(`Host ${host} is not allowed`);
    if (/^127\./.test(host) || host === "::1" || host === "0.0.0.0" || host === "::") {
      throw new Error("Loopback addresses are not allowed");
    }
    if (/^169\.254\./.test(host) || /^fe80:/i.test(host) || host === "fd00:ec2::254") {
      throw new Error("Link-local and metadata addresses are not allowed");
    }
  }
  return url.toString();
}
