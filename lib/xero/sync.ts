/**
 * Sends ONE bill snapshot to Xero as a DRAFT bill plus its PDF. The ports (Xero calls, claim, save, PDF) are injected so
 * every failure path can be tested without Xero or a database.
 *
 * Order of events, and why:
 *  1. Read-only checks (contact, accounts, tax rate, tracking). Failing here locks nothing, so the data can still be fixed.
 *  2. claim(): one sender at a time, and the snapshot is locked from here on.
 *  3. Reconcile: look the bill up in Xero by InvoiceNumber (PMTID...). If it exists it is adopted, never created twice.
 *  4. Create the DRAFT bill. A network error or 5xx is AMBIGUOUS ('unknown'): the next attempt goes back to step 3.
 *  5. Attach the PDF as a separate step. If it fails only the attachment is retried, never the bill.
 * Nothing here authorises or pays a bill: Status is always DRAFT.
 */
import { D } from "@/lib/payment-schedule/calc";
import type { XAttachment, XContact, XInvoice } from "./api";
import { XeroApiError } from "./client";
import { attachmentName, buildInvoicePayload, pickContact, type BillSnapshot, type RefData, type XeroInvoicePayload } from "./invoice";

export interface SyncRow {
  bill_id: string;
  invoice_state: "sending" | "created" | "rejected" | "unknown";
  attachment_state: "pending" | "done" | "failed" | "none";
  xero_invoice_id: string | null;
  xero_contact_id: string | null;
  xero_status: string | null;
  xero_total: string | number | null;
  warning: string | null;
  last_error: string | null;
  attempts: number;
  in_progress: boolean;
  claimed_at: string | null;
}

export class SyncRefused extends Error {
  constructor(public code: "RUNNING" | "DONE" | "WRONG_CONNECTION", message: string) { super(message); }
}

export interface SyncPorts {
  bill: BillSnapshot;
  /** The sync record as it was before this attempt, if any. */
  existing: SyncRow | null;
  xero: {
    findContacts(name: string): Promise<XContact[]>;
    findBills(invoiceNumber: string): Promise<XInvoice[]>;
    createBill(payload: XeroInvoicePayload, idempotencyKey: string): Promise<XInvoice[]>;
    listAttachments(invoiceId: string): Promise<XAttachment[]>;
    uploadAttachment(invoiceId: string, fileName: string, bytes: Uint8Array, idempotencyKey: string): Promise<void>;
  };
  ref(): Promise<RefData>;
  claim(): Promise<SyncRow>;
  save(patch: Partial<SyncRow>): Promise<void>;
  loadPdf(): Promise<{ bytes: Uint8Array } | null>;
}

export type SyncStatus = "sent" | "blocked" | "refused" | "rejected" | "unknown" | "attachment_failed";
export interface SyncOutcome { ok: boolean; status: SyncStatus; message: string; problems: string[]; warning?: string }

const text = (e: unknown) => (e instanceof Error ? e.message : "Kesalahan tidak dikenal.").slice(0, 500);
const isAmbiguous = (e: unknown) => !(e instanceof XeroApiError) || e.kind === "ambiguous";

