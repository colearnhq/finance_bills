import { describe, expect, it } from "vitest";
import type { XAttachment, XInvoice } from "./api";
import { XeroApiError } from "./client";
import { buildRefData, type BillSnapshot, type XeroInvoicePayload } from "./invoice";
import { runSync, SyncRefused, type SyncOutcome, type SyncRow } from "./sync";
import { describeSync } from "./status";

const BILL: BillSnapshot = {
  id: "bill-1", payment_schedule_id: "r1", reference_no: "PMTID202600737;INV-1", contact_name: "PT. Ivonesia Solusi Data", email_address: null,
  po_address_line1: null, po_address_line2: null, po_address_line3: null, po_address_line4: null, po_city: null, po_region: null, po_postal_code: null, po_country: null,
  invoice_number: "PMTID202600737;INV-1", invoice_date: "2026-11-01", due_date: "2026-12-01", currency: "IDR", total: "6049500",
  tracking_name1: "Division", tracking_option1: "Customer Care", tracking_name2: "Department", tracking_option2: "Customer Care",
  xero_bill_lines: [
    { line_no: 1, kind: "dpp", description: "Sociomile", quantity: "1", unit_amount: "5550000", account_code: "2100", tax_type: "Tax Exempt", tax_amount: null },
    { line_no: 2, kind: "ppn", description: "PPN - Sociomile", quantity: "1", unit_amount: "610500", account_code: null, tax_type: "Tax Exempt", tax_amount: null },
    { line_no: 3, kind: "pph23", description: "PPh 23 - Sociomile", quantity: "1", unit_amount: "-111000", account_code: "201030202", tax_type: "Tax Exempt", tax_amount: null },
  ],
};
const REF = () => buildRefData(
  [{ Code: "2100", Status: "ACTIVE" }, { Code: "201030202", Status: "ACTIVE" }],
  [{ Name: "Tax Exempt", TaxType: "EXEMPTEXPENSES", Status: "ACTIVE", EffectiveRate: 0 }],
  [{ Name: "Division", Status: "ACTIVE", Options: [{ Name: "Customer Care", Status: "ACTIVE" }] }, { Name: "Department", Status: "ACTIVE", Options: [{ Name: "Customer Care", Status: "ACTIVE" }] }],
);

/** A fake Xero + database. Behaviour switches let a test script the failures. */
class World {
  contacts = [{ ContactID: "c-1", Name: "PT. Ivonesia Solusi Data", ContactStatus: "ACTIVE" }];
  xeroBills: XInvoice[] = [];
  attachments = new Map<string, XAttachment[]>();
  row: SyncRow | null = null;
  billLocked = false;
  pdf: { bytes: Uint8Array } | null = { bytes: new Uint8Array([37, 80, 68, 70]) };
  // scripted failures (consumed once each)
  createFailure: "none" | "rejected" | "ambiguous-but-created" | "ambiguous-not-created" | "has-errors" = "none";
  uploadFailure: "none" | "fail" | "fail-but-uploaded" = "none";
  findBillsFails = false;
  xeroTotal: number | undefined;
  calls = { findContacts: 0, findBills: 0, createBill: 0, listAttachments: 0, upload: 0, claim: 0 };
  payloads: XeroInvoicePayload[] = [];
  keys: string[] = [];
  saved: Partial<SyncRow>[] = [];

