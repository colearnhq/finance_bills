/**
 * Minimal HTTP client for the Xero Accounting API. Dependencies (fetch, token source, sleep) are injected so the
 * retry rules can be tested without Xero. It never logs, and error messages never contain request bodies or tokens.
 *
 * Retry rules (see Xero's rate limit and idempotency docs):
 *  - 429: the request was refused, so retrying is safe for every method. Wait Retry-After (capped); a DAILY limit is not retried.
 *  - 401: refresh the access token once and retry.
 *  - GET: network errors and 5xx are retried with exponential backoff.
 *  - PUT/POST: a network error, timeout or 5xx is AMBIGUOUS (the bill may exist). It is NOT retried here; the caller
 *    reconciles by looking the bill up before it ever tries again.
 */
export type XeroErrorKind = "rejected" | "ambiguous" | "auth" | "rate_limited";

export class XeroApiError extends Error {
  constructor(public kind: XeroErrorKind, message: string, public status?: number, public messages: string[] = []) {
    super(message);
    this.name = "XeroApiError";
  }
}

export interface XeroHttpDeps {
  fetch: typeof fetch;
  getToken: (forceRefresh?: boolean) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  tenantId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string>;
  json?: unknown;
  body?: Uint8Array;
  contentType?: string;
  idempotencyKey?: string;
}

const DEFAULT_BASE = "https://api.xero.com/api.xro/2.0";
const MAX_RETRY_AFTER_MS = 30_000;

/** Every human-readable message Xero put in an error body (validation errors, problem details, OAuth errors). */
export function parseXeroErrors(body: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === "string" && v.trim()) out.push(v.trim().slice(0, 300)); };
  const walk = (o: unknown, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    const r = o as Record<string, unknown>;
    if (Array.isArray(r.ValidationErrors)) r.ValidationErrors.forEach((e) => add((e as { Message?: unknown })?.Message));
    for (const k of ["Elements", "Invoices", "Attachments"]) if (Array.isArray(r[k])) walk(r[k], depth + 1);
    if (!out.length) { add(r.Message); add(r.Detail); add(r.Title); add(r.error_description); add(r.error); }
  };
  walk(body);
  return [...new Set(out)];
}

export function createXeroClient(deps: XeroHttpDeps) {
  const base = deps.baseUrl ?? DEFAULT_BASE;

  async function request<T>(method: "GET" | "PUT" | "POST", path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    let forced = false;
    let tries429 = 0;
    let triesNet = 0;
    for (;;) {
      const token = await deps.getToken(forced);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, "xero-tenant-id": deps.tenantId, accept: "application/json" };
      if (opts.json !== undefined) headers["content-type"] = "application/json";
      if (opts.body) headers["content-type"] = opts.contentType ?? "application/octet-stream";
      if (opts.idempotencyKey && method !== "GET") headers["idempotency-key"] = opts.idempotencyKey;

      let res: Response;
      try {
        res = await deps.fetch(url, {
          method, headers, cache: "no-store", signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
          body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body ? (opts.body as BodyInit) : undefined,
        });
      } catch {
        if (method === "GET" && triesNet < 3) { await deps.sleep(500 * 2 ** triesNet++); continue; }
        throw new XeroApiError("ambiguous", "Tidak ada jawaban dari Xero (jaringan atau batas waktu).");
      }

      if (res.status === 401 && !forced) { forced = true; continue; }
      if (res.status === 429) {
        if (res.headers.get("x-rate-limit-problem")?.toLowerCase() === "day") throw new XeroApiError("rate_limited", "Batas panggilan harian Xero tercapai. Coba lagi besok.", 429);
        if (tries429++ < 3) {
          const s = Number(res.headers.get("retry-after"));
          await deps.sleep(Math.min(Number.isFinite(s) && s > 0 ? s * 1000 : 5_000, MAX_RETRY_AFTER_MS));
          continue;
        }
        throw new XeroApiError("rate_limited", "Xero membatasi jumlah panggilan per menit. Coba lagi sebentar lagi.", 429);
      }
      if (res.status >= 500) {
        if (method === "GET" && triesNet < 3) { await deps.sleep(500 * 2 ** triesNet++); continue; }
        throw new XeroApiError("ambiguous", `Xero menjawab dengan kesalahan server (${res.status}).`, res.status);
      }
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!res.ok) {
        const messages = parseXeroErrors(json);
        const kind: XeroErrorKind = res.status === 401 || res.status === 403 ? "auth" : "rejected";
        const hint = res.status === 403 ? "Akses ditolak (periksa scope dan izin pengguna Xero)." : res.status === 401 ? "Sesi Xero tidak valid. Hubungkan ulang." : "Xero menolak permintaan.";
        throw new XeroApiError(kind, messages.length ? `${hint} ${messages.join(" | ")}` : `${hint} (HTTP ${res.status})`, res.status, messages);
      }
      return json as T;
    }
  }

  return {
    get: <T>(path: string, query?: Record<string, string>) => request<T>("GET", path, { query }),
    put: <T>(path: string, opts: RequestOptions) => request<T>("PUT", path, opts),
    post: <T>(path: string, opts: RequestOptions) => request<T>("POST", path, opts),
  };
}

export type XeroClient = ReturnType<typeof createXeroClient>;
