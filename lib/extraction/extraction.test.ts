import { describe, expect, it } from "vitest";
import { BILLING_ENTITY_PATTERNS, DEFAULT_CURRENCIES } from "./config";
import type { DateField, Extraction, Field } from "./schema";
import { isRealIsoDate, parseAmount, validateExtraction } from "./validate";
import { matchVendor, normalizeName } from "./vendor-match";

const f = (value: string | null, extra: Partial<Field> = {}): Field => ({ value, evidence: value ? `"${value}"` : null, page: value ? 1 : null, source: value ? "document" : null, ...extra });
const d = (iso: string | null, raw: string | null = iso, ambiguous = false): DateField => ({ raw, iso, ambiguous, evidence: raw, page: raw ? 1 : null, source: raw ? "document" : null });

const base = (): Extraction => ({
  document_type: "invoice", document_type_evidence: "INVOICE",
  vendor_name: f("CodeRabbit Inc"), vendor_email: f(null), vendor_tax_id: f(null), billed_to: f("PT IQ Edukasi"),
  invoice_no: f("CR297231"), po_no: f(null),
  invoice_date: d("2026-11-05", "Nov 05, 2026"), due_date: d(null, null), period_from: d(null, null), period_to: d(null, null),
  description: f("Essentials (Monthly)"), currency: f("USD"),
  subtotal: f(null), discount: f(null), tax_amount: f(null), total: f("180.00"), amount_paid: f("180.00"), amount_due: f("0.00"),
  line_items: [{ description: "Essentials", quantity: "6", unit_price: "30.00", amount: "180.00" }],
  bank_name: f(null), beneficiary_name: f(null), account_number: f(null), swift_code: f(null), ifsc_code: f(null),
  already_paid: true, notes: [],
});
const ctx = { allowedCurrencies: DEFAULT_CURRENCIES, billingEntityPatterns: BILLING_ENTITY_PATTERNS };
const codes = (x: Extraction) => validateExtraction(x, ctx).issues.map((i) => i.code);

describe("parseAmount / isRealIsoDate", () => {
  it("accepts plain decimals only", () => {
    expect(parseAmount("546000")?.toString()).toBe("546000");
    expect(parseAmount("-12.50")?.toString()).toBe("-12.5");
    for (const bad of ["Rp 546.000", "1,234.50", "12.", "", "abc", null]) expect(parseAmount(bad as string | null)).toBeNull();
  });
  it("rejects impossible dates", () => {
    expect(isRealIsoDate("2026-02-28")).toBe(true);
    expect(isRealIsoDate("2026-02-30")).toBe(false);
    expect(isRealIsoDate("26-02-01")).toBe(false);
  });
});

describe("validateExtraction", () => {
  it("passes a clean no-tax invoice and notes it was already paid", () => {
    const r = validateExtraction(base(), ctx);
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(codes(base())).toContain("already_paid");
    expect(r.suggestion).toMatchObject({ invoiceAmount: "180.00", dpp: "180.00" });
  });

  it("flags ambiguous dates but keeps the day/month reading", () => {
    const x = base();
    x.invoice_date = d("2026-11-02", "2/11/2026", true);
    const i = validateExtraction(x, ctx).issues.find((v) => v.code === "ambiguous_date");
    expect(i?.message).toContain("2026-11-02");
  });

  it("flags impossible dates and reversed due dates", () => {
    const x = base();
    x.invoice_date = d("2026-02-30", "30/2/2026");
    expect(codes(x)).toContain("bad_date");
    const y = base();
    y.due_date = d("2026-10-01", "1 Oct 2026");
    expect(codes(y)).toContain("due_before_invoice");
  });

  it("flags a billing entity that is not ours", () => {
    const x = base();
    x.billed_to = f("IQ Edu Pte Ltd");
    expect(codes(x)).toContain("entity_mismatch");
  });

  it("checks line items and totals", () => {
    const x = base();
    x.line_items = [{ description: "a", quantity: "1", unit_price: "100", amount: "100" }];
    expect(codes(x)).toContain("items_mismatch");
    const y = base();
    y.subtotal = f("100.00"); y.tax_amount = f("11.00"); y.total = f("120.00");
    y.line_items = [{ description: "a", quantity: "1", unit_price: "100", amount: "100.00" }];
    expect(codes(y)).toContain("total_mismatch");
  });

  it("does not propose amounts when tax is printed without a subtotal", () => {
    const x = base();
    x.tax_amount = f("11.00"); x.total = f("111.00");
    const r = validateExtraction(x, ctx);
    expect(r.suggestion.invoiceAmount).toBeNull();
    expect(r.issues.map((i) => i.code)).toContain("no_subtotal_with_tax");
  });

  it("uses the subtotal as Invoice Amount and DPP when printed", () => {
    const x = base();
    x.subtotal = f("1884598.00"); x.tax_amount = f("207305.78"); x.total = f("2091903.78"); x.currency = f("IDR");
    x.line_items = [{ description: "svc", quantity: "1", unit_price: "1884598", amount: "1884598.00" }];
    const r = validateExtraction(x, ctx);
    expect(r.suggestion).toMatchObject({ invoiceAmount: "1884598.00", dpp: "1884598.00" });
    expect(r.issues.map((i) => i.code)).not.toContain("total_mismatch");
  });

  it("catches IDR amounts that look mis-parsed and unknown currencies", () => {
    const x = base();
    x.currency = f("IDR"); x.total = f("546.000");
    x.line_items = [];
    expect(codes(x)).toContain("idr_thousands");
    const y = base();
    y.currency = f("GBP");
    expect(codes(y)).toContain("unknown_currency");
  });

  it("marks values taken from the email body and non-invoice documents", () => {
    const x = base();
    x.document_type = "receipt";
    x.invoice_no = f("X1", { source: "email_body" });
    expect(codes(x)).toEqual(expect.arrayContaining(["not_invoice", "from_email"]));
  });

  it("puts errors before warnings before info", () => {
    const x = base();
    x.total = f("Rp 1.000"); x.vendor_name = f(null);
    const sev = validateExtraction(x, ctx).issues.map((i) => i.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a] - ({ error: 0, warn: 1, info: 2 })[b]));
    expect(sev[0]).toBe("error");
  });
});

describe("vendor matching", () => {
  const vendors = ["PT. Ivonesia Solusi Data", "Winda Arianti", "CodeRabbit", "Supabase Inc", "Siti Aisah", "Siti Aisyah Putri"];
  it("ignores legal suffixes and punctuation", () => {
    expect(normalizeName("PT. Ivonesia Solusi Data, Tbk")).toBe("ivonesia solusi data");
  });
  it("finds exact matches after normalisation", () => {
    expect(matchVendor("Ivonesia Solusi Data PT", vendors).exact).toBe("PT. Ivonesia Solusi Data");
    expect(matchVendor("CodeRabbit Inc", vendors).exact).toBe("CodeRabbit");
  });
  it("handles reordered and near names as suggestions, not exact", () => {
    const m = matchVendor("Arianti Winda", vendors);
    expect(m.exact).toBeNull();
    expect(m.suggestions[0].name).toBe("Winda Arianti");
    expect(matchVendor("Siti Aisa", vendors).suggestions.map((s) => s.name)).toContain("Siti Aisah");
  });
  it("returns nothing for unknown or empty names", () => {
    expect(matchVendor("Zzzz Qqqq", vendors)).toEqual({ exact: null, suggestions: [] });
    expect(matchVendor(null, vendors)).toEqual({ exact: null, suggestions: [] });
  });
});
