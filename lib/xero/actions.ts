"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getOrganisation } from "./api";
import { buildXeroBill } from "./bill";
import { createXeroClient } from "./client";
import { getAccessToken, getActiveConnection } from "./connection";
import { loadScheduleContext } from "./load";
import { sendBills, type SendSummary } from "./sync-server";

export type PrepareResult = { id: string; ok: boolean; problems: string[] };

const ids = z.array(z.uuid()).min(1).max(200);

async function setScheduleStatus(db: Awaited<ReturnType<typeof createClient>>, scheduleId: string, status: string | null) {
  // Display only ("Import to Xero" column). The bill table is the source of truth, so a failure here is not fatal.
  await db.from("payment_schedule").update({ xero_import_status: status }).eq("id", scheduleId);
}

/** Builds a snapshot bill for each Payment Schedule row. A row that does not add up is refused with its reasons, nothing is guessed. */
export async function prepareBills(scheduleIds: string[]): Promise<{ ok: boolean; error?: string; results: PrepareResult[] }> {
  const parsed = ids.safeParse(scheduleIds);
  if (!parsed.success) return { ok: false, error: "Pilih 1 sampai 200 baris.", results: [] };
  const db = await createClient();
  let ctx;
  try { ctx = await loadScheduleContext(db); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Gagal memuat data.", results: [] }; }

  const results: PrepareResult[] = [];
  for (const id of parsed.data) {
    const row = ctx.rows.find((r) => r.id === id);
    if (!row) { results.push({ id, ok: false, problems: ["Baris Payment Schedule tidak ditemukan."] }); continue; }
    const built = buildXeroBill(row, ctx.computed.get(id)!, ctx.taxAccounts);
    if (!built.ok) { results.push({ id, ok: false, problems: built.problems }); continue; }
    const { error } = await db.rpc("create_xero_bill", { p_bill: built.header, p_lines: built.lines });
    if (error) {
      results.push({ id, ok: false, problems: [error.code === "23505" ? "Baris ini sudah punya bill atau Xero Reference No yang sama sudah dipakai." : error.message] });
      continue;
    }
    await setScheduleStatus(db, id, "PREPARED");
    results.push({ id, ok: true, problems: [] });
  }
  revalidatePath("/xero-bills");
  revalidatePath("/payment-schedule");
  return { ok: results.every((r) => r.ok), results };
}

/** Replaces a prepared bill with a fresh one built from the current Payment Schedule. The old one is kept if the new one cannot be built. */
export async function rebuildBill(billId: string): Promise<{ ok: boolean; problems: string[] }> {
  if (!z.uuid().safeParse(billId).success) return { ok: false, problems: ["ID tidak valid."] };
  const db = await createClient();
  const { data: bill } = await db.from("xero_bills").select("id,status,payment_schedule_id").eq("id", billId).maybeSingle();
  if (!bill) return { ok: false, problems: ["Bill tidak ditemukan."] };
  if (bill.status !== "prepared") return { ok: false, problems: ["Bill yang sudah diekspor tidak bisa diganti."] };
  let ctx;
  try { ctx = await loadScheduleContext(db); } catch (e) { return { ok: false, problems: [e instanceof Error ? e.message : "Gagal memuat data."] }; }
  const row = ctx.rows.find((r) => r.id === bill.payment_schedule_id);
  if (!row) return { ok: false, problems: ["Baris Payment Schedule tidak ditemukan."] };
  const built = buildXeroBill(row, ctx.computed.get(row.id)!, ctx.taxAccounts);
  if (!built.ok) return { ok: false, problems: built.problems };
  const del = await db.from("xero_bills").delete({ count: "exact" }).eq("id", billId).eq("status", "prepared");
  if (del.error || !del.count) return { ok: false, problems: [del.error?.message ?? "Bill tidak bisa dihapus (mungkin sudah diekspor)."] };
  const { error } = await db.rpc("create_xero_bill", { p_bill: built.header, p_lines: built.lines });
  if (error) { await setScheduleStatus(db, row.id, null); return { ok: false, problems: [`Bill lama terhapus tetapi yang baru gagal dibuat: ${error.message}. Siapkan lagi dari daftar.`] }; }
  revalidatePath("/xero-bills");
  return { ok: true, problems: [] };
}

export async function deleteBill(billId: string): Promise<{ ok: boolean; error?: string }> {
  if (!z.uuid().safeParse(billId).success) return { ok: false, error: "ID tidak valid." };
  const db = await createClient();
  const { data: bill } = await db.from("xero_bills").select("payment_schedule_id").eq("id", billId).maybeSingle();
  const del = await db.from("xero_bills").delete({ count: "exact" }).eq("id", billId).eq("status", "prepared");
  if (del.error) return { ok: false, error: del.error.message };
  if (!del.count) return { ok: false, error: "Hanya bill berstatus prepared yang bisa dihapus." };
  if (bill) await setScheduleStatus(db, bill.payment_schedule_id, null);
  revalidatePath("/xero-bills");
  revalidatePath("/payment-schedule");
  return { ok: true };
}

/** Sends prepared bills to Xero as DRAFT bills (max 10 at a time). Never authorises or pays anything. */
export async function sendBillsToXero(billIds: string[]): Promise<SendSummary> {
  const parsed = z.array(z.uuid()).min(1).max(50).safeParse(billIds);
  if (!parsed.success) return { ok: false, error: "Pilih 1 sampai 10 bill.", results: [] };
  const res = await sendBills(parsed.data);
  revalidatePath("/xero-bills");
  revalidatePath("/payment-schedule");
  return res;
}

/** Lets a bill that Xero definitely refused (nothing created there) be edited again. */
export async function unlockRejectedBill(billId: string): Promise<{ ok: boolean; error?: string }> {
  if (!z.uuid().safeParse(billId).success) return { ok: false, error: "ID tidak valid." };
  const { error } = await (await createClient()).rpc("unlock_rejected_xero_bill", { p_bill: billId });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/xero-bills");
  return { ok: true };
}

/** When several organisations were authorised, picks the one AP Hub writes to. */
export async function chooseXeroTenant(tenantId: string): Promise<{ ok: boolean; error?: string }> {
  const conn = await getActiveConnection();
  if (!conn) return { ok: false, error: "Xero belum terhubung." };
  const t = conn.available_tenants.find((x) => x.tenantId === tenantId);
  if (!t) return { ok: false, error: "Organisasi tidak ada dalam daftar yang diotorisasi." };
  let name = t.tenantName;
  let isDemo: boolean | null = null;
  try {
    const xc = createXeroClient({ fetch, tenantId, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), getToken: (force) => getAccessToken(conn.id, { force }) });
    const org = await getOrganisation(xc);
    if (org?.Name) name = org.Name;
    if (typeof org?.IsDemoCompany === "boolean") isDemo = org.IsDemoCompany;
  } catch { /* keep the name from the connection list; is_demo stays unknown, which is treated as production */ }
  const { error } = await createAdminClient().from("xero_connections").update({ tenant_id: tenantId, tenant_name: name, is_demo: isDemo }).eq("id", conn.id);
  if (error) return { ok: false, error: "Gagal menyimpan pilihan organisasi." };
  revalidatePath("/xero-bills");
  return { ok: true };
}

/** Forgets the connection here (tokens stay valid at Xero until they expire or you remove the app in Xero). */
export async function disconnectXero(): Promise<{ ok: boolean }> {
  await createAdminClient().from("xero_connections").update({ revoked_at: new Date().toISOString() }).is("revoked_at", null);
  revalidatePath("/xero-bills");
  return { ok: true };
}
