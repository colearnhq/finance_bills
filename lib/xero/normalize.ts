import { D } from "@/lib/payment-schedule/calc";

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : D(v as string | number).toFixed());

/**
 * PostgREST returns `numeric` columns as JSON numbers although our types say string. Turn them into exact decimal
 * strings once, where the data is read, so everything downstream really receives what the types promise.
 */
type NumericLine = { quantity: unknown; unit_amount: unknown; tax_amount: unknown };

export function normalizeBillNumbers<B extends { total: unknown; xero_bill_lines: NumericLine[] }>(b: B): B {
  return {
    ...b,
    total: str(b.total) ?? "0",
    xero_bill_lines: b.xero_bill_lines.map((l) => ({ ...l, quantity: str(l.quantity) ?? "1", unit_amount: str(l.unit_amount) ?? "0", tax_amount: str(l.tax_amount) })),
  };
}
