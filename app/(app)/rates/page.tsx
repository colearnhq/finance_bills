import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { RateForm } from "./rate-form";

export default async function RatesPage() {
  await connection(); // per-request data: opt out of prerendering before anything time-dependent runs
  const { data, error } = await (await createClient()).from("fx_rates").select("*").order("rate_date", { ascending: false }).limit(200);
  const cols = [["usd_idr", "USD → IDR (MID BS)"], ["sgd_usd", "SGD → USD"], ["usd_inr", "USD → INR"], ["usd_aed", "USD → AED"], ["usd_eur", "USD → EUR"]] as const;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl">Rate</h1>
        <p className="muted text-sm">
          Rate dicari berdasarkan Invoice Date secara persis. Jika tanggal invoice tidak ada di sini, konversi tidak dihitung dan diberi peringatan.
          Menyimpan tanggal yang sudah ada akan menimpa barisnya.
        </p>
      </div>
      <RateForm />
      {error ? (
        <p className="alert-error">Gagal memuat data: {error.message}</p>
      ) : (
        <div className="card overflow-x-auto">
        <table className="table-soft">
          <thead>
            <tr>
              <th>Date</th>
              <th>Week</th>
              {cols.map(([, l]) => <th key={l} className="text-right">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.rate_date}>
                <td>{r.rate_date}</td>
                <td>{r.week}</td>
                {cols.map(([k]) => <td key={k} className="text-right tabular-nums">{r[k] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {data?.length === 0 && <p className="muted text-sm">Belum ada rate.</p>}
    </div>
  );
}