  ports(): Parameters<typeof runSync>[0] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the fake Xero/database closes over this world
    const w = this;
    return {
      bill: BILL,
      existing: w.row ? { ...w.row } : null,
      ref: async () => REF(),
      loadPdf: async () => w.pdf,
      claim: async () => {
        w.calls.claim++;
        if (!w.row) w.row = { bill_id: BILL.id, invoice_state: "sending", attachment_state: "pending", xero_invoice_id: null, xero_contact_id: null, xero_status: null, xero_total: null, warning: null, last_error: null, attempts: 0, in_progress: false, claimed_at: null };
        if (w.row.in_progress) throw new SyncRefused("RUNNING", "Bill ini sedang dikirim oleh proses lain.");
        if (w.row.invoice_state === "created" && (w.row.attachment_state === "done" || w.row.attachment_state === "none")) throw new SyncRefused("DONE", "Bill ini sudah terkirim ke Xero.");
        w.row = { ...w.row, in_progress: true, claimed_at: new Date().toISOString(), attempts: w.row.attempts + 1 };
        w.billLocked = true;
        return { ...w.row };
      },
      save: async (patch) => { w.saved.push(patch); w.row = { ...w.row!, ...patch }; },
      xero: {
        findContacts: async () => { w.calls.findContacts++; return w.contacts; },
        findBills: async () => { w.calls.findBills++; if (w.findBillsFails) throw new XeroApiError("ambiguous", "putus"); return w.xeroBills.map((b) => ({ ...b })); },
        createBill: async (payload, key) => {
          w.calls.createBill++; w.payloads.push(payload); w.keys.push(key);
          const f = w.createFailure; w.createFailure = "none";
          if (f === "rejected") throw new XeroApiError("rejected", "Xero menolak permintaan. Account code '2100' is not a valid code", 400, ["Account code '2100' is not a valid code"]);
          if (f === "ambiguous-not-created") throw new XeroApiError("ambiguous", "Tidak ada jawaban dari Xero.");
          const inv: XInvoice = { InvoiceID: "inv-1", InvoiceNumber: payload.InvoiceNumber, Status: "DRAFT", Total: w.xeroTotal ?? 6049500 };
          if (f === "has-errors") return [{ ...inv, InvoiceID: "", HasErrors: true, ValidationErrors: [{ Message: "Tanggal jatuh tempo tidak valid" }] }];
          w.xeroBills.push(inv);
          if (f === "ambiguous-but-created") throw new XeroApiError("ambiguous", "Tidak ada jawaban dari Xero.");
          return [inv];
        },
        listAttachments: async (id) => { w.calls.listAttachments++; return w.attachments.get(id) ?? []; },
        uploadAttachment: async (id, fileName) => {
          w.calls.upload++;
          const f = w.uploadFailure; w.uploadFailure = "none";
          if (f === "fail") throw new XeroApiError("ambiguous", "Tidak ada jawaban dari Xero.");
          w.attachments.set(id, [...(w.attachments.get(id) ?? []), { FileName: fileName }]);
          if (f === "fail-but-uploaded") throw new XeroApiError("ambiguous", "Tidak ada jawaban dari Xero.");
        },
      },
    };
  }
  send(): Promise<SyncOutcome> { return runSync(this.ports()); }
}

describe("runSync: the normal path", () => {
  it("creates one DRAFT bill, attaches the PDF once, and leaves the sync finished", async () => {
    const w = new World();
    const r = await w.send();
    expect(r).toMatchObject({ ok: true, status: "sent" });
    expect(w.calls).toMatchObject({ findContacts: 1, findBills: 1, createBill: 1, listAttachments: 1, upload: 1, claim: 1 });
    expect(w.payloads[0]).toMatchObject({ Type: "ACCPAY", Status: "DRAFT", Contact: { ContactID: "c-1" } });
    expect(w.payloads[0].LineItems).toHaveLength(3);
    expect(w.keys).toEqual(["bill-1"]); // stable idempotency key
    expect(w.row).toMatchObject({ invoice_state: "created", attachment_state: "done", xero_invoice_id: "inv-1", xero_status: "DRAFT", in_progress: false, last_error: null });
    expect(w.attachments.get("inv-1")).toEqual([{ FileName: "PMTID202600737.pdf" }]);
    expect(w.billLocked).toBe(true);
  });

  it("records 'none' when the bill has no PDF (a manual row)", async () => {
    const w = new World(); w.pdf = null;
    expect(await w.send()).toMatchObject({ ok: true });
    expect(w.row).toMatchObject({ attachment_state: "none", invoice_state: "created" });
    expect(w.calls.upload).toBe(0);
  });

  it("warns, but keeps the bill, when Xero's total differs from ours", async () => {
    const w = new World(); w.xeroTotal = 6049499;
    const r = await w.send();
    expect(r).toMatchObject({ ok: true });
    expect(r.warning).toMatch(/Total di Xero 6049499 berbeda/);
    expect(w.row!.warning).toMatch(/berbeda/);
  });
});

describe("runSync: nothing is locked when a read-only check fails", () => {
  it("blocks on a vendor that does not exist in Xero, before claiming", async () => {
    const w = new World(); w.contacts = [];
    const r = await w.send();
    expect(r).toMatchObject({ ok: false, status: "blocked" });
    expect(r.message).toMatch(/Kontak "PT. Ivonesia Solusi Data" tidak ada di Xero/);
    expect(w.calls.claim).toBe(0);
    expect(w.calls.createBill).toBe(0);
    expect(w.billLocked).toBe(false);
  });

  it("blocks on a duplicate contact, and on a tracking option that is missing in Xero", async () => {
    const dup = new World(); dup.contacts.push({ ContactID: "c-2", Name: "pt. ivonesia solusi data", ContactStatus: "ACTIVE" });
    expect(await dup.send()).toMatchObject({ status: "blocked" });
    expect(dup.calls.claim).toBe(0);
    const w = new World();
    const ports = w.ports();
    ports.bill = { ...BILL, tracking_option1: "Ghost" };
    const r = await runSync(ports);
    expect(r).toMatchObject({ status: "blocked" });
    expect(r.problems[0]).toMatch(/Opsi "Ghost" belum ada/);
    expect(w.billLocked).toBe(false);
  });

  it("blocks (and locks nothing) when the contact lookup itself fails", async () => {
    const w = new World();
    const ports = w.ports();
    ports.xero.findContacts = async () => { throw new XeroApiError("auth", "Sesi Xero tidak valid. Hubungkan ulang."); };
    expect(await runSync(ports)).toMatchObject({ status: "blocked" });
    expect(w.billLocked).toBe(false);
  });
});

