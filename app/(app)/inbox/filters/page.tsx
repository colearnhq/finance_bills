import Link from "next/link";
import { connection } from "next/server";
import { deleteRule, toggleRule } from "@/lib/gmail/filters";
import { createClient } from "@/lib/supabase/server";
import { RuleForms } from "./rule-forms";

export default async function FiltersPage() {
  await connection();
  const { data, error } = await (await createClient())
    .from("email_exclusion_rules")
    .select("id,kind,pattern,note,active")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-4">
      <div>
        <Link href="/inbox" className="link text-sm">← Inbox</Link>
        <h1 className="text-2xl">Filter email</h1>
        <p className="muted max-w-3xl text-sm">
          Email yang cocok dengan aturan aktif <b>dikecualikan dari pencarian Gmail</b> saat sinkronisasi, jadi tidak diunduh dan tidak membebani proses.
          Gmail mencocokkan <b>kata atau frasa utuh</b>, bukan potongan kata (&quot;Summary of failures&quot; cocok, &quot;fail&quot; tidak).
        </p>
      </div>
      <RuleForms />
      {error ? (
        <p className="alert-error">
          Gagal memuat aturan: {error.message}. Pastikan migrasi <code>20261111020000_email_exclusion_rules.sql</code> sudah dijalankan.
        </p>
      ) : (
        <div className="card max-w-4xl overflow-hidden">
          <table className="table-soft">
            <thead>
              <tr><th>Jenis</th><th>Pola</th><th>Catatan</th><th /></tr>
            </thead>
            <tbody>
              {(data ?? []).map((r) => (
                <tr key={r.id} className={r.active ? "" : "opacity-50"}>
                  <td className="whitespace-nowrap">{r.kind === "subject" ? "Judul mengandung" : "Pengirim"}</td>
                  <td className="font-bold text-ink">{r.pattern}</td>
                  <td className="muted">{r.note}</td>
                  <td className="space-x-4 whitespace-nowrap text-right">
                    <form action={toggleRule.bind(null, r.id, !r.active)} className="inline"><button className="link">{r.active ? "Nonaktifkan" : "Aktifkan"}</button></form>
                    <form action={deleteRule.bind(null, r.id)} className="inline"><button className="link">Hapus</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.length === 0 && <p className="muted p-4 text-sm">Belum ada aturan.</p>}
        </div>
      )}
    </div>
  );
}
