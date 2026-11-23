import {
  D, accumulatedPayment, amountToTransfer, computeTaxes, convert, paymentNo, xeroReference,
  type Npwp, type Num, type RateRow,
} from "./calc";

/** A stored row (inputs only), as returned by the database. */
export interface DbRow {
  id: string;
  fiscal_year: number | null;
  seq: number | null;
  extraction_id: string | null;
  attachment_id: string | null;
  ai_values: Record<string, string | null> | null;
  xero_import_status: string | null;
  [k: string]: unknown;
}

export interface Computed {
  no: number | null;
  payment_no: string | null;
  xero_ref: string | null;
  department: string | null;
  ppn: Num | null; pph23: Num | null; pph21: Num | null; pph42: Num | null; umkm: Num | null; pph26: Num | null;
  amount_og: Num | null;
  acc_payment: Num | null;
  acc_tax: Num | null;
  rate_idr: Num | null; amount_idr: Num | null; rate_usd: Num | null; amount_usd: Num | null;
  warnings: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const dec = (v: unknown): Num | null => {
  if (v === null || v === undefined || v === "") return null;
  try { return D(v as string | number); } catch { return null; }
};

export interface Lookups {
  /** division -> department */
  departments: Map<string, string>;
  /** ISO date -> rate, from the Rate table */
  rates: Map<string, RateRow>;
}

/**
 * Computes every derived column. Numbered rows are processed in Payment No order, because Accumulated Payment
 * depends on the rows above (same rule as the sheet). Unnumbered rows get blanks for the sequence-based columns.
 */
export function computeAll(rows: DbRow[], lk: Lookups): Map<string, Computed> {
  const numbered = rows.filter((r) => r.seq !== null && r.fiscal_year !== null).sort((a, b) => a.fiscal_year! - b.fiscal_year! || a.seq! - b.seq!);
  const out = new Map<string, Computed>();

  // The sheet runs per year, so accumulation restarts each fiscal year.
  const byYear = new Map<number, DbRow[]>();
  numbered.forEach((r) => byYear.set(r.fiscal_year!, [...(byYear.get(r.fiscal_year!) ?? []), r]));
  const acc = new Map<string, { payment: Num; tax: Num }>();
  for (const list of byYear.values()) {
    const accRows = list.map((r) => ({ vendor: str(r.vendor_name), status: str(r.payment_status), invoiceAmount: dec(r.invoice_amount) }));
    list.forEach((r, idx) => acc.set(r.id, accumulatedPayment(accRows, idx)));
  }

  for (const r of rows) {
    const warnings: string[] = [];
    const a = acc.get(r.id) ?? null;
    const dpp = dec(r.dpp);
    const npwp = (r.npwp_flag === "Y" || r.npwp_flag === "N" ? r.npwp_flag : null) as Npwp;
    const category = str(r.tax_category);
    const t = computeTaxes({ taxCategory: category, dpp, npwp, accumulatedTax: a?.tax ?? D(0) });

    if (category && dpp === null) warnings.push("Isi DPP untuk menghitung pajak.");
    if (category && /PPh 21/.test(category) && npwp === null) warnings.push("PPh 21 butuh NPWP? Y/N.");
    if (category && /PPh 21/.test(category) && !a) warnings.push("PPh 21 butuh Input Date (nomor urut) untuk akumulasi.");

    const invoiceAmount = dec(r.invoice_amount);
    const amountOg = invoiceAmount ? amountToTransfer(invoiceAmount, t, dec(r.other_adjustment)) : null;

    let fx = { rateToIdr: null as Num | null, rateToUsd: null as Num | null, amountIdr: null as Num | null, amountUsd: null as Num | null };
    const currency = str(r.currency);
    if (amountOg && currency) {
      const date = str(r.invoice_date);
      const f = convert(currency, amountOg, date ? (lk.rates.get(date) ?? null) : null);
      fx = f;
      if (f.issue === "unsupported_currency") warnings.push(`Konversi ${currency} belum didukung (hanya IDR dan USD).`);
      if (f.issue === "missing_rate") warnings.push(date ? `Belum ada Rate untuk ${date}.` : "Isi Invoice Date untuk mengambil Rate.");
    }

    const pn = r.seq !== null && r.fiscal_year !== null ? paymentNo(r.seq, r.fiscal_year) : null;
    out.set(r.id, {
      no: r.seq,
      payment_no: pn,
      xero_ref: pn ? xeroReference(pn, str(r.invoice_no)) : null,
      department: str(r.division) ? (lk.departments.get(str(r.division)!) ?? null) : null,
      ...t,
      amount_og: amountOg,
      acc_payment: a?.payment ?? null,
      acc_tax: a?.tax ?? null,
      rate_idr: fx.rateToIdr, amount_idr: fx.amountIdr, rate_usd: fx.rateToUsd, amount_usd: fx.amountUsd,
      warnings,
    });
  }
  return out;
}