export async function runSync(p: SyncPorts): Promise<SyncOutcome> {
  const bill = p.bill;
  const blocked = (problems: string[]): SyncOutcome => ({ ok: false, status: "blocked", message: problems[0] ?? "Belum bisa dikirim.", problems });

  // 1. read-only checks, only when the bill is not in Xero yet
  const knownCreated = p.existing?.invoice_state === "created" && !!p.existing.xero_invoice_id;
  let payload: XeroInvoicePayload | null = null;
  let contactId = p.existing?.xero_contact_id ?? null;
  if (!knownCreated) {
    try {
      const contact = pickContact(bill.contact_name, await p.xero.findContacts(bill.contact_name));
      if (!contact.ok) return blocked([contact.problem]);
      contactId = contact.contactId;
      const built = buildInvoicePayload(bill, contact.contactId, await p.ref());
      if (!built.ok) return blocked(built.problems);
      payload = built.payload;
    } catch (e) {
      return blocked([`Pemeriksaan ke Xero gagal: ${text(e)}`]);
    }
  }

  // 2. claim (locks the snapshot)
  let row: SyncRow;
  try {
    row = await p.claim();
  } catch (e) {
    if (e instanceof SyncRefused) return { ok: false, status: "refused", message: e.message, problems: [e.message] };
    throw e;
  }

  let invoiceId = row.invoice_state === "created" ? row.xero_invoice_id : null;
  let warning: string | null = row.warning;

  // 3 + 4. reconcile, then create
  if (!invoiceId) {
    // After a crash or timeout we cannot know whether the earlier attempt reached Xero.
    const maybeSent = row.invoice_state === "unknown" || (row.invoice_state === "sending" && row.attempts > 1);
    const failedBeforeWrite = maybeSent ? "unknown" : "rejected";
    if (!payload) {
      await p.save({ invoice_state: failedBeforeWrite, in_progress: false, last_error: "Keadaan bill berubah selama pengiriman. Coba lagi." });
      return { ok: false, status: failedBeforeWrite, message: "Keadaan bill berubah selama pengiriman. Coba lagi.", problems: [] };
    }
    let found: XInvoice[];
    try {
      found = (await p.xero.findBills(bill.invoice_number)).filter((i) => i.Status !== "VOIDED" && i.Status !== "DELETED");
    } catch (e) {
      const msg = `Gagal memeriksa Xero sebelum membuat bill: ${text(e)}`;
      await p.save({ invoice_state: failedBeforeWrite, in_progress: false, last_error: msg });
      return { ok: false, status: failedBeforeWrite, message: msg, problems: [] };
    }
    if (found.length > 1) {
      const msg = `Ada ${found.length} bill dengan nomor ${bill.invoice_number} di Xero. Hapus yang berlebih di Xero, lalu coba lagi.`;
      await p.save({ invoice_state: "unknown", in_progress: false, last_error: msg });
      return { ok: false, status: "unknown", message: msg, problems: [] };
    }
    if (found.length === 1) {
      const inv = found[0];
      invoiceId = inv.InvoiceID;
      const notes = [`Bill dengan nomor ini sudah ada di Xero (status ${inv.Status ?? "?"}) dan dipakai ulang, tidak dibuat lagi.`];
      if (inv.Total !== undefined && !D(inv.Total).eq(D(bill.total))) notes.push(`Total di Xero ${inv.Total} berbeda dari bill ini (${D(bill.total).toFixed()}).`);
      warning = notes.join(" ");
      await p.save({ invoice_state: "created", xero_invoice_id: invoiceId, xero_contact_id: contactId, xero_status: inv.Status ?? null, xero_total: inv.Total ?? null, warning, last_error: null });
    } else {
      await p.save({ invoice_state: "sending" }); // so a crash from here on is recognised as "maybe sent"
      try {
        const inv = (await p.xero.createBill(payload, bill.id))[0];
        if (!inv?.InvoiceID || inv.HasErrors) {
          const msg = (inv?.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean).join(" | ") || "Xero tidak membuat bill.";
          await p.save({ invoice_state: "rejected", in_progress: false, last_error: msg });
          return { ok: false, status: "rejected", message: `Ditolak Xero: ${msg}`, problems: [msg] };
        }
        invoiceId = inv.InvoiceID;
        warning = inv.Total !== undefined && !D(inv.Total).eq(D(bill.total))
          ? `Total di Xero ${inv.Total} berbeda dari bill ini (${D(bill.total).toFixed()}). Periksa draft di Xero.` : null;
        await p.save({ invoice_state: "created", xero_invoice_id: invoiceId, xero_contact_id: contactId, xero_status: inv.Status ?? "DRAFT", xero_total: inv.Total ?? null, warning, last_error: null });
      } catch (e) {
        const state = isAmbiguous(e) ? "unknown" : "rejected";
        const msg = text(e);
        await p.save({ invoice_state: state, in_progress: false, last_error: msg });
        return { ok: false, status: state, message: state === "unknown" ? `Hasil belum pasti: ${msg} Coba lagi: sistem akan memeriksa Xero dulu sebelum membuat apa pun.` : msg, problems: [] };
      }
    }
  }

  // 5. attachment (its own step: a failure here never repeats the bill)
  if (row.attachment_state !== "done" && row.attachment_state !== "none") {
    try {
      const pdf = await p.loadPdf();
      if (!pdf) {
        await p.save({ attachment_state: "none" });
      } else {
        const name = attachmentName(bill);
        const have = await p.xero.listAttachments(invoiceId!);
        if (!have.some((a) => a.FileName === name)) await p.xero.uploadAttachment(invoiceId!, name, pdf.bytes, `${bill.id}:pdf`);
        await p.save({ attachment_state: "done" });
      }
    } catch (e) {
      const msg = `Bill sudah dibuat di Xero, tetapi lampiran PDF gagal: ${text(e)}`;
      await p.save({ attachment_state: "failed", in_progress: false, last_error: msg });
      return { ok: false, status: "attachment_failed", message: msg, problems: [], warning: warning ?? undefined };
    }
  }

  await p.save({ in_progress: false, last_error: null });
  return { ok: true, status: "sent", message: "Draft bill dibuat di Xero.", problems: [], warning: warning ?? undefined };
}
