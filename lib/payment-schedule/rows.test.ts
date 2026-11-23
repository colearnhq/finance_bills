import { describe, expect, it } from "vitest";
import { D } from "./calc";
import { INPUT_COLS, parseInput } from "./columns";
import { computeAll, type DbRow } from "./rows";

const row = (o: Partial<DbRow> & Record<string, unknown>): DbRow => ({ id: "x", fiscal_year: 2026, seq: 1, extraction_id: null, attachment_id: null, ai_values: null, xero_import_status: null, ...o });
const lk = { departments: new Map([["Customer Care", "Customer Care"]]), rates: new Map([["2026-10-13", { usdIdr: D("16000") }]]) };

describe("computeAll", () => {
  it("reproduces the sample row PMTID202600735", () => {
    const r = row({ id: "a", seq: 735, vendor_name: "PT. Ivonesia Solusi Data", invoice_no: "INV/IVO/5920", invoice_date: "2026-10-13", division: "Customer Care", tax_category: "PPN + PPh 23", currency: "IDR", invoice_amount: "1884598", dpp: "1884598" });
    const c = computeAll([r], lk).get("a")!;
    expect(c.payment_no).toBe("PMTID202600735");
    expect(c.xero_ref).toBe("PMTID202600735;INV/IVO/5920");
    expect(c.department).toBe("Customer Care");
    expect(c.ppn?.toString()).toBe("207305.78");
    expect(c.pph23?.toString()).toBe("37692");
    expect(c.amount_og?.toString()).toBe("2054211.78");
    expect(c.amount_idr?.toString()).toBe("2054211.78");
    expect(c.rate_usd?.toString()).toBe("16000");
    expect(c.warnings).toEqual([]);
  });

  it("accumulates PAID amounts per vendor in Payment No order, independent of array order", () => {
    const rows = [
      row({ id: "c", seq: 3, vendor_name: "A", payment_status: "PAID", invoice_amount: "300" }),
      row({ id: "a", seq: 1, vendor_name: "A", payment_status: "PAID", invoice_amount: "100" }),
      row({ id: "b", seq: 2, vendor_name: "A", payment_status: null, invoice_amount: "50" }),
    ];
    const m = computeAll(rows, lk);
    expect(m.get("a")!.acc_payment?.toString()).toBe("100");
    expect(m.get("b")!.acc_payment?.toString()).toBe("100");
    expect(m.get("c")!.acc_payment?.toString()).toBe("400");
    expect(m.get("c")!.acc_tax?.toString()).toBe("200");
  });

  it("restarts accumulation each fiscal year", () => {
    const rows = [
      row({ id: "a", fiscal_year: 2026, seq: 1, vendor_name: "A", payment_status: "PAID", invoice_amount: "100" }),
      row({ id: "b", fiscal_year: 2027, seq: 1, vendor_name: "A", payment_status: "PAID", invoice_amount: "10" }),
    ];
    expect(computeAll(rows, lk).get("b")!.acc_payment?.toString()).toBe("10");
  });

  it("uses accumulated tax base for PPh 21 and warns when NPWP or number is missing", () => {
    const rows = [
      row({ id: "a", seq: 1, vendor_name: "P", payment_status: "PAID", invoice_amount: "70000000" }),
      row({ id: "b", seq: 2, vendor_name: "P", tax_category: "PPh 21", npwp_flag: "Y", dpp: "10000000", invoice_amount: "10000000" }),
    ];
    const m = computeAll(rows, lk);
    // accumulated payment 70,000,000 -> tax base 35,000,000 (<60,000,001): 5% of 50% of 10,000,000
    expect(m.get("b")!.pph21?.toString()).toBe("250000");
    const noFlag = computeAll([row({ id: "z", seq: 1, tax_category: "PPh 21", dpp: "1000", invoice_amount: "1000" })], lk).get("z")!;
    expect(noFlag.pph21).toBeNull();
    expect(noFlag.warnings.join(" ")).toContain("NPWP");
    const unnumbered = computeAll([row({ id: "u", seq: null, fiscal_year: null, tax_category: "PPh 21", npwp_flag: "N", dpp: "1000", invoice_amount: "1000" })], lk).get("u")!;
    expect(unnumbered.warnings.join(" ")).toContain("Input Date");
  });

  it("flags a missing rate, an unsupported currency and a missing DPP", () => {
    const usd = computeAll([row({ id: "u", currency: "USD", invoice_date: "2026-01-01", invoice_amount: "10", dpp: "10", tax_category: "PPN" })], lk).get("u")!;
    expect(usd.warnings.join(" ")).toContain("Belum ada Rate");
    expect(usd.amount_idr).toBeNull();
    const sgd = computeAll([row({ id: "s", currency: "SGD", invoice_date: "2026-10-13", invoice_amount: "10" })], lk).get("s")!;
    expect(sgd.warnings.join(" ")).toContain("SGD");
    const nodpp = computeAll([row({ id: "n", tax_category: "PPN", invoice_amount: "10" })], lk).get("n")!;
    expect(nodpp.warnings.join(" ")).toContain("DPP");
  });

  it("converts USD with the rate of the invoice date", () => {
    const c = computeAll([row({ id: "u", currency: "USD", invoice_date: "2026-10-13", invoice_amount: "180", dpp: "180" })], lk).get("u")!;
    expect(c.amount_idr?.toString()).toBe("2880000");
    expect(c.amount_usd?.toString()).toBe("180");
  });

  it("leaves blanks for an unnumbered row", () => {
    const c = computeAll([row({ id: "u", seq: null, fiscal_year: null })], lk).get("u")!;
    expect(c.payment_no).toBeNull();
    expect(c.xero_ref).toBeNull();
  });
});

