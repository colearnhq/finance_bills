import { describe, expect, it } from "vitest";
import { parseRowInput } from "./columns";

describe("parseRowInput", () => {
  it("parses several fields and upper-cases Payment Status", () => {
    const r = parseRowInput({ invoice_amount: "1,500.50", payment_status: "paid", invoice_date: "2026-10-19", vendor_name: " Acme " });
    expect(r).toEqual({ ok: true, values: { invoice_amount: "1500.50", payment_status: "PAID", invoice_date: "2026-10-19", vendor_name: "Acme" } });
  });
  it("turns blanks into null", () => {
    expect(parseRowInput({ po_no: "  " })).toEqual({ ok: true, values: { po_no: null } });
  });
  it("collects an error per bad field and unknown columns", () => {
    const r = parseRowInput({ invoice_date: "19/10/2026", npwp_flag: "X", nope: "1", dpp: "12" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["invoice_date", "nope", "npwp_flag"]);
  });
});
