import { describe, expect, it } from "vitest";
import { D } from "@/lib/payment-schedule/calc";
import { computeAll, type DbRow } from "@/lib/payment-schedule/rows";
import { buildXeroBill, fingerprint, type BuildResult } from "./bill";
import { billsToCsv, xeroDate, XERO_HEADERS } from "./csv";

const ACCOUNTS = { pph21: "201030201", pph23: "201030202", pph42: "201030203", umkm: "201030206", pph26: "201030202" };
const lk = { departments: new Map([["Customer Care", "Customer Care"]]), rates: new Map([["2026-11-01", { usdIdr: D("16000") }]]) };

const base = (o: Record<string, unknown> = {}): DbRow => ({
  id: "row-1", fiscal_year: 2026, seq: 737, extraction_id: null, attachment_id: null, ai_values: null, xero_import_status: null,
  vendor_name: "PT. Ivonesia Solusi Data", invoice_no: "INV/IVO/5920", invoice_date: "2026-11-01", due_date: "2026-12-01",
  description: "Sociomile Voice, Oktober", accounting_account: "2100", division: "Customer Care", currency: "IDR",
  tax_category: "PPN + PPh 23", invoice_amount: "5550000", dpp: "5550000", vendor_email: "ap@vendor.example", ...o,
});
const build = (row: DbRow, accounts: Partial<typeof ACCOUNTS> = ACCOUNTS): BuildResult => {
  const c = computeAll([row], lk).get(row.id)!;
  return buildXeroBill(row, c, accounts);
};
const ok = (r: BuildResult) => { if (!r.ok) throw new Error(r.problems.join(" | ")); return r; };

