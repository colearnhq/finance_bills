import "server-only";

/**
 * Granular scopes (Xero requires them for apps created since 2 March 2026). Least privilege:
 *  - contacts are only READ: a vendor that is missing in Xero blocks the bill instead of being created from a name;
 *  - settings are only READ (accounts, tax rates, tracking categories, organisation);
 *  - invoices are read+write (draft bills), attachments are read+write (the PDF).
 * Verify the exact names in the Developer Portal if Xero reports an invalid scope.
 */
export const XERO_SCOPES = ["offline_access", "accounting.invoices", "accounting.contacts.read", "accounting.settings.read", "accounting.attachments"];
export const REQUIRED_SCOPE = "accounting.invoices";
export const STATE_COOKIE = "xero_oauth_state";

const AUTHORIZE = "https://login.xero.com/identity/connect/authorize";
const TOKEN = "https://identity.xero.com/connect/token";
const CONNECTIONS = "https://api.xero.com/connections";

export const xeroConfigured = () =>
  !!(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET && process.env.XERO_REDIRECT_URI && process.env.TOKEN_ENCRYPTION_KEY);

/** Writes to a non-demo organisation stay off until this is explicitly set (project rule: no production writes without authorisation). */
export const productionWritesAllowed = () => process.env.XERO_ALLOW_PRODUCTION_WRITES === "true";

export function authUrl(state: string): string {
  const u = new URL(AUTHORIZE);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: process.env.XERO_CLIENT_ID!,
    redirect_uri: process.env.XERO_REDIRECT_URI!,
    scope: XERO_SCOPES.join(" "),
    state,
  }).toString();
  return u.toString();
}

export interface TokenSet { access_token: string; refresh_token: string; expires_in: number; scope?: string; token_type?: string }
export class XeroReconnectRequired extends Error {}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Only the error CODE is kept: the body can echo parts of the request.
    throw Object.assign(new Error(`OAuth: ${typeof j.error === "string" ? j.error : res.status}`), { oauthError: typeof j.error === "string" ? (j.error as string) : undefined });
  }
  return j as TokenSet;
}

export const exchangeCode = (code: string) => tokenRequest({ grant_type: "authorization_code", code, redirect_uri: process.env.XERO_REDIRECT_URI! });
export const refreshTokens = (refreshToken: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

export interface Tenant { tenantId: string; tenantName: string; tenantType?: string }

export async function listTenants(accessToken: string): Promise<Tenant[]> {
  const res = await fetch(CONNECTIONS, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Xero connections: HTTP ${res.status}`);
  const j = (await res.json()) as { tenantId?: string; tenantName?: string; tenantType?: string }[];
  return j.filter((t) => t.tenantId && (t.tenantType ?? "ORGANISATION") === "ORGANISATION").map((t) => ({ tenantId: t.tenantId!, tenantName: t.tenantName ?? "(tanpa nama)", tenantType: t.tenantType }));
}