describe("runSync: Xero refuses the bill", () => {
  it("marks it 'rejected' with Xero's reason, skips the PDF, and a later retry can create it", async () => {
    const w = new World(); w.createFailure = "rejected";
    const first = await w.send();
    expect(first).toMatchObject({ ok: false, status: "rejected" });
    expect(first.message).toMatch(/Account code '2100'/);
    expect(w.row).toMatchObject({ invoice_state: "rejected", in_progress: false });
    expect(w.calls.upload).toBe(0);
    expect(describeSync(w.row)).toMatchObject({ canUnlock: true, canSend: true });
    expect(await w.send()).toMatchObject({ ok: true });
    expect(w.calls.createBill).toBe(2);
    expect(w.xeroBills).toHaveLength(1);
  });

  it("treats HasErrors in a 200 response as a refusal", async () => {
    const w = new World(); w.createFailure = "has-errors";
    expect(await w.send()).toMatchObject({ status: "rejected", message: expect.stringContaining("Tanggal jatuh tempo tidak valid") });
    expect(w.xeroBills).toHaveLength(0);
  });
});

describe("runSync: Xero created the bill but the answer was lost", () => {
  it("looks the bill up before creating again, adopts it, and never creates a second one", async () => {
    const w = new World(); w.createFailure = "ambiguous-but-created";
    const first = await w.send();
    expect(first).toMatchObject({ ok: false, status: "unknown" });
    expect(w.row).toMatchObject({ invoice_state: "unknown", in_progress: false });
    expect(describeSync(w.row)).toMatchObject({ canSend: true, canUnlock: false }); // can never be unlocked: it may exist
    const second = await w.send();
    expect(second).toMatchObject({ ok: true, status: "sent" });
    expect(w.calls.createBill).toBe(1); // THE point: no second create
    expect(w.xeroBills).toHaveLength(1);
    expect(second.warning).toMatch(/sudah ada di Xero/);
    expect(w.row).toMatchObject({ invoice_state: "created", xero_invoice_id: "inv-1", attachment_state: "done" });
  });

  it("creates it on the retry when the first attempt truly did not reach Xero", async () => {
    const w = new World(); w.createFailure = "ambiguous-not-created";
    expect(await w.send()).toMatchObject({ status: "unknown" });
    expect(await w.send()).toMatchObject({ ok: true });
    expect(w.calls.createBill).toBe(2);
    expect(w.xeroBills).toHaveLength(1);
  });

  it("an existing bill found at the first attempt (e.g. imported by CSV) is adopted, not duplicated", async () => {
    const w = new World(); w.xeroBills.push({ InvoiceID: "inv-9", InvoiceNumber: BILL.invoice_number, Status: "DRAFT", Total: 6049500 });
    const r = await w.send();
    expect(r).toMatchObject({ ok: true });
    expect(w.calls.createBill).toBe(0);
    expect(w.row!.xero_invoice_id).toBe("inv-9");
    expect(w.attachments.get("inv-9")).toHaveLength(1);
  });

  it("ignores VOIDED and DELETED bills with the same number, but refuses when two live ones exist", async () => {
    const w = new World(); w.xeroBills.push({ InvoiceID: "old", InvoiceNumber: BILL.invoice_number, Status: "VOIDED" }, { InvoiceID: "old2", InvoiceNumber: BILL.invoice_number, Status: "DELETED" });
    expect(await w.send()).toMatchObject({ ok: true });
    expect(w.calls.createBill).toBe(1);
    const two = new World(); two.xeroBills.push({ InvoiceID: "a", Status: "DRAFT" }, { InvoiceID: "b", Status: "AUTHORISED" });
    const r = await two.send();
    expect(r).toMatchObject({ ok: false, status: "unknown" });
    expect(r.message).toMatch(/2 bill dengan nomor/);
    expect(two.calls.createBill).toBe(0);
  });

  it("if the pre-create lookup fails it never creates, and keeps 'unknown' when an earlier attempt might have sent", async () => {
    const fresh = new World(); fresh.findBillsFails = true;
    expect(await fresh.send()).toMatchObject({ ok: false, status: "rejected" }); // nothing could have been sent
    expect(fresh.calls.createBill).toBe(0);
    const prior = new World(); prior.createFailure = "ambiguous-but-created";
    await prior.send();
    prior.findBillsFails = true;
    expect(await prior.send()).toMatchObject({ ok: false, status: "unknown" });
    expect(prior.row!.invoice_state).toBe("unknown");
    expect(prior.calls.createBill).toBe(1);
  });
});

