import { NextResponse } from "next/server";
import { D } from "@/lib/payment-schedule/calc";
import { toCsv } from "@/lib/payment-schedule/csv";
import { computeAll, type DbRow } from "@/lib/payment-schedule/rows";
import { createClient } from "@/lib/supabase/server";

/** CSV of the whole Payment Schedule in the template's columns, computed columns included. */
export async function GET() {
  const db = await createClient();
  const [rows, divisions, rates, accounts] = await Promise.all([
    db.from("payment_schedule").select("*").limit(20000),
    db.from("md_divisions").select("division,department"),
    db.from("fx_rates").select("rate_date,usd_idr"),
    db.from("md_accounts").select("code,name"),
  ]);
  if (rows.error) return new NextResponse("Gagal memuat data", { status: 500 });
  const computed = computeAll((rows.data ?? []) as DbRow[], {
    departments: new Map((divisions.data ?? []).map((d) => [d.division, d.department])),
    rates: new Map((rates.data ?? []).filter((r) => r.usd_idr).map((r) => [r.rate_date, { usdIdr: D(r.usd_idr as string | number) }])),
  });
  const csv = toCsv((rows.data ?? []) as DbRow[], computed, { accountNames: new Map((accounts.data ?? []).map((a) => [a.code, a.name])) });
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="payment-schedule-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
