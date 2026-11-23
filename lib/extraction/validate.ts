import { D, type Num } from "@/lib/payment-schedule/calc";
import type { DateField, Extraction, Field } from "./schema";

export type Severity = "error" | "warn" | "info";
export interface Issue {
  field: string;
  severity: Severity;
  code: string;
  message: string;
}

/** Values proposed for the Payment Schedule row, produced by fixed rules (not by the AI). */
export interface Suggestion {
  invoiceAmount: string | null;
  dpp: string | null;
  rule: string;
}

export interface ValidateContext {
  allowedCurrencies: string[];
  billingEntityPatterns: RegExp[];
}

/** Strict decimal: optional minus, digits, optional fraction. No separators or symbols. */
export function parseAmount(s: string | null): Num | null {
  if (s === null) return null;
  const t = s.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? D(t) : null;
}

export function isRealIsoDate(s: string | null): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const AMOUNT_FIELDS = ["subtotal", "discount", "tax_amount", "total", "amount_paid", "amount_due"] as const;
const DATE_FIELDS = ["invoice_date", "due_date", "period_from", "period_to"] as const;
const KEY_FIELDS = ["vendor_name", "invoice_no", "currency", "total"] as const;

export function validateExtraction(x: Extraction, ctx: ValidateContext): { issues: Issue[]; suggestion: Suggestion } {
  const issues: Issue[] = [];
  const add = (field: string, severity: Severity, code: string, message: string) => issues.push({ field, severity, code, message });

  if (x.document_type !== "invoice") {
    add("document_type", "warn", "not_invoice", `Dokumen dikenali sebagai "${x.document_type}", bukan invoice. Pastikan perlu diproses.`);
  }

  // Missing key data.
  if (!x.vendor_name.value) add("vendor_name", "warn", "missing", "Nama vendor tidak ditemukan.");
  if (!x.invoice_no.value) add("invoice_no", "warn", "missing", "Nomor invoice tidak ditemukan. Isi manual.");
  if (!x.invoice_date.iso && !x.invoice_date.raw) add("invoice_date", "warn", "missing", "Tanggal invoice tidak ditemukan.");
  if (!x.currency.value) add("currency", "warn", "missing", "Mata uang tidak pasti. Pilih manual.");
  if (!x.total.value && !x.subtotal.value) add("total", "warn", "missing", "Nominal tidak ditemukan.");

  // Where the value came from / whether it is backed by a quote.
  for (const k of KEY_FIELDS) {
    const f = x[k] as Field;
    if (f.value && f.source === "email_body") add(k, "info", "from_email", "Nilai ini diambil dari badan email, bukan dari invoice.");
    else if (f.value && !f.evidence) add(k, "info", "no_evidence", "Tidak ada kutipan bukti untuk nilai ini. Cek di PDF.");
  }

  // Amounts.
  const amounts: Partial<Record<(typeof AMOUNT_FIELDS)[number], Num>> = {};
  for (const k of AMOUNT_FIELDS) {
    const v = x[k].value;
    if (v === null) continue;
    const n = parseAmount(v);
    if (!n) add(k, "error", "bad_amount", `Nominal "${v}" bukan angka desimal yang valid.`);
    else amounts[k] = n;
  }
  const cur = x.currency.value?.toUpperCase() ?? null;
  if (cur && !ctx.allowedCurrencies.includes(cur)) add("currency", "warn", "unknown_currency", `Mata uang ${cur} tidak ada di daftar Currency.`);
  const tol = cur === "IDR" ? D(1) : D("0.01");
  if (cur === "IDR") {
    // "Rp 546.000" misread as 546.000 is numerically 546: look at the text, not the number. IDR amounts with
    // exactly three digits after the point are most likely a thousands separator.
    for (const k of AMOUNT_FIELDS) {
      const v = x[k].value;
      if (v && /\.\d{3}$/.test(v.trim())) add(k, "warn", "idr_thousands", `Nominal IDR "${v}" mungkin salah baca titik ribuan (bisa jadi ${v.replace(".", "")}). Cek di PDF.`);
    }
  }

  // Arithmetic.
  const items = x.line_items.map((l) => parseAmount(l.amount));
  const itemsOk = items.length > 0 && items.every((n): n is Num => n !== null);
  const itemsSum = itemsOk ? (items as Num[]).reduce((a, b) => a.plus(b), D(0)) : null;
  const target = amounts.subtotal ?? (x.tax_amount.value === null ? amounts.total : undefined);
  if (itemsSum && target && itemsSum.minus(target).abs().gt(tol)) {
    add("line_items", "warn", "items_mismatch", `Jumlah baris (${itemsSum.toString()}) tidak sama dengan ${amounts.subtotal ? "subtotal" : "total"} (${target.toString()}).`);
  }
  if (amounts.subtotal && amounts.total) {
    const expected = amounts.subtotal.minus(amounts.discount ?? 0).plus(amounts.tax_amount ?? 0);
    if (expected.minus(amounts.total).abs().gt(tol)) {
      add("total", "warn", "total_mismatch", `Subtotal - diskon + pajak = ${expected.toString()}, tetapi total tertera ${amounts.total.toString()}.`);
    }
  }

  // Dates.
  for (const k of DATE_FIELDS) {
    const d = x[k] as DateField;
    if (!d.raw && !d.iso) continue;
    if (!isRealIsoDate(d.iso)) add(k, "warn", "bad_date", `Tanggal "${d.raw ?? ""}" tidak bisa dibaca sebagai tanggal yang valid. Isi manual.`);
    else if (d.ambiguous) add(k, "warn", "ambiguous_date", `Tanggal "${d.raw}" bisa dibaca dua cara. Dibaca sebagai hari/bulan/tahun (${d.iso}). Cek di PDF.`);
  }
  const { invoice_date: inv, due_date: due, period_from: pf, period_to: pt } = x;
  if (isRealIsoDate(inv.iso) && isRealIsoDate(due.iso) && due.iso! < inv.iso!) add("due_date", "warn", "due_before_invoice", "Jatuh tempo lebih awal dari tanggal invoice.");
  if (isRealIsoDate(pf.iso) && isRealIsoDate(pt.iso) && pf.iso! > pt.iso!) add("period_from", "warn", "period_reversed", "Awal periode lebih akhir dari akhir periode.");

  // Entity and payment state.
  if (!x.billed_to.value) add("billed_to", "info", "missing", "Pihak yang ditagih tidak tertera.");
  else if (!ctx.billingEntityPatterns.some((re) => re.test(x.billed_to.value!))) {
    add("billed_to", "warn", "entity_mismatch", `Ditagihkan ke "${x.billed_to.value}", bukan entitas yang dikelola. Pastikan entitas benar.`);
  }
  if (x.already_paid || (amounts.amount_due && amounts.amount_due.isZero())) {
    add("amount_due", "info", "already_paid", "Dokumen menyatakan sudah dibayar / tidak ada sisa tagihan.");
  }
  if (amounts.discount && !amounts.discount.isZero()) add("discount", "info", "has_discount", "Ada diskon. Pastikan Invoice Amount dan DPP sesuai.");
  for (const n of x.notes) add("notes", "info", "model_note", n);

  // Suggested Payment Schedule amounts, by rule: Invoice Amount = DPP = subtotal; total only when no tax is printed.
  let suggestion: Suggestion;
  if (x.subtotal.value && amounts.subtotal) suggestion = { invoiceAmount: x.subtotal.value, dpp: x.subtotal.value, rule: "subtotal tertera di dokumen" };
  else if (x.tax_amount.value !== null) {
    suggestion = { invoiceAmount: null, dpp: null, rule: "ada pajak tetapi subtotal tidak tertera: isi manual" };
    add("subtotal", "warn", "no_subtotal_with_tax", "Ada pajak tetapi subtotal tidak tertera. Invoice Amount dan DPP tidak diusulkan.");
  } else if (x.total.value && amounts.total) suggestion = { invoiceAmount: x.total.value, dpp: x.total.value, rule: "tanpa pajak tertera: total dipakai" };
  else suggestion = { invoiceAmount: null, dpp: null, rule: "nominal tidak ditemukan" };

  const order = { error: 0, warn: 1, info: 2 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, suggestion };
}