describe("runSync: the PDF attachment is its own step", () => {
  it("when the upload fails the bill stays created, and the retry uploads ONLY the PDF", async () => {
    const w = new World(); w.uploadFailure = "fail";
    const first = await w.send();
    expect(first).toMatchObject({ ok: false, status: "attachment_failed" });
    expect(first.message).toMatch(/Bill sudah dibuat di Xero, tetapi lampiran PDF gagal/);
    expect(w.row).toMatchObject({ invoice_state: "created", attachment_state: "failed", xero_invoice_id: "inv-1", in_progress: false });
    expect(describeSync(w.row)).toMatchObject({ label: "Bill dibuat, PDF belum terunggah", canSend: true, sendLabel: "Coba unggah PDF lagi", canUnlock: false });
    const second = await w.send();
    expect(second).toMatchObject({ ok: true });
    expect(w.calls.createBill).toBe(1); // the bill is not created again
    expect(w.calls.findContacts).toBe(1); // nor are the pre-create checks repeated
    expect(w.calls.findBills).toBe(1);
    expect(w.attachments.get("inv-1")).toHaveLength(1);
    expect(w.row).toMatchObject({ attachment_state: "done", last_error: null });
  });

  it("does not upload a second copy when the first upload actually succeeded but the answer was lost", async () => {
    const w = new World(); w.uploadFailure = "fail-but-uploaded";
    expect(await w.send()).toMatchObject({ status: "attachment_failed" });
    expect(await w.send()).toMatchObject({ ok: true });
    expect(w.calls.upload).toBe(1);
    expect(w.attachments.get("inv-1")).toHaveLength(1);
    expect(w.row!.attachment_state).toBe("done");
  });
});

describe("runSync: concurrency and repeats", () => {
  it("two simultaneous sends create exactly one bill; the other is refused", async () => {
    const w = new World();
    const [a, b] = await Promise.all([w.send(), w.send()]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ status: "refused" });
    expect(w.calls.createBill).toBe(1);
    expect(w.xeroBills).toHaveLength(1);
  });

  it("refuses a bill that is already fully sent", async () => {
    const w = new World();
    await w.send();
    const again = await w.send();
    expect(again).toMatchObject({ ok: false, status: "refused", message: "Bill ini sudah terkirim ke Xero." });
    expect(w.calls.createBill).toBe(1);
  });
});

describe("describeSync", () => {
  const row = (o: Partial<SyncRow>): SyncRow => ({ bill_id: "b", invoice_state: "sending", attachment_state: "pending", xero_invoice_id: null, xero_contact_id: null, xero_status: null, xero_total: null, warning: null, last_error: null, attempts: 1, in_progress: false, claimed_at: null, ...o });
  const now = Date.parse("2026-11-24T10:00:00Z");
  it("covers every state", () => {
    expect(describeSync(null)).toMatchObject({ label: "Belum dikirim", canSend: true });
    expect(describeSync(row({ in_progress: true, claimed_at: "2026-11-24T09:59:00Z" }), now)).toMatchObject({ label: "Sedang dikirim…", canSend: false });
    expect(describeSync(row({ in_progress: true, claimed_at: "2026-11-24T09:50:00Z" }), now)).toMatchObject({ label: "Hasil belum pasti", canSend: true }); // crashed worker: claim is stale
    expect(describeSync(row({ invoice_state: "created", xero_invoice_id: "i", attachment_state: "done" }), now)).toMatchObject({ label: "Draft di Xero + PDF", tone: "ok", canSend: false });
    expect(describeSync(row({ invoice_state: "created", xero_invoice_id: "i", attachment_state: "none" }), now)).toMatchObject({ label: "Draft di Xero (tanpa PDF)" });
    expect(describeSync(row({ invoice_state: "created", xero_invoice_id: "i", attachment_state: "done", warning: "w" }), now)).toMatchObject({ tone: "warn", detail: "w" });
    expect(describeSync(row({ invoice_state: "rejected", last_error: "x" }), now)).toMatchObject({ label: "Ditolak Xero", tone: "bad", canUnlock: true });
    expect(describeSync(row({ invoice_state: "unknown" }), now)).toMatchObject({ canUnlock: false, sendLabel: "Periksa & kirim ulang" });
  });
});
