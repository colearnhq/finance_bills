/**
 * Restructures one Payment Schedule row into the records of a Xero bill (the layout of Xero's bill CSV import).
 *
 *   DPP line            + DPP            account = the row's Accounting Account
 *   PPN line            + PPN            account = blank (as in the team's sample)
 *   one line per PPh    - PPh            account = withholding payable account (configurable, table xero_tax_accounts)
 *
 * Pure and deterministic. Amounts are the Payment Schedule's own values, exactly (no rounding added here).
 * It refuses (returns problems) instead of guessing: a bill that does not add up to Amount to Transfer is never built.
 */
import { D, TAX_TRIGGERS, type Num } from "@/lib/payment-schedule/calc";
import type { Computed, DbRow } from "@/lib/payment-schedule/rows";

export type LineKind = "dpp" | "ppn" | "pph21" | "pph23" | "pph42" | "umkm" | "pph26";
export type WithholdingKind = Exclude<LineKind, "dpp" | "ppn">;

export const TAX_TYPE = "Tax Exempt"; // every line in the sample; the tax itself is a separate line
export const TRACKING_DIVISION = "Division";
export const TRACKING_DEPARTMENT = "Department";

export const TAX_LABEL: Record<Exclude<LineKind, "dpp">, string> = {
  ppn: "PPN", pph23: "PPh 23", pph21: "PPh 21", pph42: "PPh 4 ayat 2", umkm: "PPh Final UMKM", pph26: "PPh 26",
};
/** Order of the tax lines after the DPP line. */
const TAX_ORDER = ["ppn", "pph23", "pph21", "pph42", "umkm", "pph26"] as const;

export interface BillHeader {
  payment_schedule_id: string;
  reference_no: string;
  contact_name: string;
  email_address: string | null;
  po_address_line1: string | null; po_address_line2: string | null; po_address_line3: string | null; po_address_line4: string | null;
  po_city: string | null; po_region: string | null; po_postal_code: string | null; po_country: string | null;
  invoice_number: string;
  invoice_date: string; // ISO yyyy-mm-dd
  due_date: string;
  currency: string;
  total: string;
  tracking_name1: string | null; tracking_option1: string | null; tracking_name2: string | null; tracking_option2: string | null;
}
export interface BillLine {
  line_no: number;
  kind: LineKind;
  description: string;
  quantity: string;
  unit_amount: string;
  account_code: string | null;
  tax_type: string;
  tax_amount: string | null;
}

export type BuildResult =
  | { ok: true; header: BillHeader; lines: BillLine[]; warnings: string[] }
  | { ok: false; problems: string[] };

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const dec = (v: unknown): Num | null => {
  if (v === null || v === undefined || v === "") return null;
  try { return D(v as string | number); } catch { return null; }
};
const iso = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const num = (n: Num) => n.toFixed(); // plain notation, no exponent, no trailing zeros

