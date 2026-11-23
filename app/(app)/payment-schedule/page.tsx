import { connection } from "next/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { createClient } from "@/lib/supabase/server";
import type { DbRow } from "@/lib/payment-schedule/rows";
import { Grid, type Lists } from "./grid";

async function load() {
  const db = await createClient();
  const [rows, vendors, paymentTypes, cashflow, accounts, divisions, taxCategories, currencies, rates, counters] = await Promise.all([
    fetchAll<DbRow>(db, "payment_schedule", "*", { order: "created_at" }),
    fetchAll<{ name: string }>(db, "md_vendors", "name", { order: "name", activeOnly: true }),
    fetchAll<{ name: string }>(db, "md_payment_types", "name", { order: "name", activeOnly: true }),
    fetchAll<{ name: string }>(db, "md_cashflow_categories", "name", { order: "name", activeOnly: true }),
    fetchAll<{ code: string; name: string }>(db, "md_accounts", "code,name", { order: "code", activeOnly: true }),
    fetchAll<{ division: string; department: string }>(db, "md_divisions", "division,department", { order: "division" }),
    fetchAll<{ name: string }>(db, "md_tax_categories", "name", { order: "name", activeOnly: true }),
    fetchAll<{ code: string }>(db, "md_currencies", "code", { order: "code", activeOnly: true }),
    fetchAll<{ rate_date: string; usd_idr: string | number | null }>(db, "fx_rates", "rate_date,usd_idr", { order: "rate_date" }),
    db.from("payment_counters").select("fiscal_year,last_seq").order("fiscal_year"),
  ]);
  const lists: Lists = {
    vendors: vendors.map((v) => v.name),
    paymentTypes: paymentTypes.map((v) => v.name),
    cashflow: cashflow.map((v) => v.name),
    accounts,
    divisions,
    taxCategories: taxCategories.map((v) => v.name),
    currencies: currencies.map((v) => v.code),
  };
  return {
    rows,
    lists,
    rates: rates.filter((r) => r.usd_idr !== null).map((r) => ({ date: r.rate_date, usdIdr: String(r.usd_idr) })),
    counters: counters.data ?? [],
  };
}

export default async function PaymentSchedulePage({ searchParams }: PageProps<"/payment-schedule">) {
  await connection();
  const sp = await searchParams;
  const highlight = typeof sp.highlight === "string" ? sp.highlight : null;
  let data: Awaited<ReturnType<typeof load>> | null = null;
  let loadError: string | null = null;
  try {
    data = await load();
  } catch (e) {
    loadError = e instanceof Error ? e.message : "kesalahan";
  }
  if (!data) {
    return (
      <p className="alert-error">
        Gagal memuat Payment Schedule: {loadError}. Pastikan migrasi <code>20261111040000_payment_schedule.sql</code> sudah dijalankan.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl">Payment Schedule</h1>
        <p className="muted text-sm">
          Klik Edit Data lalu pilih satu baris untuk mengubahnya (Save atau Discard per baris), atau Add Data untuk baris baru. Kolom abu-abu dihitung otomatis. Tanda * oranye menandai nilai yang berbeda dari bacaan AI.
        </p>
      </div>
      <Grid initialRows={data.rows} lists={data.lists} rates={data.rates} counters={data.counters} defaultYear={new Date().getFullYear()} highlightId={highlight} />
    </div>
  );
}
