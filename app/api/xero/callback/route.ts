import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getOrganisation } from "@/lib/xero/api";
import { createXeroClient } from "@/lib/xero/client";
import { REQUIRED_SCOPE, STATE_COOKIE, exchangeCode, listTenants } from "@/lib/xero/oauth";

const back = (req: NextRequest, q: string) => NextResponse.redirect(new URL(`/xero-bills?${q}`, req.url));

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  if (!expected || p.get("state") !== expected) return back(request, "xero_error=state");
  const code = p.get("code");
  if (!code) return back(request, "xero_error=denied");

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) return back(request, "xero_error=no_refresh");
    if (!tokens.scope?.split(" ").includes(REQUIRED_SCOPE)) return back(request, "xero_error=scope");
    const tenants = await listTenants(tokens.access_token);
    if (tenants.length === 0) return back(request, "xero_error=no_org");
    const { data: user } = await (await createClient()).auth.getUser();

    // The org name and demo flag come from Xero itself (needed to refuse production writes by default).
    let pick: { tenantId: string; tenantName: string } | null = null;
    let isDemo: boolean | null = null;
    if (tenants.length === 1) {
      pick = tenants[0];
      const org = await getOrganisation(createXeroClient({ fetch, tenantId: pick.tenantId, getToken: async () => tokens.access_token, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })).catch(() => null);
      isDemo = typeof org?.IsDemoCompany === "boolean" ? org.IsDemoCompany : null;
      if (org?.Name) pick = { tenantId: pick.tenantId, tenantName: org.Name };
    }

    // Only one connection is active at a time.
    const admin = createAdminClient();
    await admin.from("xero_connections").update({ revoked_at: new Date().toISOString() }).is("revoked_at", null);
    const now = Date.now();
    const { error } = await admin.from("xero_connections").insert({
      tenant_id: pick?.tenantId ?? null,
      tenant_name: pick?.tenantName ?? null,
      is_demo: isDemo,
      available_tenants: tenants.map((t) => ({ tenantId: t.tenantId, tenantName: t.tenantName })),
      refresh_token_enc: encryptSecret(tokens.refresh_token),
      refresh_token_issued_at: new Date(now).toISOString(),
      access_token_enc: encryptSecret(tokens.access_token),
      access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
      scope: tokens.scope ?? "",
      connected_by: user.user?.id ?? null,
    });
    if (error) return back(request, "xero_error=save");
    const res = back(request, pick ? "xero=connected" : "xero=choose");
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/xero" });
    return res;
  } catch {
    return back(request, "xero_error=oauth"); // details deliberately not shown or logged: they may contain secrets
  }
}
