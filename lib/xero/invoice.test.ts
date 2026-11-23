import { describe, expect, it } from "vitest";
import { attachmentName, buildInvoicePayload, buildRefData, pickContact, type BillSnapshot, type RefData } from "./invoice";

const bill = (o: Partial<BillSnapshot> = {}): BillSnapshot => ({
  id: "b1", payment_schedule_id: "r1", reference_no: "PMTID202600737;INV-1", contact_name: "PT. Ivonesia Solusi Data", email_address: null,
  po_address_line1: null, po_address_line2: null, po_address_line3: null, po_address_line4: null, po_city: null, po_region: null, po_postal_code: null, po_country: null,
  invoice_number: "PMTID202600737;INV-1", invoice_date: "2026-11-01", due_date: "2026-12-01", currency: "IDR", total: "6049500",
  tracking_name1: "Division", tracking_option1: "Customer Care", tracking_name2: "Department", tracking_option2: "Customer Care",
  xero_bill_lines: [
    { line_no: 1, kind: "dpp", description: "Sociomile", quantity: "1", unit_amount: "5550000", account_code: "2100", tax_type: "Tax Exempt", tax_amount: null },
    { line_no: 2, kind: "ppn", description: "PPN - Sociomile", quantity: "1", unit_amount: "610500", account_code: null, tax_type: "Tax Exempt", tax_amount: null },
    { line_no: 3, kind: "pph23", description: "PPh 23 - Sociomile", quantity: "1", unit_amount: "-111000", account_code: "201030202", tax_type: "Tax Exempt", tax_amount: null },
  ],
  ...o,
});
type RefInput = { accounts?: Parameters<typeof buildRefData>[0]; taxRates?: Parameters<typeof buildRefData>[1]; tracking?: Parameters<typeof buildRefData>[2] };
const ref = (o: RefInput = {}): RefData => buildRefData(
  o.accounts ?? [{ Code: "2100", Status: "ACTIVE" }, { Code: "201030202", Status: "ACTIVE" }],
  o.taxRates ?? [{ Name: "Tax Exempt", TaxType: "EXEMPTEXPENSES", Status: "ACTIVE", EffectiveRate: 0 }, { Name: "Sales Tax", TaxType: "OUTPUT", Status: "ACTIVE", EffectiveRate: 10 }],
  o.tracking ?? [
    { Name: "Division", Status: "ACTIVE", Options: [{ Name: "Customer Care", Status: "ACTIVE" }, { Name: "Sales", Status: "ACTIVE" }] },
    { Name: "Department", Status: "ACTIVE", Options: [{ Name: "Customer Care", Status: "ACTIVE" }] },
  ],
);
const problems = (b: BillSnapshot, r = ref()) => { const x = buildInvoicePayload(b, "contact-1", r); return x.ok ? [] : x.problems; };