describe("buildXeroBill", () => {
  it("turns PPN + PPh 23 into 3 records: DPP, +PPN, -PPh 23 (the example from the accountants)", () => {
    const r = ok(build(base()));
    expect(r.lines.map((l) => [l.line_no, l.kind, l.unit_amount, l.account_code])).toEqual([
      [1, "dpp", "5550000", "2100"],
      [2, "ppn", "610500", null], // PPN line has no account, as in the sample
      [3, "pph23", "-111000", "201030202"],
    ]);
    expect(r.lines.map((l) => l.description)).toEqual(["Sociomile Voice, Oktober", "PPN - Sociomile Voice, Oktober", "PPh 23 - Sociomile Voice, Oktober"]);
    expect(r.lines.every((l) => l.quantity === "1" && l.tax_type === "Tax Exempt")).toBe(true);
    expect(r.header.total).toBe("6049500"); // 5,550,000 + 610,500 - 111,000
    expect(r.header.reference_no).toBe("PMTID202600737;INV/IVO/5920");
    expect(r.header.invoice_number).toBe(r.header.reference_no);
    expect(r.header).toMatchObject({ contact_name: "PT. Ivonesia Solusi Data", email_address: "ap@vendor.example", currency: "IDR", tracking_name1: "Division", tracking_option1: "Customer Care", tracking_name2: "Department", tracking_option2: "Customer Care" });
  });

  it("makes one record when there is no tax, and a PPh 26 line books to the PPh 23 & 26 account", () => {
    const none = ok(build(base({ tax_category: null })));
    expect(none.lines).toHaveLength(1);
    expect(none.header.total).toBe("5550000");
    const p26 = ok(build(base({ tax_category: "PPh 26", invoice_amount: "1000000", dpp: "1000000" })));
    expect(p26.lines.map((l) => [l.kind, l.unit_amount, l.account_code])).toEqual([["dpp", "1000000", "2100"], ["pph26", "-200000", "201030202"]]);
  });

  it("keeps the Payment Schedule's PPN exactly (no rounding added)", () => {
    const r = ok(build(base({ tax_category: "PPN", invoice_amount: "1884598", dpp: "1884598" })));
    expect(r.lines[1].unit_amount).toBe("207305.78");
  });

  it("emits several withholdings, each its own negative line", () => {
    const r = ok(build(base({ tax_category: "PPN + PPh 23 + PPh 4 ayat 2", invoice_amount: "1000000", dpp: "1000000" })));
    expect(r.lines.map((l) => [l.kind, l.unit_amount])).toEqual([["dpp", "1000000"], ["ppn", "110000"], ["pph23", "-20000"], ["pph42", "-100000"]]);
    expect(r.header.total).toBe("990000");
  });

  it("refuses with a reason for every missing required value", () => {
    const r = build(base({ vendor_name: null, invoice_no: "", invoice_date: null, due_date: null, currency: null, accounting_account: null, dpp: null, seq: null, fiscal_year: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(expect.arrayContaining([
      "Belum bernomor (isi Input Date di Payment Schedule).", "Vendor Name kosong.", "Invoice No kosong.", "Invoice Date kosong.",
      "Due Date kosong.", "Currency kosong.", "Accounting Account kosong (dipakai di baris DPP).", "DPP kosong.",
    ]));
  });

  it("refuses PPh 21 without NPWP Y/N, and a withholding whose Xero account is not configured", () => {
    const a = build(base({ tax_category: "PPh 21" }));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.problems).toEqual(["PPh 21 belum terhitung: isi NPWP? Y/N."]);
    expect(ok(build(base({ tax_category: "PPh 21", npwp_flag: "Y" }))).lines[1]).toMatchObject({ kind: "pph21", unit_amount: "-138750" }); // 5,550,000 x 50% x 5%;
    const b = build(base(), { ...ACCOUNTS, pph23: undefined });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.problems[0]).toMatch(/Akun Xero untuk PPh 23 belum diatur/);
  });

  it("refuses an Other Addition/Deduction instead of silently dropping it", () => {
    const r = build(base({ other_adjustment: "5000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Other Addition\/Deduction/);
  });

  it("refuses a bill whose total differs from Amount to Transfer (DPP vs Invoice Amount)", () => {
    const r = build(base({ invoice_amount: "6000000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Total bill .* berbeda dari Amount to Transfer/);
  });

  it("takes the tracking options from the row's Division and Department, with fixed tracking names", () => {
    const lkRow = base({ division: "Customer Care" });
    const r = ok(build(lkRow));
    expect(r.header).toMatchObject({ tracking_name1: "Division", tracking_option1: "Customer Care", tracking_name2: "Department", tracking_option2: "Customer Care" });
    const csv = billsToCsv([{ header: r.header, lines: r.lines }]).trimEnd().split("\r\n");
    expect(csv.slice(1).every((l) => l.includes(",Division,Customer Care,Department,Customer Care,IDR"))).toBe(true);
  });

  it("warns, but still builds, without Invoice Amount or Division", () => {
    const r = ok(build(base({ invoice_amount: null, division: null })));
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Invoice Amount kosong/), expect.stringMatching(/Division kosong/)]));
    // names stay fixed even when the options are unknown
    expect(r.header).toMatchObject({ tracking_name1: "Division", tracking_option1: null, tracking_name2: "Department", tracking_option2: null });
  });
});

describe("fingerprint", () => {
  it("is equal for a built bill and the same bill read back from the database", () => {
    const r = ok(build(base()));
    const fromDb = {
      ...r.header, total: "6049500.000000",
      lines: r.lines.map((l) => ({ ...l, quantity: "1.000000", unit_amount: l.unit_amount.includes(".") ? l.unit_amount : `${l.unit_amount}.000000` })),
    };
    expect(fingerprint(fromDb, fromDb.lines)).toBe(fingerprint(r.header, r.lines));
  });
  it("changes when the Payment Schedule changes", () => {
    const a = ok(build(base()));
    const b = ok(build(base({ description: "Other text" })));
    const c = ok(build(base({ invoice_amount: "6000000", dpp: "6000000" })));
    expect(fingerprint(a.header, a.lines)).not.toBe(fingerprint(b.header, b.lines));
    expect(fingerprint(a.header, a.lines)).not.toBe(fingerprint(c.header, c.lines));
  });
});

describe("billsToCsv", () => {
  it("uses the exact header of the team's sample CSV", () => {
    expect(XERO_HEADERS.join(",")).toBe(
      "Xero Reference No,*ContactName,EmailAddress,POAddressLine1,POAddressLine2,POAddressLine3,POAddressLine4,POCity,PORegion,POPostalCode,POCountry,*InvoiceNumber,*InvoiceDate,*DueDate,Total,InventoryItemCode,Description,*Quantity,*UnitAmount,*AccountCode,*TaxType,TaxAmount,TrackingName1,TrackingOption1,TrackingName2,TrackingOption2,Currency",
    );
  });
  it("writes one record per line in the sample's layout (blank Total/TaxAmount/InventoryItemCode, d/m/yyyy dates)", () => {
    const r = ok(build(base()));
    const lines = billsToCsv([{ header: r.header, lines: r.lines }]).trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('PMTID202600737;INV/IVO/5920,PT. Ivonesia Solusi Data,ap@vendor.example,,,,,,,,,PMTID202600737;INV/IVO/5920,1/11/2026,1/12/2026,,,"Sociomile Voice, Oktober",1,5550000,2100,Tax Exempt,,Division,Customer Care,Department,Customer Care,IDR');
    expect(lines[2]).toContain(',"PPN - ');
    expect(lines[2]).toContain(",1,610500,,Tax Exempt,");
    expect(lines[3]).toContain(",1,-111000,201030202,Tax Exempt,");
  });
  it("defuses spreadsheet formulas in text but never touches negative amounts", () => {
    const r = ok(build(base({ description: "=HYPERLINK(1)" })));
    const csv = billsToCsv([{ header: r.header, lines: r.lines }]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain(",-111000,");
  });
  it("formats dates like the sample", () => {
    expect(xeroDate("2026-01-01")).toBe("1/1/2026");
    expect(xeroDate("2026-12-31")).toBe("31/12/2026");
    expect(xeroDate("")).toBe("");
  });
});
