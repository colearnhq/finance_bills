import "server-only";
import { decryptSecret } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshAccessToken } from "./oauth";

export type Connection = { id: string; email: string; refresh_token_enc: string; connected_at: string };

/** The active (non-revoked) connection, or null. Reads a table that only the service role can see. */
export async function getActiveConnection(): Promise<Connection | null> {
  const { data } = await createAdminClient()
    .from("gmail_connections")
    .select("id,email,refresh_token_enc,connected_at")
    .is("revoked_at", null)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export class ReconnectRequired extends Error {}

export async function getAccessToken(conn: Connection): Promise<string> {
  try {
    return (await refreshAccessToken(decryptSecret(conn.refresh_token_enc))).access_token;
  } catch (e) {
    if ((e as { oauthError?: string }).oauthError === "invalid_grant") {
      await createAdminClient().from("gmail_connections").update({ revoked_at: new Date().toISOString() }).eq("id", conn.id);
      throw new ReconnectRequired("Akses Gmail sudah dicabut atau kedaluwarsa. Hubungkan ulang.");
    }
    throw e;
  }
}