describe("buildInvoicePayload", () => {
  it("builds a DRAFT ACCPAY bill with every line on the 0% tax rate and the right tracking", () => {
    const r = buildInvoicePayload(bill(), "contact-1", ref());
    if (!r.ok) throw new Error(r.problems.join());
    expect(r.payload).toMatchObject({
      Type: "ACCPAY", Status: "DRAFT", Contact: { ContactID: "contact-1" }, InvoiceNumber: "PMTID202600737;INV-1", Reference: "PMTID202600737;INV-1",
      Date: "2026-11-01", DueDate: "2026-12-01", CurrencyCode: "IDR", LineAmountTypes: "Exclusive",
    });
    expect(r.payload.LineItems).toEqual([
      { Description: "Sociomile", Quantity: 1, UnitAmount: 5550000, AccountCode: "2100", TaxType: "EXEMPTEXPENSES", Tracking: [{ Name: "Division", Option: "Customer Care" }, { Name: "Department", Option: "Customer Care" }] },
      { Description: "PPN - Sociomile", Quantity: 1, UnitAmount: 610500, TaxType: "EXEMPTEXPENSES", Tracking: [{ Name: "Division", Option: "Customer Care" }, { Name: "Department", Option: "Customer Care" }] },
      { Description: "PPh 23 - Sociomile", Quantity: 1, UnitAmount: -111000, AccountCode: "201030202", TaxType: "EXEMPTEXPENSES", Tracking: [{ Name: "Division", Option: "Customer Care" }, { Name: "Department", Option: "Customer Care" }] },
    ]);
    expect("AccountCode" in r.payload.LineItems[1]).toBe(false); // the PPN line has no account, as in the sample
  });

  it("uses Xero's own spelling of tracking names and options", () => {
    const r = buildInvoicePayload(bill({ tracking_option1: "customer care" }), "c", ref());
    if (!r.ok) throw new Error(r.problems.join());
    expect(r.payload.LineItems[0].Tracking[0]).toEqual({ Name: "Division", Option: "Customer Care" });
  });

  it("refuses an account that is missing or inactive in Xero", () => {
    expect(problems(bill(), ref({ accounts: [{ Code: "201030202", Status: "ACTIVE" }] }))).toContain("Akun 2100 tidak ada di Xero.");
    expect(problems(bill(), ref({ accounts: [{ Code: "2100", Status: "ARCHIVED" }, { Code: "201030202", Status: "ACTIVE" }] }))).toContain("Akun 2100 tidak aktif di Xero.");
  });

  it("refuses when the tax rate is missing or is not 0%", () => {
    expect(problems(bill(), ref({ taxRates: [{ Name: "Other", TaxType: "X", Status: "ACTIVE", EffectiveRate: 0 }] }))[0]).toMatch(/Tax rate "Tax Exempt" tidak ditemukan/);
    expect(problems(bill(), ref({ taxRates: [{ Name: "Tax Exempt", TaxType: "T", Status: "ACTIVE", EffectiveRate: 10 }] })).join(" ")).toMatch(/bukan 0%/);
    expect(problems(bill(), ref({ taxRates: [{ Name: "Tax Exempt", TaxType: "T", Status: "ACTIVE" }] })).join(" ")).toMatch(/bukan 0%/); // rate unreadable: refuse, do not assume 0
    expect(problems(bill(), ref({ taxRates: [{ Name: "Tax Exempt", TaxType: "T", Status: "ARCHIVED", EffectiveRate: 0 }] })).join(" ")).toMatch(/tidak ditemukan/);
  });

  it("refuses a tracking category or option that does not exist in Xero (and never creates one)", () => {
    expect(problems(bill({ tracking_option1: "Ghost" }))).toEqual(['Opsi "Ghost" belum ada di kategori tracking "Division" di Xero. Tambahkan di Xero (kami tidak membuatnya).']);
    expect(problems(bill({ tracking_name2: "Region", tracking_option2: "X" }))).toEqual(['Kategori tracking "Region" tidak ada atau tidak aktif di Xero.']);
  });

  it("skips tracking whose option is empty instead of failing", () => {
    const r = buildInvoicePayload(bill({ tracking_option1: null, tracking_option2: null }), "c", ref());
    if (!r.ok) throw new Error(r.problems.join());
    expect(r.payload.LineItems.every((l) => l.Tracking.length === 0)).toBe(true);
  });

  it("refuses amounts Xero would round, a missing Description, and totals that do not add up", () => {
    const six = bill({ total: "6049500.123456", xero_bill_lines: bill().xero_bill_lines.map((l) => (l.kind === "ppn" ? { ...l, unit_amount: "610500.123456" } : l)) });
    expect(problems(six).join(" ")).toMatch(/lebih dari 4 desimal/);
    const noDesc = bill({ xero_bill_lines: bill().xero_bill_lines.map((l) => (l.kind === "dpp" ? { ...l, description: " " } : l)) });
    expect(problems(noDesc).join(" ")).toMatch(/Description kosong/);
    expect(problems(bill({ total: "1" })).join(" ")).toMatch(/tidak sama dengan total bill/);
    expect(problems(bill({ xero_bill_lines: [] })).join(" ")).toMatch(/tidak punya baris/);
  });

  it("accepts 4 decimals and keeps them", () => {
    const b = bill({ total: "100.1234", xero_bill_lines: [{ line_no: 1, kind: "dpp", description: "d", quantity: "1", unit_amount: "100.1234", account_code: "2100", tax_type: "Tax Exempt", tax_amount: null }] });
    const r = buildInvoicePayload(b, "c", ref());
    if (!r.ok) throw new Error(r.problems.join());
    expect(r.payload.LineItems[0].UnitAmount).toBe(100.1234);
  });
});

describe("pickContact", () => {
  const c = (name: string, status = "ACTIVE") => ({ ContactID: `id-${name}`, Name: name, ContactStatus: status });
  it("matches the name ignoring case and spaces", () => {
    expect(pickContact(" pt. ivonesia ", [c("PT. Ivonesia")])).toEqual({ ok: true, contactId: "id-PT. Ivonesia" });
  });
  it("refuses a missing, archived or duplicated contact", () => {
    expect(pickContact("X", [])).toMatchObject({ ok: false });
    expect(pickContact("X", [c("X", "ARCHIVED")])).toMatchObject({ ok: false });
    const dup = pickContact("X", [c("X"), { ...c("x"), ContactID: "other" }]);
    expect(dup).toMatchObject({ ok: false });
    if (!dup.ok) expect(dup.problem).toMatch(/2 kontak aktif/);
  });
});

describe("attachmentName", () => {
  it("is stable and safe", () => {
    expect(attachmentName({ reference_no: "PMTID202600737;INV/IVO 5920" })).toBe("PMTID202600737.pdf");
    expect(attachmentName({ reference_no: ";x" })).toBe("bill.pdf");
  });
});
