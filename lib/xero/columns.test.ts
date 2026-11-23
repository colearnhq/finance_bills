import { describe, expect, it } from "vitest";
import { COLS, money } from "./columns";
import { billsToCsv } from "./csv";
import { normalizeBillNumbers } from "./normalize";

// The shape PostgREST really returns: numeric columns arrive as JSON numbers, not strings (this crashed the page once).
const fromDb = {
  id: "b1", status: "prepared", reference_no: "PMTID202600737;INV-1", contact_name: "PT. Ivonesia", email_address: null,
  po_address_line1: null, po_address_line2: null, po_address_line3: null, po_address_line4: null, po_city: null, po_region: null, po_postal_code: null, po_country: null,
  invoice_number: "PMTID202600737;INV-1", invoice_date: "2026-11-01", due_date: "2026-12-01", currency: "IDR", total: 6049500,
  tracking_name1: "Division", tracking_option1: "Customer Care", tracking_name2: "Department", tracking_option2: "Customer Care",
  xero_bill_lines: [
    { line_no: 1, kind: "dpp", description: "Sociomile", quantity: 1, unit_amount: 5550000, account_code: "2100", tax_type: "Tax Exempt", tax_amount: null },
    { line_no: 2, kind: "ppn", description: "PPN - Sociomile", quantity: 1, unit_amount: 610500.5, account_code: null, tax_type: "Tax Exempt", tax_amount: null },
    { line_no: 3, kind: "pph23", description: "PPh 23 - Sociomile", quantity: 1, unit_amount: -111000, account_code: "201030202", tax_type: "Tax Exempt", tax_amount: null },
  ],
};

describe("money", () => {
  it("formats strings, database numerics and real numbers, never calling string methods on a number", () => {
    expect(money("6049500.000000")).toBe("6,049,500");
    expect(money(6049500)).toBe("6,049,500");
    expect(money(610500.5)).toBe("610,500.5");
    expect(money("-111000")).toBe("-111,000");
    expect(money(null)).toBe("");
    expect(money(undefined)).toBe("");
    expect(money("")).toBe("");
  });
});

describe("normalizeBillNumbers", () => {
  it("turns numeric columns into exact decimal strings", () => {
    const n = normalizeBillNumbers(fromDb);
    expect(n.total).toBe("6049500");
    expect(n.xero_bill_lines.map((l) => [l.quantity, l.unit_amount, l.tax_amount])).toEqual([["1", "5550000", null], ["1", "610500.5", null], ["1", "-111000", null]]);
  });
});

describe("table columns on a bill read from the database", () => {
  it("renders every column of every line, with and without normalising", () => {
    for (const bill of [fromDb, normalizeBillNumbers(fromDb)]) {
      const rows = bill.xero_bill_lines.map((line) => COLS.map((c) => c.get({ header: bill as never, line: line as never })));
      expect(rows).toHaveLength(3);
      const idx = (label: string) => COLS.findIndex((c) => c.label === label);
      expect(rows.map((r) => r[idx("*UnitAmount")])).toEqual(["5,550,000", "610,500.5", "-111,000"]);
      expect(rows.every((r) => r[idx("Total")] === "6,049,500" && r[idx("*Quantity")] === "1")).toBe(true);
      expect(rows[0][idx("*InvoiceDate")]).toBe("1/11/2026");
    }
    expect(COLS).toHaveLength(27);
  });
  it("produces the CSV from the raw database shape too", () => {
    const csv = billsToCsv([{ header: fromDb as never, lines: fromDb.xero_bill_lines as never }]);
    expect(csv).toContain(",1,610500.5,,Tax Exempt,");
    expect(csv).toContain(",1,-111000,201030202,Tax Exempt,");
  });
});
