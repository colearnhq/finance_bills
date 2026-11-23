import { describe, expect, it } from "vitest";
import {
  D,
  accumulatedPayment,
  amountToTransfer,
  computeTaxes,
  convert,
  paymentNo,
  xeroReference,
} from "./calc";

const base = { npwp: null, accumulatedTax: D(0) } as const;

describe("computeTaxes", () => {
  it("matches the sample row PMTID202600735 (PPN + PPh 23)", () => {
    const t = computeTaxes({ ...base, taxCategory: "PPN + PPh 23", dpp: D("1884598") });
    expect(t.ppn?.toString()).toBe("207305.78"); // 11%, not rounded
    expect(t.pph23?.toString()).toBe("37692"); // 37691.96 rounded
    expect(t.pph21).toBeNull();
    expect(t.pph26).toBeNull();
    const total = amountToTransfer(D("1884598"), t, null);
    expect(total.toString()).toBe("2054211.78");
  });

  it("does not round PPN or PPh 4(2), but rounds PPh 23, UMKM and PPh 26", () => {
    expect(computeTaxes({ ...base, taxCategory: "PPN", dpp: D("1001") }).ppn?.toString()).toBe("110.11");
    expect(computeTaxes({ ...base, taxCategory: "PPh 4 ayat 2", dpp: D("1001") }).pph42?.toString()).toBe("100.1");
    expect(computeTaxes({ ...base, taxCategory: "PPh Final UMKM", dpp: D("1001") }).umkm?.toString()).toBe("5"); // 5.005
    expect(computeTaxes({ ...base, taxCategory: "PPh 26", dpp: D("1000.5") }).pph26?.toString()).toBe("200");
    expect(computeTaxes({ ...base, taxCategory: "PPh 23", dpp: D("25") }).pph23?.toString()).toBe("1"); // 0.5 -> 1 (half away from zero)
  });

  it("combined categories trigger each tax", () => {
    const t = computeTaxes({ ...base, taxCategory: "PPN + PPh 26", dpp: D("1000000") });
    expect(t.ppn?.toString()).toBe("110000");
    expect(t.pph26?.toString()).toBe("200000");
    expect(t.pph23).toBeNull();
  });

  it("returns all blank without category or DPP", () => {
    expect(Object.values(computeTaxes({ ...base, taxCategory: null, dpp: D(1) })).every((v) => v === null)).toBe(true);
    expect(Object.values(computeTaxes({ ...base, taxCategory: "PPN", dpp: null })).every((v) => v === null)).toBe(true);
  });

  describe("PPh 21", () => {
    const run = (npwp: "Y" | "N" | null, acc: string, dpp = "10000000") =>
      computeTaxes({ taxCategory: "PPh 21", dpp: D(dpp), npwp, accumulatedTax: D(acc) }).pph21;

    it("is blank when NPWP is not filled", () => expect(run(null, "0")).toBeNull());
    it("uses 5% of 50% DPP in the first layer with NPWP", () => expect(run("Y", "0")?.toString()).toBe("250000"));
    it("uses 6% without NPWP", () => expect(run("N", "0")?.toString()).toBe("300000"));
    it("moves to the next layer exactly at the threshold", () => {
      expect(run("Y", "60000000")?.toString()).toBe("250000"); // below 60,000,001
      expect(run("Y", "60000001")?.toString()).toBe("750000"); // 15%
      expect(run("N", "250000001")?.toString()).toBe("1500000"); // 30%
      expect(run("Y", "500000001")?.toString()).toBe("1500000"); // 30%
      expect(run("Y", "5000000001")?.toString()).toBe("1750000"); // 35%
    });
  });
});

describe("amountToTransfer", () => {
  it("adds Other Addition/Deduction and subtracts withholdings", () => {
    const t = computeTaxes({ ...base, taxCategory: "PPN + PPh 26", dpp: D("1000000") });
    // 1,000,000 + 110,000 - 200,000 + (-5,000)
    expect(amountToTransfer(D("1000000"), t, D("-5000")).toString()).toBe("905000");
  });
});

describe("accumulatedPayment", () => {
  const rows = [
    { vendor: "A", status: "PAID", invoiceAmount: D(100) },
    { vendor: "B", status: "PAID", invoiceAmount: D(999) },
    { vendor: "A", status: null, invoiceAmount: D(50) },
    { vendor: "A", status: "PAID", invoiceAmount: D(200) },
    { vendor: "A", status: "PAID", invoiceAmount: D(300) },
  ];
  it("sums PAID rows of the same vendor up to and including the current row", () => {
    expect(accumulatedPayment(rows, 0).payment.toString()).toBe("100");
    expect(accumulatedPayment(rows, 2).payment.toString()).toBe("100"); // unpaid row sees earlier PAID only
    expect(accumulatedPayment(rows, 3).payment.toString()).toBe("300");
    expect(accumulatedPayment(rows, 4).payment.toString()).toBe("600");
    expect(accumulatedPayment(rows, 4).tax.toString()).toBe("300"); // 50%
  });
});

describe("convert", () => {
  const rate = { usdIdr: D("16000") };
  it("IDR: rate to IDR is 1, USD amount = OG / rate", () => {
    const r = convert("IDR", D("2054211.78"), rate);
    expect(r.rateToIdr?.toString()).toBe("1");
    expect(r.amountIdr?.toString()).toBe("2054211.78");
    expect(r.amountUsd?.toDecimalPlaces(2).toString()).toBe("128.39");
    expect(r.issue).toBeNull();
  });
  it("USD: IDR amount = OG * rate", () => {
    const r = convert("USD", D("11.62"), rate);
    expect(r.amountIdr?.toString()).toBe("185920");
    expect(r.rateToUsd?.toString()).toBe("1");
  });
  it("flags missing rate for the invoice date instead of guessing", () => {
    expect(convert("USD", D(10), null).issue).toBe("missing_rate");
    expect(convert("USD", D(10), null).amountIdr).toBeNull();
  });
  it("does not invent conversions for SGD/INR/AED/EUR", () => {
    for (const c of ["SGD", "INR", "AED", "EUR"]) {
      const r = convert(c, D(10), rate);
      expect(r.issue).toBe("unsupported_currency");
      expect(r.amountIdr).toBeNull();
    }
  });
});

describe("payment numbers", () => {
  it("pads to 5 digits like the sheet", () => {
    expect(paymentNo(735, 2026)).toBe("PMTID202600735");
    expect(paymentNo(1, 2026)).toBe("PMTID202600001");
    expect(paymentNo(99999, 2026)).toBe("PMTID202699999");
    expect(() => paymentNo(100000, 2026)).toThrow();
  });
  it("builds the Xero reference", () => {
    expect(xeroReference("PMTID202600735", "INV/IVO/5920")).toBe("PMTID202600735;INV/IVO/5920");
  });
});
