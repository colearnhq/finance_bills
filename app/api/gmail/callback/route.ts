import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { getProfileEmail } from "@/lib/gmail/api";
import { GMAIL_SCOPE, STATE_COOKIE, exchangeCode } from "@/lib/gmail/oauth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const back = (req: NextRequest, q: string) => NextResponse.redirect(new URL(`/inbox?${q}`, req.url));

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  if (!expected || p.get("state") !== expected) return back(request, "error=state");
  const code = p.get("code");
  if (!code) return back(request, "error=denied");

  try {
    const tokens = await exchangeCode(code, request.nextUrl.origin);
    if (!tokens.refresh_token) return back(request, "error=no_refresh");
    if (!tokens.scope?.includes(GMAIL_SCOPE)) return back(request, "error=scope");
    const email = await getProfileEmail(tokens.access_token);
    const { data: user } = await (await createClient()).auth.getUser();

    // Only one mailbox is active: revoke others, then upsert this one.
    const admin = createAdminClient();
    await admin.from("gmail_connections").update({ revoked_at: new Date().toISOString() }).neq("email", email).is("revoked_at", null);
    const { error } = await admin.from("gmail_connections").upsert(
      { email, refresh_token_enc: encryptSecret(tokens.refresh_token), scope: tokens.scope, connected_by: user.user?.id ?? null, connected_at: new Date().toISOString(), revoked_at: null },
      { onConflict: "email" },
    );
    if (error) return back(request, "error=save");
    const res = back(request, "connected=1");
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/gmail" });
    return res;
  } catch {
    return back(request, "error=oauth"); // details deliberately not logged or shown: they may contain secrets
  }
}
