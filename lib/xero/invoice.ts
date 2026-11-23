/**
 * Turns a stored bill snapshot into the body Xero expects, checking everything it can BEFORE anything is sent.
 * Pure. Refuses (returns problems) instead of guessing: an unknown account, a tax rate that is not 0%, a tracking option
 * that does not exist in Xero, or an amount Xero would round. Nothing is created or renamed in Xero from here.
 */
import { D } from "@/lib/payment-schedule/calc";
import type { XAccount, XContact, XTaxRate, XTrackingCategory } from "./api";
import type { BillHeader, BillLine } from "./bill";

export type BillSnapshot = BillHeader & { id: string; xero_bill_lines: BillLine[] };

export interface RefData {
  accounts: Map<string, boolean>; // code -> active
  taxRates: XTaxRate[];
  tracking: Map<string, { name: string; active: boolean; options: Map<string, { name: string; active: boolean }> }>; // lower-case name -> category
}

export function buildRefData(accounts: XAccount[], taxRates: XTaxRate[], categories: XTrackingCategory[]): RefData {
  return {
    accounts: new Map(accounts.filter((a) => a.Code).map((a) => [a.Code!, (a.Status ?? "ACTIVE") === "ACTIVE"])),
    taxRates,
    tracking: new Map(categories.map((c) => [c.Name.trim().toLowerCase(), {
      name: c.Name, active: (c.Status ?? "ACTIVE") === "ACTIVE",
      options: new Map((c.Options ?? []).map((o) => [o.Name.trim().toLowerCase(), { name: o.Name, active: (o.Status ?? "ACTIVE") === "ACTIVE" }])),
    }])),
  };
}

/** The vendor must already exist in Xero with exactly this name (compared ignoring case and surrounding spaces). */
export function pickContact(name: string, found: XContact[]): { ok: true; contactId: string } | { ok: false; problem: string } {
  const want = name.trim().toLowerCase();
  const hits = found.filter((c) => c.Name.trim().toLowerCase() === want && (c.ContactStatus ?? "ACTIVE") === "ACTIVE");
  if (hits.length === 0) return { ok: false, problem: `Kontak "${name}" tidak ada di Xero. Buat dulu di Xero dengan nama yang sama persis.` };
  if (hits.length > 1) return { ok: false, problem: `Ada ${hits.length} kontak aktif bernama "${name}" di Xero. Sisakan satu supaya bill tidak salah alamat.` };
  return { ok: true, contactId: hits[0].ContactID };
}

export interface XeroInvoiceLine {
  Description: string; Quantity: number; UnitAmount: number; AccountCode?: string; TaxType: string; Tracking: { Name: string; Option: string }[];
}
export interface XeroInvoicePayload {
  Type: "ACCPAY"; Contact: { ContactID: string }; InvoiceNumber: string; Reference: string; Date: string; DueDate: string;
  Status: "DRAFT"; CurrencyCode: string; LineAmountTypes: "Exclusive"; LineItems: XeroInvoiceLine[];
}

const decimals = (n: ReturnType<typeof D>) => (n.decimalPlaces() as number);
const safeNumber = (s: string): number | null => {
  const d = D(s);
  return decimals(d) <= 4 && d.precision(true) <= 15 ? Number(d.toFixed()) : null;
};

export function buildInvoicePayload(bill: BillSnapshot, contactId: string, ref: RefData): { ok: true; payload: XeroInvoicePayload } | { ok: false; problems: string[] } {
  const problems = new Set<string>();
  const lines = [...bill.xero_bill_lines].sort((a, b) => a.line_no - b.line_no);

  const tracking: { Name: string; Option: string }[] = [];
  for (const [name, option] of [[bill.tracking_name1, bill.tracking_option1], [bill.tracking_name2, bill.tracking_option2]] as const) {
    if (!name || !option) continue;
    const cat = ref.tracking.get(name.trim().toLowerCase());
    if (!cat || !cat.active) { problems.add(`Kategori tracking "${name}" tidak ada atau tidak aktif di Xero.`); continue; }
    const opt = cat.options.get(option.trim().toLowerCase());
    if (!opt || !opt.active) { problems.add(`Opsi "${option}" belum ada di kategori tracking "${cat.name}" di Xero. Tambahkan di Xero (kami tidak membuatnya).`); continue; }
    tracking.push({ Name: cat.name, Option: opt.name });
  }

  let sum = D(0);
  const items: XeroInvoiceLine[] = [];
  for (const l of lines) {
    const where = `Baris ${l.line_no} (${l.kind})`;
    if (!l.description.trim()) problems.add(`${where}: Description kosong (Xero mewajibkannya). Isi Description di Payment Schedule.`);
    if (l.account_code) {
      const active = ref.accounts.get(l.account_code);
      if (active === undefined) problems.add(`Akun ${l.account_code} tidak ada di Xero.`);
      else if (!active) problems.add(`Akun ${l.account_code} tidak aktif di Xero.`);
    }
    const rates = ref.taxRates.filter((r) => r.Name.trim().toLowerCase() === l.tax_type.trim().toLowerCase() && (r.Status ?? "ACTIVE") === "ACTIVE");
    const zero = rates.find((r) => (r.EffectiveRate ?? r.DisplayTaxRate) === 0);
    if (rates.length === 0) problems.add(`Tax rate "${l.tax_type}" tidak ditemukan di Xero.`);
    else if (!zero) problems.add(`Tax rate "${l.tax_type}" di Xero bukan 0% (atau tarifnya tidak terbaca). Bill ini mengandalkan baris PPN terpisah, jadi pajak tidak boleh dihitung dua kali.`);
    const unit = safeNumber(l.unit_amount);
    const qty = safeNumber(l.quantity);
    if (unit === null) problems.add(`${where}: UnitAmount ${l.unit_amount} punya lebih dari 4 desimal atau terlalu besar. Xero hanya menyimpan 4 desimal dan kami tidak membulatkan diam-diam.`);
    if (qty === null) problems.add(`${where}: Quantity ${l.quantity} tidak valid.`);
    sum = sum.plus(D(l.unit_amount).mul(D(l.quantity)));
    if (unit !== null && qty !== null && zero) {
      items.push({ Description: l.description, Quantity: qty, UnitAmount: unit, ...(l.account_code ? { AccountCode: l.account_code } : {}), TaxType: zero.TaxType, Tracking: tracking });
    }
  }
  if (!sum.eq(D(bill.total))) problems.add(`Jumlah baris ${sum.toFixed()} tidak sama dengan total bill ${D(bill.total).toFixed()}.`);
  if (lines.length === 0) problems.add("Bill tidak punya baris.");
  if (problems.size > 0) return { ok: false, problems: [...problems] };

  return {
    ok: true,
    payload: {
      Type: "ACCPAY", Contact: { ContactID: contactId }, InvoiceNumber: bill.invoice_number, Reference: bill.reference_no,
      Date: bill.invoice_date, DueDate: bill.due_date, Status: "DRAFT", CurrencyCode: bill.currency,
      // Every line is on a 0% tax rate (the tax is its own line), so Exclusive leaves the amounts untouched.
      LineAmountTypes: "Exclusive", LineItems: items,
    },
  };
}

/** Same name for every try of the same bill, so a retry finds the file it may already have uploaded. */
export function attachmentName(bill: Pick<BillHeader, "reference_no">): string {
  const base = bill.reference_no.split(";")[0].replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "bill";
  return `${base}.pdf`;
}