/** `taxAccounts` maps pph21/pph23/pph42/umkm/pph26 to a Xero account code. */
export function buildXeroBill(row: DbRow, c: Computed, taxAccounts: Partial<Record<WithholdingKind, string>>): BuildResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const need = (ok: unknown, msg: string) => { if (!ok) problems.push(msg); };

  const contact = text(row.vendor_name);
  const invoiceNo = text(row.invoice_no);
  const invoiceDate = iso(row.invoice_date);
  const dueDate = iso(row.due_date);
  const currency = text(row.currency);
  const account = text(row.accounting_account);
  const dpp = dec(row.dpp);
  need(c.payment_no, "Belum bernomor (isi Input Date di Payment Schedule).");
  need(contact, "Vendor Name kosong.");
  need(invoiceNo, "Invoice No kosong.");
  need(invoiceDate, "Invoice Date kosong.");
  need(dueDate, "Due Date kosong.");
  need(currency, "Currency kosong.");
  need(account, "Accounting Account kosong (dipakai di baris DPP).");
  need(dpp !== null, "DPP kosong.");

  const other = dec(row.other_adjustment);
  if (other && !other.isZero()) problems.push("Other Addition/Deduction tidak punya padanan di Xero. Kosongkan atau selesaikan dulu.");

  const category = text(row.tax_category) ?? "";
  const taxValue: Record<(typeof TAX_ORDER)[number], Num | null> = { ppn: c.ppn, pph23: c.pph23, pph21: c.pph21, pph42: c.pph42, umkm: c.umkm, pph26: c.pph26 };
  for (const k of TAX_ORDER) {
    if (!TAX_TRIGGERS[k].test(category)) continue;
    if (taxValue[k] === null) problems.push(k === "pph21" ? "PPh 21 belum terhitung: isi NPWP? Y/N." : `${TAX_LABEL[k]} belum terhitung.`);
    else if (k !== "ppn" && !taxAccounts[k]) problems.push(`Akun Xero untuk ${TAX_LABEL[k]} belum diatur (tabel xero_tax_accounts).`);
  }

  if (problems.length > 0 || dpp === null) return { ok: false, problems };

  const desc = text(row.description) ?? "";
  const lineDesc = (kind: Exclude<LineKind, "dpp">) => (desc ? `${TAX_LABEL[kind]} - ${desc}` : TAX_LABEL[kind]);
  const lines: BillLine[] = [{ line_no: 1, kind: "dpp", description: desc, quantity: "1", unit_amount: num(dpp), account_code: account, tax_type: TAX_TYPE, tax_amount: null }];
  let total = dpp;
  for (const k of TAX_ORDER) {
    const v = taxValue[k];
    if (v === null || !TAX_TRIGGERS[k].test(category)) continue;
    const signed = k === "ppn" ? v : v.neg();
    total = total.plus(signed);
    lines.push({
      line_no: lines.length + 1, kind: k, description: lineDesc(k), quantity: "1", unit_amount: num(signed),
      account_code: k === "ppn" ? null : (taxAccounts[k as WithholdingKind] ?? null), tax_type: TAX_TYPE, tax_amount: null,
    });
  }

  // The bill must equal what the Payment Schedule says will be paid.
  if (c.amount_og === null) warnings.push("Invoice Amount kosong: total bill tidak bisa dicocokkan dengan Amount to Transfer.");
  else if (!total.eq(c.amount_og)) {
    return { ok: false, problems: [`Total bill ${num(total)} berbeda dari Amount to Transfer ${num(c.amount_og)}. Periksa DPP dan Invoice Amount.`] };
  }

  const division = text(row.division);
  const department = c.department;
  if (!division) warnings.push("Division kosong: TrackingOption1 dan TrackingOption2 dikosongkan.");
  else if (!department) warnings.push("Department untuk Division ini tidak ditemukan: TrackingOption2 dikosongkan.");

  const header: BillHeader = {
    payment_schedule_id: row.id,
    reference_no: c.xero_ref!,
    contact_name: contact!,
    email_address: text(row.vendor_email),
    po_address_line1: null, po_address_line2: null, po_address_line3: null, po_address_line4: null,
    po_city: null, po_region: null, po_postal_code: null, po_country: null, // not stored anywhere yet
    invoice_number: c.xero_ref!,
    invoice_date: invoiceDate!,
    due_date: dueDate!,
    currency: currency!,
    total: num(total),
    // Names are fixed; the options are the Payment Schedule's Division and Department.
    tracking_name1: TRACKING_DIVISION, tracking_option1: division,
    tracking_name2: TRACKING_DEPARTMENT, tracking_option2: department,
  };
  return { ok: true, header, lines, warnings };
}

type Fingerprintable = Omit<BillHeader, "payment_schedule_id"> & { payment_schedule_id?: string };
const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : D(v).toFixed());

/**
 * Canonical text of a bill (header + lines), identical for a freshly built bill and for one read back from the
 * database (numeric columns come back as "6049500.000000"). Used to tell whether the Payment Schedule changed since.
 */
export function fingerprint(h: Fingerprintable, lines: BillLine[]): string {
  return JSON.stringify({
    h: [h.reference_no, h.contact_name, h.email_address, h.po_address_line1, h.po_address_line2, h.po_address_line3, h.po_address_line4,
      h.po_city, h.po_region, h.po_postal_code, h.po_country, h.invoice_number, h.invoice_date, h.due_date, h.currency, n(h.total),
      h.tracking_name1, h.tracking_option1, h.tracking_name2, h.tracking_option2],
    l: [...lines].sort((a, b) => a.line_no - b.line_no).map((l) => [l.line_no, l.kind, l.description, n(l.quantity), n(l.unit_amount), l.account_code, l.tax_type, n(l.tax_amount)]),
  });
}
