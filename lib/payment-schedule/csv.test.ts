import { describe, expect, it } from "vitest";
import { D } from "./calc";
import { csvCell, sheetDate, toCsv } from "./csv";
import { computeAll, type DbRow } from "./rows";

describe("csv helpers", () => {
  it("formats dates like the sheet", () => {
    expect(sheetDate("2026-10-19")).toBe("19 Oct 26");
    expect(sheetDate(null)).toBe("");
  });
  it("quotes cells and defuses spreadsheet formulas in text", () => {
    expect(csvCell('a,"b"', true)).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)", true)).toBe("'=HYPERLINK(1)");
    expect(csvCell("-cmd", true)).toBe("'-cmd");
    expect(csvCell("-5000", true)).toBe("-5000");
    expect(csvCell("=x", false)).toBe("=x");
  });
});

describe("toCsv", () => {
  const rows: DbRow[] = [
    { id: "b", fiscal_year: null, seq: null, extraction_id: null, attachment_id: null, ai_values: null, xero_import_status: null, description: "draft" },
    {
      id: "a", fiscal_year: 2026, seq: 735, extraction_id: null, attachment_id: null, ai_values: null, xero_import_status: null,
      input_date: "2026-10-19", vendor_name: "PT. Ivonesia Solusi Data", invoice_no: "INV/IVO/5920", invoice_date: "2026-10-13", due_date: "2026-11-12",
      description: "Payment for Sociomile Voice, September", accounting_account: "2100", tax_category: "PPN + PPh 23", currency: "IDR", invoice_amount: 1884598, dpp: "1884598",
    },
  ];
  const computed = computeAll(rows, { departments: new Map(), rates: new Map([["2026-10-13", { usdIdr: D(16000) }]]) });
  const csv = toCsv(rows, computed, { accountNames: new Map([["2100", "Accrued Software and Subscription"]]) });
  const [header, first, second] = csv.trim().split("\r\n");

  it("uses the template header and puts numbered rows first", () => {
    expect(header.startsWith("No.,Payment No,Xero Reference No,Input Date,Payment Status,Vendor Name")).toBe(true);
    expect(header.split(",")).toHaveLength(50);
    expect(first.startsWith("735,PMTID202600735,PMTID202600735;INV/IVO/5920,19 Oct 26,,PT. Ivonesia Solusi Data")).toBe(true);
    expect(second.startsWith(",,,")).toBe(true);
  });
  it("fills computed columns and the account name", () => {
    expect(first).toContain("Accrued Software and Subscription");
    expect(first).toContain("207305.78");
    expect(first).toContain("37692.00");
    expect(first).toContain("2054211.78");
    expect(first).toContain('"Payment for Sociomile Voice, September"');
  });
});
