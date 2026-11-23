import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import * as api from "./api";
import { createXeroClient } from "./client";
import { getAccessToken, getActiveConnection } from "./connection";
import { buildRefData, type RefData } from "./invoice";
import { loadBills } from "./load";
import { productionWritesAllowed } from "./oauth";
import { runSync, SyncRefused, type SyncOutcome, type SyncRow } from "./sync";

export const MAX_BILLS_PER_SEND = 10; // about 5 Xero calls per bill against a limit of 60 per minute

export interface SendResult { billId: string; reference: string; outcome: SyncOutcome }
export interface SendSummary { ok: boolean; error?: string; results: SendResult[] }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const text = (e: unknown) => (e instanceof Error ? e.message : "Kesalahan tidak dikenal.").slice(0, 500);

/** Sends the given prepared bills to the connected Xero organisation as DRAFT bills, one after another. */
export async function sendBills(billIds: string[]): Promise<SendSummary> {
  if (billIds.length > MAX_BILLS_PER_SEND) return { ok: false, error: `Maksimal ${MAX_BILLS_PER_SEND} bill sekali kirim (batas panggilan Xero 60 per menit).`, results: [] };

  const conn = await getActiveConnection();
  if (!conn) return { ok: false, error: "Xero belum terhubung. Hubungkan dulu.", results: [] };
  if (!conn.tenant_id) return { ok: false, error: "Pilih organisasi Xero dulu.", results: [] };
  if (conn.is_demo !== true && !productionWritesAllowed()) {
    return {
      ok: false, results: [],
      error: `Organisasi "${conn.tenant_name}" bukan Demo Company${conn.is_demo === null ? " (Xero tidak memberi tahu)" : ""}. Penulisan ke organisasi produksi dimatikan. Setelah Anda yakin, set XERO_ALLOW_PRODUCTION_WRITES=true di .env dan restart.`,
    };
  }

  const db = await createClient();
  const [bills, syncs] = await Promise.all([loadBills(db, billIds), db.from("xero_syncs").select("*").in("bill_id", billIds)]);
  if (syncs.error) return { ok: false, error: `xero_syncs: ${syncs.error.message}`, results: [] };
  const syncByBill = new Map((syncs.data as SyncRow[]).map((s) => [s.bill_id, s]));

  const connectionId = conn.id;
  const xc = createXeroClient({ fetch, tenantId: conn.tenant_id, sleep, getToken: (force) => getAccessToken(connectionId, { force }) });

  // Accounts, tax rates and tracking categories are read once for the whole batch.
  let refPromise: Promise<RefData> | null = null;
  const ref = () => (refPromise ??= Promise.all([api.listAccounts(xc), api.listTaxRates(xc), api.listTrackingCategories(xc)])
    .then(([a, t, c]) => buildRefData(a, t, c))
    .catch((e) => { refPromise = null; throw e; }));

  const results: SendResult[] = [];
  for (const id of billIds) {
    const bill = bills.find((b) => b.id === id);
    if (!bill) { results.push({ billId: id, reference: id, outcome: { ok: false, status: "blocked", message: "Bill tidak ditemukan.", problems: ["Bill tidak ditemukan."] } }); continue; }
    let outcome: SyncOutcome;
    try {
      outcome = await runSync({
        bill, existing: syncByBill.get(id) ?? null, ref,
        xero: {
          findContacts: (name) => api.findContactsByName(xc, name),
          findBills: (n) => api.findBillsByNumber(xc, n),
          createBill: (payload, key) => api.createBill(xc, payload, key),
          listAttachments: (invoiceId) => api.listInvoiceAttachments(xc, invoiceId),
          uploadAttachment: async (invoiceId, name, bytes, key) => { await api.uploadInvoiceAttachment(xc, invoiceId, name, bytes, key); },
        },
        claim: async () => {
          const { data, error } = await db.rpc("claim_xero_sync", { p_bill: id, p_connection: connectionId });
          if (error) {
            if (error.message.includes("SYNC_RUNNING")) throw new SyncRefused("RUNNING", "Bill ini sedang dikirim oleh proses lain.");
            if (error.message.includes("SYNC_DONE")) throw new SyncRefused("DONE", "Bill ini sudah terkirim ke Xero.");
            if (error.message.includes("WRONG_CONNECTION")) throw new SyncRefused("WRONG_CONNECTION", "Bill ini sudah dibuat di organisasi Xero yang lain.");
            throw new Error(error.message);
          }
          return data as SyncRow;
        },
        save: async (patch) => {
          const { error } = await db.from("xero_syncs").update(patch).eq("bill_id", id);
          if (error) throw new Error(`Gagal mencatat status pengiriman: ${error.message}`);
        },
        loadPdf: () => loadPdf(bill.payment_schedule_id),
      });
    } catch (e) {
      // Unexpected: treat as "not sure". The next attempt looks the bill up in Xero before creating anything.
      outcome = { ok: false, status: "unknown", message: `Terhenti di tengah jalan: ${text(e)} Coba lagi: sistem memeriksa Xero dulu.`, problems: [] };
    }
    results.push({ billId: id, reference: bill.reference_no, outcome });
  }
  return { ok: results.every((r) => r.outcome.ok), results };
}

/** The original PDF of the Payment Schedule row, or null for a manual row that never had one. A download failure throws. */
async function loadPdf(scheduleId: string): Promise<{ bytes: Uint8Array } | null> {
  const db = await createClient();
  const { data: row } = await db.from("payment_schedule").select("attachment_id").eq("id", scheduleId).maybeSingle();
  if (!row?.attachment_id) return null;
  const { data: att } = await db.from("email_attachments").select("storage_path,status").eq("id", row.attachment_id).maybeSingle();
  if (!att?.storage_path || att.status !== "stored") return null;
  const { data, error } = await createAdminClient().storage.from("invoices").download(att.storage_path);
  if (error || !data) throw new Error("PDF asli tidak bisa diunduh dari penyimpanan.");
  return { bytes: new Uint8Array(await data.arrayBuffer()) };
}
