import "server-only";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshTokens, XeroReconnectRequired } from "./oauth";

export interface XeroConnection {
  id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  is_demo: boolean | null;
  available_tenants: { tenantId: string; tenantName: string }[];
  refresh_token_enc: string;
  refresh_token_issued_at: string;
  access_token_enc: string | null;
  access_token_expires_at: string | null;
  scope: string;
  connected_at: string;
}

const COLUMNS = "id,tenant_id,tenant_name,is_demo,available_tenants,refresh_token_enc,refresh_token_issued_at,access_token_enc,access_token_expires_at,scope,connected_at";
const MARGIN_MS = 60_000; // refresh a minute before the 30-minute access token ends

/** The active connection, or null. Reads a table that only the service role can see. */
export async function getActiveConnection(): Promise<XeroConnection | null> {
  const { data } = await createAdminClient().from("xero_connections").select(COLUMNS).is("revoked_at", null).limit(1).maybeSingle();
  return (data as XeroConnection | null) ?? null;
}

async function read(id: string): Promise<XeroConnection | null> {
  const { data } = await createAdminClient().from("xero_connections").select(COLUMNS).eq("id", id).is("revoked_at", null).maybeSingle();
  return (data as XeroConnection | null) ?? null;
}

const valid = (c: XeroConnection) => !!c.access_token_enc && !!c.access_token_expires_at && new Date(c.access_token_expires_at).getTime() - Date.now() > MARGIN_MS;

// One refresh at a time inside this server process. Xero rotates the refresh token on every refresh, so two parallel
// refreshes would fight over it.
const inflight = new Map<string, Promise<string>>();

/** A valid access token for the connection, refreshing (and saving the rotated refresh token) when needed. */
export function getAccessToken(connectionId: string, opts: { force?: boolean } = {}): Promise<string> {
  const running = inflight.get(connectionId);
  if (running) return running;
  const p = (async () => {
    const conn = await read(connectionId);
    if (!conn) throw new XeroReconnectRequired("Koneksi Xero tidak aktif. Hubungkan ulang.");
    if (!opts.force && valid(conn)) return decryptSecret(conn.access_token_enc!);

    let tokens;
    try {
      tokens = await refreshTokens(decryptSecret(conn.refresh_token_enc));
    } catch (e) {
      if ((e as { oauthError?: string }).oauthError === "invalid_grant") {
        await createAdminClient().from("xero_connections").update({ revoked_at: new Date().toISOString() }).eq("id", conn.id);
        throw new XeroReconnectRequired("Akses Xero sudah dicabut atau kedaluwarsa (refresh token berlaku 60 hari). Hubungkan ulang.");
      }
      throw e;
    }
    const now = Date.now();
    // Compare-and-swap on the old refresh token: if another process already rotated it, theirs wins and we use their access token.
    const { data, error } = await createAdminClient().from("xero_connections").update({
      refresh_token_enc: encryptSecret(tokens.refresh_token),
      refresh_token_issued_at: new Date(now).toISOString(),
      access_token_enc: encryptSecret(tokens.access_token),
      access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    }).eq("id", conn.id).eq("refresh_token_enc", conn.refresh_token_enc).select("id");
    if (error) throw new Error("Gagal menyimpan token Xero.");
    if (!data?.length) {
      const again = await read(conn.id);
      if (again && valid(again)) return decryptSecret(again.access_token_enc!);
      throw new Error("Token Xero sedang diperbarui proses lain. Coba lagi.");
    }
    return tokens.access_token;
  })().finally(() => inflight.delete(connectionId));
  inflight.set(connectionId, p);
  return p;
}

/** Days until the refresh token lapses if it is not used. Xero does not tell us, so it is 60 days from the last refresh. */
export function refreshDaysLeft(issuedAt: string, now: number = Date.now()): number {
  return Math.max(0, 60 - Math.floor((now - new Date(issuedAt).getTime()) / 86_400_000));
}
