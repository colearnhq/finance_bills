import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { D } from "@/lib/payment-schedule/calc";
import { computeAll, type Computed, type DbRow } from "@/lib/payment-schedule/rows";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { BillHeader, BillLine, WithholdingKind } from "./bill";
import { normalizeBillNumbers } from "./normalize";

export interface ScheduleContext {
  rows: DbRow[];
  computed: Map<string, Computed>;
  taxAccounts: Partial<Record<WithholdingKind, string>>;
}

/** Everything needed to build bills: all rows (Accumulated Payment depends on the rows above), lookups and the tax account config. */
export async function loadScheduleContext(db: SupabaseClient): Promise<ScheduleContext> {
  const [rows, divisions, rates, accounts] = await Promise.all([
    fetchAll<DbRow>(db, "payment_schedule", "*", { order: "created_at" }),
    fetchAll<{ division: string; department: string }>(db, "md_divisions", "division,department", { order: "division" }),
    fetchAll<{ rate_date: string; usd_idr: string | number | null }>(db, "fx_rates", "rate_date,usd_idr", { order: "rate_date" }),
    db.from("xero_tax_accounts").select("tax,account_code"),
  ]);
  if (accounts.error) throw new Error(`xero_tax_accounts: ${accounts.error.message}`);
  const computed = computeAll(rows, {
    departments: new Map(divisions.map((d) => [d.division, d.department])),
    rates: new Map(rates.filter((r) => r.usd_idr !== null).map((r) => [r.rate_date, { usdIdr: D(r.usd_idr as string | number) }])),
  });
  const taxAccounts: ScheduleContext["taxAccounts"] = {};
  for (const a of accounts.data ?? []) taxAccounts[a.tax as WithholdingKind] = a.account_code;
  return { rows, computed, taxAccounts };
}

export type StoredBill = BillHeader & {
  id: string; status: "prepared" | "exported"; prepared_at: string; exported_at: string | null; export_count: number;
  xero_bill_lines: (BillLine & { id: string })[];
};

export async function loadBills(db: SupabaseClient, ids?: string[]): Promise<StoredBill[]> {
  let q = db.from("xero_bills").select("*, xero_bill_lines(*)").order("reference_no");
  if (ids) q = q.in("id", ids);
  const { data, error } = await q.limit(5000);
  if (error) throw new Error(`xero_bills: ${error.message}`);
  return ((data ?? []) as StoredBill[]).map((b) => normalizeBillNumbers({ ...b, xero_bill_lines: [...b.xero_bill_lines].sort((x, y) => x.line_no - y.line_no) }));
}