describe("parseInput", () => {
  it("treats blank as null", () => expect(parseInput("date", "  ")).toEqual({ ok: true, value: null }));
  it("validates dates", () => {
    expect(parseInput("date", "2026-11-02")).toEqual({ ok: true, value: "2026-11-02" });
    expect(parseInput("date", "2026-02-30").ok).toBe(false);
    expect(parseInput("date", "2/11/2026").ok).toBe(false);
  });
  it("accepts amounts with thousands commas, rejects symbols", () => {
    expect(parseInput("money", "1,884,598.50")).toEqual({ ok: true, value: "1884598.50" });
    expect(parseInput("money", "-5000")).toEqual({ ok: true, value: "-5000" });
    for (const bad of ["Rp 100", "1.234,50", "12.34567", "abc"]) expect(parseInput("money", bad).ok).toBe(false);
  });
  it("normalises Y/N", () => {
    expect(parseInput("yn", "y")).toEqual({ ok: true, value: "Y" });
    expect(parseInput("yn", "maybe").ok).toBe(false);
  });
  it("covers every stored column in the definitions once", () => {
    const keys = INPUT_COLS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("npwp_flag");
  });
});

import { prefillFromExtraction } from "./prefill";
import type { DateField, Extraction, Field } from "@/lib/extraction/schema";

const f = (value: string | null): Field => ({ value, evidence: value, page: value ? 1 : null, source: value ? "document" : null });
const dt = (iso: string | null, ambiguous = false): DateField => ({ raw: iso, iso, ambiguous, evidence: iso, page: 1, source: "document" });
const ex = (over: Partial<Extraction> = {}): Extraction => ({
  document_type: "invoice", document_type_evidence: null, vendor_name: f("Winda Arianti"), vendor_email: f(null), vendor_tax_id: f("7311044309950001"),
  billed_to: f("PT IQ Edukasi"), invoice_no: f("INV-1"), po_no: f(null), invoice_date: dt("2026-11-02", true), due_date: dt(null), period_from: dt("2026-10-15"), period_to: dt("2026-10-30"),
  description: f("JASA TENAGA AHLI"), currency: f("IDR"), subtotal: f(null), discount: f(null), tax_amount: f(null), total: f("546000"), amount_paid: f(null), amount_due: f(null),
  line_items: [], bank_name: f("BSI"), beneficiary_name: f("Winda Arianti"), account_number: f("7301505967"), swift_code: f(null), ifsc_code: f(null), already_paid: null, notes: [], ...over,
});

describe("prefillFromExtraction", () => {
  const lists = { vendors: ["Winda Arianti", "Siti Aisah"], currencies: ["IDR", "USD"] };
  const sug = { invoiceAmount: "546000", dpp: "546000", rule: "x" };
  it("fills what is safe and leaves the accountant's fields empty", () => {
    const p = prefillFromExtraction(ex(), sug, lists);
    expect(p).toMatchObject({ vendor_name: "Winda Arianti", invoice_no: "INV-1", invoice_date: "2026-11-02", currency: "IDR", invoice_amount: "546000", dpp: "546000", npwp_no: "7311044309950001", bank_name: "BSI" });
    for (const k of ["input_date", "payment_status", "tax_category", "accounting_account", "division", "cashflow_category", "payment_type"]) expect(p).not.toHaveProperty(k);
  });
  it("does not guess a vendor, a currency outside the list or an invalid date", () => {
    const p = prefillFromExtraction(ex({ vendor_name: f("Nadila Choirunnisa"), currency: f("GBP"), invoice_date: dt("2026-02-30") }), null, lists);
    expect(p.vendor_name).toBeNull();
    expect(p.currency).toBeNull();
    expect(p.invoice_date).toBeNull();
    expect(p.invoice_amount).toBeNull();
  });
});
