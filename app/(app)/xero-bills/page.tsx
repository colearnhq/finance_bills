import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildXeroBill, fingerprint } from "@/lib/xero/bill";
import { getActiveConnection, refreshDaysLeft } from "@/lib/xero/connection";
import { loadBills, loadScheduleContext } from "@/lib/xero/load";
import { productionWritesAllowed, xeroConfigured } from "@/lib/xero/oauth";
import type { SyncRow } from "@/lib/xero/sync";
import { XeroBills, type BillView, type Candidate, type XeroStatus } from "./table";

const ERRORS: Record<string, string> = {
  config: "Kredensial Xero belum lengkap di .env (XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI, TOKEN_ENCRYPTION_KEY).",
  state: "Sesi penghubungan Xero tidak cocok (state). Coba hubungkan lagi.",
  denied: "Otorisasi Xero dibatalkan atau ditolak.",
  no_refresh: "Xero tidak memberi refresh token. Pastikan scope offline_access ikut diminta.",
  scope: "Xero tidak memberikan scope accounting.invoices. Periksa scope di Developer Portal lalu hubungkan lagi.",
  no_org: "Tidak ada organisasi Xero yang diotorisasi.",
  save: "Koneksi Xero tidak bisa disimpan. Pastikan migrasi 20261124000000_xero_integration.sql sudah dijalankan.",
  oauth: "Penghubungan Xero gagal. Periksa Client ID, Client Secret, dan Redirect URI di Developer Portal.",
};

async function load() {
  const db = await createClient();
  const [ctx, bills, syncs, conn] = await Promise.all([
    loadScheduleContext(db), loadBills(db), db.from("xero_syncs").select("*"), getActiveConnection(),
  ]);
  if (syncs.error) throw new Error(`xero_syncs: ${syncs.error.message}`);
  const syncById = new Map((syncs.data as SyncRow[]).map((x) => [x.bill_id, x]));
  const xero: XeroStatus = {
    configured: xeroConfigured(),
    connected: !!conn,
    tenantName: conn?.tenant_name ?? null,
    isDemo: conn?.is_demo ?? null,
    needsTenantChoice: !!conn && !conn.tenant_id,
    tenants: conn?.available_tenants ?? [],
    refreshDaysLeft: conn ? refreshDaysLeft(conn.refresh_token_issued_at) : null,
    productionWritesAllowed: productionWritesAllowed(),
  };
  const byRow = new Map(bills.map((b) => [b.payment_schedule_id, b]));

  const candidates: Candidate[] = ctx.rows
    .filter((r) => r.seq !== null && !byRow.has(r.id))
    .sort((a, b) => (a.fiscal_year ?? 0) - (b.fiscal_year ?? 0) || (a.seq ?? 0) - (b.seq ?? 0))
    .map((r) => {
      const c = ctx.computed.get(r.id)!;
      const built = buildXeroBill(r, c, ctx.taxAccounts);
      return {
        id: r.id, paymentNo: c.payment_no ?? "", vendor: typeof r.vendor_name === "string" ? r.vendor_name : "", invoiceNo: typeof r.invoice_no === "string" ? r.invoice_no : "",
        ok: built.ok, problems: built.ok ? [] : built.problems, warnings: built.ok ? built.warnings : [],
      };
    });

  const views: BillView[] = bills.map((b) => {
    const row = ctx.rows.find((r) => r.id === b.payment_schedule_id);
    let stale: BillView["stale"] = null;
    if (!row) stale = { kind: "broken", messages: ["Baris Payment Schedule asalnya tidak ditemukan."] };
    else {
      const built = buildXeroBill(row, ctx.computed.get(row.id)!, ctx.taxAccounts);
      if (!built.ok) stale = { kind: "broken", messages: built.problems };
      else if (fingerprint(built.header, built.lines) !== fingerprint(b, b.xero_bill_lines)) stale = { kind: "changed", messages: ["Payment Schedule berubah sejak bill ini dibuat."] };
    }
    const { xero_bill_lines: lines, ...header } = b;
    return { id: b.id, status: b.status, exportedAt: b.exported_at, exportCount: b.export_count, stale, header, lines, sync: syncById.get(b.id) ?? null };
  });
  return { candidates, views, xero };
}

export default async function XeroBillsPage({ searchParams }: PageProps<"/xero-bills">) {
  await connection();
  const sp = await searchParams;
  const flash = sp.xero_error ? { kind: "error" as const, text: ERRORS[String(sp.xero_error)] ?? "Penghubungan Xero gagal." }
    : sp.xero === "connected" ? { kind: "ok" as const, text: "Xero terhubung." }
    : sp.xero === "choose" ? { kind: "ok" as const, text: "Xero terhubung. Pilih organisasi yang akan dipakai." } : null;
  let data: Awaited<ReturnType<typeof load>> | null = null;
  let loadError: string | null = null;
  try { data = await load(); } catch (e) { loadError = e instanceof Error ? e.message : "kesalahan"; }
  if (!data) {
    return <p className="alert-error">Gagal memuat Xero Bills: {loadError}. Pastikan migrasi <code>20261123000000_xero_bills.sql</code> sudah dijalankan.</p>;
  }
  return (
    <div className="space-y-4">
      <div>
        <h1>Xero Bills</h1>
        <p className="muted text-sm">
          Satu baris Payment Schedule menjadi satu bill dengan 1 sampai beberapa record (DPP, PPN, tiap PPh) dalam format impor Xero. Bill adalah salinan (snapshot): bisa disiapkan ulang selama berstatus Prepared, dan terkunci setelah diekspor atau dikirim ke Xero.
        </p>
      </div>
      <XeroBills candidates={data.candidates} bills={data.views} xero={data.xero} flash={flash} />
    </div>
  );
}
