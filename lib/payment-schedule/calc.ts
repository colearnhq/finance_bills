/**
 * Payment Schedule calculations: a deterministic port of the team's Google Sheet formulas.
 *
 * Source of truth is the sheet, copied as-is (rates, rounding, quirks). Nothing here is
 * AI-generated. Decimal.js is used throughout; never use JS floats for money.
 *
 * Column letters in comments refer to the sheet ("Template Payment Schedule").
 */
import Decimal from "decimal.js";

// Sheet ROUND() rounds half away from zero.
const Dec = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP, precision: 40 });
export type Num = Decimal;
export const D = (v: Decimal.Value) => new Dec(v);

/**
 * Which tax categories trigger which tax. In the sheet these are regex cells W3:AB3.
 * ASSUMPTION (confirmed by user, to be checked by accountants): the pattern is the tax name,
 * so "PPN + PPh 23" triggers both PPN and PPh 23.
 */
export const TAX_TRIGGERS = {
  ppn: /PPN/,
  pph23: /PPh 23/,
  pph21: /PPh 21/,
  pph42: /PPh 4 ayat 2/,
  umkm: /PPh Final UMKM/,
  pph26: /PPh 26/,
} as const;

/** Round to whole units like the sheet's ROUND(x,0). */
const round0 = (x: Num) => x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

export type Npwp = "Y" | "N" | null;

export interface TaxInput {
  taxCategory: string | null;
  dpp: Num | null;
  /** Column AP (NPWP? Y/N). Required for PPh 21 only. */
  npwp: Npwp;
  /** Column AF: accumulated payment (tax) for this vendor, see accumulatedPayments(). */
  accumulatedTax: Num;
}

export interface TaxResult {
  ppn: Num | null;
  pph23: Num | null;
  pph21: Num | null;
  pph42: Num | null;
  umkm: Num | null;
  pph26: Num | null;
}

// PPh 21 progressive layers (sheet formula for column Y). Thresholds are compared with
// accumulated tax base (AF) using MATCH(...,1): the largest threshold <= AF.
const PPH21_THRESHOLDS = [0, 60000001, 250000001, 500000001, 5000000001];
const PPH21_RATES = {
  Y: [0.05, 0.15, 0.25, 0.3, 0.35],
  N: [0.06, 0.18, 0.3, 0.36, 0.42],
} as const;

function pph21(dpp: Num, npwp: Npwp, accumulatedTax: Num): Num | null {
  if (npwp === null) return null; // sheet: AP4="" -> ""
  let idx = 0;
  PPH21_THRESHOLDS.forEach((t, i) => {
    if (accumulatedTax.gte(t)) idx = i;
  });
  return round0(dpp.mul("0.5").mul(PPH21_RATES[npwp][idx]));
}

/** Tax amounts. null means "blank" in the sheet (tax not applicable). */
export function computeTaxes(i: TaxInput): TaxResult {
  const none: TaxResult = { ppn: null, pph23: null, pph21: null, pph42: null, umkm: null, pph26: null };
  if (!i.taxCategory || i.dpp === null) return none;
  const c = i.taxCategory;
  const v = i.dpp;
  return {
    ppn: TAX_TRIGGERS.ppn.test(c) ? v.mul("0.11") : null, // NOT rounded in the sheet
    pph23: TAX_TRIGGERS.pph23.test(c) ? round0(v.mul("0.02")) : null,
    pph21: TAX_TRIGGERS.pph21.test(c) ? pph21(v, i.npwp, i.accumulatedTax) : null,
    pph42: TAX_TRIGGERS.pph42.test(c) ? v.mul("0.10") : null, // NOT rounded in the sheet
    umkm: TAX_TRIGGERS.umkm.test(c) ? round0(v.mul("0.005")) : null,
    // Flat 20% as in the sheet. No gross-up, no treaty rate: both are open questions.
    pph26: TAX_TRIGGERS.pph26.test(c) ? round0(v.mul("0.20")) : null,
  };
}

const z = (x: Num | null) => x ?? D(0);

/** Column AD: U + W - X - Y - Z - AA - AB + AC. */
export function amountToTransfer(
  invoiceAmount: Num,
  t: TaxResult,
  other: Num | null,
): Num {
  return invoiceAmount
    .plus(z(t.ppn))
    .minus(z(t.pph23))
    .minus(z(t.pph21))
    .minus(z(t.pph42))
    .minus(z(t.umkm))
    .minus(z(t.pph26))
    .plus(z(other));
}

export interface AccumulatedRow {
  vendor: string | null;
  status: string | null;
  invoiceAmount: Num | null;
}

/**
 * Columns AE/AF. SUMIFS(U$4:U{n}, F$4:F{n}, vendor, E$4:E{n}, "PAID"): sum of Invoice Amount of
 * rows from the first row to this row, same vendor, status PAID. Includes the current row when it
 * is PAID, so the order of rows matters. `rows` must be ordered by No.
 */
export function accumulatedPayment(rows: AccumulatedRow[], index: number): { payment: Num; tax: Num } {
  const me = rows[index];
  let sum = D(0);
  for (let k = 0; k <= index; k++) {
    const r = rows[k];
    if (r.vendor === me.vendor && r.status === "PAID" && r.invoiceAmount) sum = sum.plus(r.invoiceAmount);
  }
  return { payment: sum, tax: sum.mul("0.5") };
}

/** Exchange rates for one date, as in the Rate sheet. */
export interface RateRow {
  usdIdr: Num; // "MID USD -> IDR (BS)": IDR per 1 USD
}

export type FxIssue = "unsupported_currency" | "missing_rate";

export interface FxResult {
  rateToIdr: Num | null;
  rateToUsd: Num | null;
  amountIdr: Num | null;
  amountUsd: Num | null;
  issue: FxIssue | null;
}

/**
 * Columns AG, AH, AI, AJ. Only IDR and USD are handled, as in the sheet. SGD/INR/AED/EUR return
 * issue "unsupported_currency" instead of inventing a conversion. A missing rate for the invoice
 * date (exact match, like VLOOKUP(...,0)) returns "missing_rate".
 */
export function convert(currency: string | null, amountOg: Num, rate: RateRow | null): FxResult {
  const empty = { rateToIdr: null, rateToUsd: null, amountIdr: null, amountUsd: null };
  if (currency === "IDR") {
    if (!rate) return { ...empty, rateToIdr: D(1), amountIdr: amountOg, issue: "missing_rate" };
    return {
      rateToIdr: D(1),
      rateToUsd: rate.usdIdr,
      amountIdr: amountOg,
      amountUsd: amountOg.div(rate.usdIdr),
      issue: null,
    };
  }
  if (currency === "USD") {
    if (!rate) return { ...empty, rateToUsd: D(1), amountUsd: amountOg, issue: "missing_rate" };
    return {
      rateToIdr: rate.usdIdr,
      rateToUsd: D(1),
      amountIdr: amountOg.mul(rate.usdIdr),
      amountUsd: amountOg,
      issue: null,
    };
  }
  return { ...empty, issue: "unsupported_currency" };
}

/** Columns A/B/C. Sheet pads the sequence to 5 digits: PMTID2026 + 00735. */
export function paymentNo(seq: number, year: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99999) throw new RangeError("seq must be 1..99999");
  return `PMTID${year}${String(seq).padStart(5, "0")}`;
}

/** Column C. */
export function xeroReference(paymentNo: string, invoiceNo: string | null): string {
  return `${paymentNo};${invoiceNo ?? ""}`;
}
