import { describe, expect, it } from "vitest";
import { createXeroClient, parseXeroErrors, XeroApiError } from "./client";

type Step = Response | Error;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(steps: Step[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const sleeps: number[] = [];
  const tokens: boolean[] = [];
  const queue = [...steps];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string> });
    const s = queue.shift();
    if (!s) throw new Error("no more scripted responses");
    if (s instanceof Error) throw s;
    return s;
  }) as unknown as typeof fetch;
  const client = createXeroClient({
    fetch: fetchFn, tenantId: "tenant-1",
    getToken: async (force) => { tokens.push(!!force); return force ? "token-new" : "token-old"; },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { client, calls, sleeps, tokens };
}
const err = (p: Promise<unknown>) => p.then(() => null, (e) => e as XeroApiError);

describe("xero client", () => {
  it("sends the bearer token, tenant id and query, and returns the JSON", async () => {
    const t = setup([json(200, { Contacts: [] })]);
    expect(await t.client.get("/Contacts", { where: 'Name=="A"' })).toEqual({ Contacts: [] });
    expect(t.calls[0].url).toBe("https://api.xero.com/api.xro/2.0/Contacts?where=Name%3D%3D%22A%22");
    expect(t.calls[0].headers).toMatchObject({ authorization: "Bearer token-old", "xero-tenant-id": "tenant-1", accept: "application/json" });
    expect(t.calls[0].headers["idempotency-key"]).toBeUndefined();
  });

  it("sends the Idempotency-Key on PUT only", async () => {
    const t = setup([json(200, {}), json(200, {})]);
    await t.client.put("/Invoices", { json: { a: 1 }, idempotencyKey: "bill-1" });
    await t.client.get("/Invoices");
    expect(t.calls[0].headers["idempotency-key"]).toBe("bill-1");
    expect(t.calls[0].headers["content-type"]).toBe("application/json");
    expect(t.calls[1].headers["idempotency-key"]).toBeUndefined();
  });

  it("waits Retry-After on 429 and retries, even for PUT (a refused request is safe to repeat)", async () => {
    const t = setup([json(429, {}, { "retry-after": "2" }), json(200, { ok: true })]);
    expect(await t.client.put("/Invoices", { json: {}, idempotencyKey: "k" })).toEqual({ ok: true });
    expect(t.sleeps).toEqual([2000]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].headers["idempotency-key"]).toBe("k");
  });

  it("caps Retry-After and gives up after 3 retries with a clear error", async () => {
    const t = setup([1, 2, 3, 4].map(() => json(429, {}, { "retry-after": "999" })));
    const e = await err(t.client.get("/Accounts"));
    expect(e).toMatchObject({ kind: "rate_limited", status: 429 });
    expect(t.sleeps).toEqual([30000, 30000, 30000]);
  });

  it("does not retry the DAILY limit", async () => {
    const t = setup([json(429, {}, { "x-rate-limit-problem": "day", "retry-after": "50000" })]);
    const e = await err(t.client.get("/Accounts"));
    expect(e).toMatchObject({ kind: "rate_limited" });
    expect(t.calls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it("refreshes the token once on 401 and retries; a second 401 is an auth error", async () => {
    const ok = setup([json(401, {}), json(200, { fine: 1 })]);
    expect(await ok.client.get("/Accounts")).toEqual({ fine: 1 });
    expect(ok.tokens).toEqual([false, true]);
    expect(ok.calls[1].headers.authorization).toBe("Bearer token-new");
    const bad = setup([json(401, {}), json(401, {})]);
    expect(await err(bad.client.get("/Accounts"))).toMatchObject({ kind: "auth" });
    expect(bad.calls).toHaveLength(2);
  });

  it("retries GET on 5xx and network errors with exponential backoff", async () => {
    const t = setup([json(503, {}), new Error("socket"), json(200, { v: 1 })]);
    expect(await t.client.get("/Accounts")).toEqual({ v: 1 });
    expect(t.sleeps).toEqual([500, 1000]);
    const dead = setup([new Error("a"), new Error("b"), new Error("c"), new Error("d")]);
    expect(await err(dead.client.get("/Accounts"))).toMatchObject({ kind: "ambiguous" });
    expect(dead.calls).toHaveLength(4);
  });

  it("never retries a PUT after a 5xx or network error: the bill may exist, the caller must reconcile", async () => {
    const five = setup([json(500, {}), json(200, {})]);
    expect(await err(five.client.put("/Invoices", { json: {}, idempotencyKey: "k" }))).toMatchObject({ kind: "ambiguous", status: 500 });
    expect(five.calls).toHaveLength(1);
    const net = setup([new Error("timeout"), json(200, {})]);
    expect(await err(net.client.put("/Invoices", { json: {}, idempotencyKey: "k" }))).toMatchObject({ kind: "ambiguous" });
    expect(net.calls).toHaveLength(1);
  });

  it("turns a 400 into a 'rejected' error carrying Xero's validation messages, without the request body", async () => {
    const body = { Type: "ValidationException", Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code" }, { Message: "Description is required" }] }] };
    const t = setup([json(400, body)]);
    const e = await err(t.client.put("/Invoices", { json: { secret: "do-not-leak" }, idempotencyKey: "k" }));
    expect(e).toMatchObject({ kind: "rejected", status: 400, messages: ["Account code '999' is not a valid code", "Description is required"] });
    expect(e!.message).toContain("Account code '999'");
    expect(e!.message).not.toContain("do-not-leak");
  });

  it("explains a 403 as a scope or permission problem", async () => {
    const t = setup([json(403, { Title: "Forbidden", Detail: "AuthenticationUnsuccessful" })]);
    expect(await err(t.client.get("/Accounts"))).toMatchObject({ kind: "auth" });
  });
});

describe("parseXeroErrors", () => {
  it("reads validation errors, problem details and OAuth errors", () => {
    expect(parseXeroErrors({ Elements: [{ ValidationErrors: [{ Message: "A" }] }, { ValidationErrors: [{ Message: "B" }] }] })).toEqual(["A", "B"]);
    expect(parseXeroErrors({ Invoices: [{ ValidationErrors: [{ Message: "C" }] }] })).toEqual(["C"]);
    expect(parseXeroErrors({ Title: "Unauthorized", Detail: "TokenExpired" })).toEqual(["TokenExpired", "Unauthorized"]);
    expect(parseXeroErrors({ error: "invalid_grant" })).toEqual(["invalid_grant"]);
    expect(parseXeroErrors(null)).toEqual([]);
    expect(parseXeroErrors("text")).toEqual([]);
  });
});
