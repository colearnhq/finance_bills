import Link from "next/link";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Extraction } from "@/lib/extraction/schema";
import type { Issue } from "@/lib/extraction/validate";

const STATUS: Record<string, string> = { succeeded: "bg-ok-50 text-ok", failed: "bg-danger-50 text-danger", running: "bg-brand-50 text-subtle" };

export default async function ExtractionsPage() {
  await connection();
  const { data, error } = await (await createClient())
    .from("document_extractions")
    .select("id,status,created_at,error,result,validation,email_attachments(filename)")
    .order("created_at", { ascending: false })
    .limit(200);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl">Hasil ekstraksi</h1>
        <p className="muted text-sm">Hasil pembacaan AI atas PDF yang Anda pilih di Inbox. Semua nilai perlu dicek akuntan.</p>
      </div>
      {error ? (
        <p className="alert-error">Gagal memuat: {error.message}. Pastikan migrasi <code>20261111030000_document_extractions.sql</code> sudah dijalankan.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-soft">
            <thead><tr>{["Waktu", "File", "Vendor", "No. invoice", "Total", "Perlu dicek", "Status"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {(data ?? []).map((r) => {
                const x = r.result as Extraction | null;
                const issues = ((r.validation as { issues?: Issue[] } | null)?.issues ?? []).filter((i) => i.severity !== "info");
                const file = (r.email_attachments as unknown as { filename: string } | null)?.filename;
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                    <td>{r.status === "succeeded" ? <Link className="link" href={`/extractions/${r.id}`}>{file}</Link> : file}</td>
                    <td>{x?.vendor_name.value}</td>
                    <td>{x?.invoice_no.value}</td>
                    <td className="whitespace-nowrap">{x?.total.value ?? x?.subtotal.value} {x?.currency.value}</td>
                    <td>{r.status === "succeeded" ? (issues.length ? <span className="badge bg-warn-50 text-warn">{issues.length} catatan</span> : <span className="muted">-</span>) : null}</td>
                    <td><span className={`badge ${STATUS[r.status]}`} title={r.error ?? ""}>{r.status === "failed" ? `gagal: ${(r.error ?? "").slice(0, 60)}` : r.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data?.length === 0 && <p className="muted p-4 text-sm">Belum ada ekstraksi. Pilih email di Inbox lalu klik Ekstrak.</p>}
        </div>
      )}
    </div>
  );
}
