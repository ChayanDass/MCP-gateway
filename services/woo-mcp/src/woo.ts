import { createHmac, randomBytes } from "node:crypto";

// Thin client for the WooCommerce REST API (v3).
// Chosen over WP-CLI because it is HTTP-only (no exec into the WordPress pod),
// works the same locally and in production, and is the documented, stable
// integration surface for WooCommerce.

export interface WooConfig {
  baseUrl: string; // where requests are sent, e.g. http://wordpress/wp-json/wc/v3
  homeUrl: string; // the store's public home URL, e.g. http://store.localtest.me:8080
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
}

// RFC 3986 percent-encoding, as OAuth 1.0a requires (stricter than encodeURIComponent).
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// OAuth 1.0a request signing (HMAC-SHA256) as WooCommerce's REST API expects it.
// The signed parameters are added to the query string, which WooCommerce reads
// for every method. The request body is not part of the signature for JSON.
export function signOAuth1(method: string, url: URL, consumerKey: string, consumerSecret: string): URL {
  const params: [string, string][] = [];
  url.searchParams.forEach((v, k) => params.push([k, v]));
  const oauth: [string, string][] = [
    ["oauth_consumer_key", consumerKey],
    ["oauth_nonce", randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA256"],
    ["oauth_timestamp", String(Math.floor(Date.now() / 1000))],
    ["oauth_version", "1.0"],
  ];
  const all = [...params, ...oauth]
    .map(([k, v]): [string, string] => [rfc3986(k), rfc3986(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  const normalized = all.map(([k, v]) => `${k}=${v}`).join("&");
  const baseUrl = `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(normalized)].join("&");
  const signature = createHmac("sha256", `${rfc3986(consumerSecret)}&`).update(baseString).digest("base64");

  const signed = new URL(url.origin + url.pathname);
  for (const [k, v] of [...params, ...oauth]) signed.searchParams.append(k, v);
  signed.searchParams.append("oauth_signature", signature);
  return signed;
}

export class WooError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class WooClient {
  constructor(private readonly cfg: WooConfig) {}

  private async request<T>(method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<T> {
    const target = new URL(this.cfg.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") target.searchParams.set(k, String(v));
    }
    // WooCommerce rebuilds the signed URL from its configured home URL
    // (get_home_url) plus the request path, not from the Host header. So the
    // signature is computed against the home URL, while the request itself goes
    // to the in-cluster service. Only the path and query are sent.
    const signingUrl = new URL(this.cfg.homeUrl.replace(/\/$/, "") + "/wp-json/wc/v3" + path);
    signingUrl.search = target.search;
    const signed = signOAuth1(method, signingUrl, this.cfg.consumerKey, this.cfg.consumerSecret);
    const sendUrl = new URL(target.origin + target.pathname);
    sendUrl.search = signed.search;
    const res = await fetch(sendUrl, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        /* keep raw text */
      }
      throw new WooError(`WooCommerce ${method} ${path} failed: ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listProducts(params: { search?: string; per_page?: number }) {
    return this.request<WooProduct[]>("GET", "/products", { per_page: params.per_page ?? 20, search: params.search });
  }

  createProduct(params: { name: string; regular_price: string; description?: string; status?: string }) {
    return this.request<WooProduct>("POST", "/products", undefined, {
      name: params.name,
      regular_price: params.regular_price,
      description: params.description ?? "",
      status: params.status ?? "publish",
      type: "simple",
    });
  }

  listOrders(params: { status?: string; after?: string; per_page?: number }) {
    return this.request<WooOrder[]>("GET", "/orders", {
      status: params.status,
      after: params.after,
      per_page: params.per_page ?? 20,
      orderby: "date",
      order: "desc",
    });
  }

  getOrder(id: number) {
    return this.request<WooOrder>("GET", `/orders/${id}`);
  }

  updateOrderStatus(id: number, status: string) {
    return this.request<WooOrder>("PUT", `/orders/${id}`, undefined, { status });
  }
}

export interface WooProduct {
  id: number;
  name: string;
  status: string;
  regular_price: string;
  price: string;
  stock_status: string;
  permalink: string;
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  date_created: string;
  total: string;
  currency: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: { name: string; quantity: number; total: string }[];
}
