import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { DateField, Extraction, Field } from "@/lib/extraction/schema";
import type { Issue, Suggestion } from "@/lib/extraction/validate";
import { matchVendor } from "@/lib/extraction/vendor-match";
import { CreateRowButton } from "./create-row-button";

const SEV: Record<string, string> = { error: "alert-error", warn: "alert-warn", info: "rounded-lg border border-line bg-brand-50 px-4 py-2 text-sm text-subtle" };

const FIELDS: [keyof Extraction, string][] = [
  ["vendor_name", "Vendor"], ["vendor_email", "Email vendor"], ["vendor_tax_id", "NPWP / Tax ID vendor"], ["billed_to", "Ditagihkan ke"],
  ["invoice_no", "Invoice No"], ["po_no", "Purchase Order No."], ["invoice_date", "Invoice Date"], ["due_date", "Due Date"],
  ["period_from", "Expense period from"], ["period_to", "Expense period to"], ["description", "Description"], ["currency", "Currency"],
  ["subtotal", "Subtotal"], ["discount", "Diskon"], ["tax_amount", "Pajak (tertera)"], ["total", "Total"], ["amount_paid", "Sudah dibayar"], ["amount_due", "Sisa tagihan"],
  ["bank_name", "Bank"], ["beneficiary_name", "Penerima"], ["account_number", "No. rekening"], ["swift_code", "Swift"], ["ifsc_code", "IFSC"],
];

const isDate = (f: Field | DateField): f is DateField => "iso" in f;

export default async function ExtractionPage({ params }: PageProps<"/extractions/[id]">) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = await createClient();
  const { data: row } = await db
    .from("document_extractions")
    .select("id,status,created_at,model,prompt_version,email_subject,email_from,email_body_status,result,validation,usage,attachment_id,email_attachments(id,filename)")
    .eq("id", id)
    .maybeSingle();
  if (!row || row.status !== "succeeded" || !row.result) notFound();
  const x = row.result as Extraction;
  const v = (row.validation ?? { issues: [], suggestion: null }) as { issues: Issue[]; suggestion: Suggestion | null };
  const att = row.email_attachments as unknown as { id: string; filename: string };

  const vendors = await fetchAll<{ name: string }>(db, "md_vendors", "name", { order: "name", activeOnly: true });
  const match = matchVendor(x.vendor_name.value, vendors.map((r) => r.name));

  // Other extractions with the same invoice number: possible duplicates.
  let dups: { id: string; vendor: string | null; file: string }[] = [];
  if (x.invoice_no.value) {
    const { data } = await db.from("document_extractions").select("id,result,email_attachments(filename)").eq("status", "succeeded").eq("result->invoice_no->>value", x.invoice_no.value).neq("id", id).limit(5);
    dups = (data ?? []).map((d) => ({ id: d.id, vendor: (d.result as Extraction).vendor_name.value, file: (d.email_attachments as unknown as { filename: string }).filename }));
  }

  const { data: existingRow } = await db.from("payment_schedule").select("id").eq("extraction_id", id).maybeSingle();

  const dv = (k: keyof Extraction) => { const f = x[k] as Field | DateField; return isDate(f) ? (f.iso ?? f.raw) : f.value; };
  const template: [string, string | null | undefined, string?][] = [
    ["Vendor Name", match.exact ?? (match.suggestions[0] ? `${match.suggestions[0].name} (saran)` : x.vendor_name.value), match.exact ? "cocok dengan daftar vendor" : match.suggestions.length ? "belum pasti: pilih manual" : "tidak ada di daftar vendor"],
    ["Invoice No", dv("invoice_no")], ["Invoice Date", dv("invoice_date")], ["Due Date", dv("due_date")],
    ["Description", dv("description")], ["Expense period from", dv("period_from")], ["Expense period to", dv("period_to")],
    ["Currency", dv("currency")], ["Invoice Amount", v.suggestion?.invoiceAmount, v.suggestion?.rule], ["DPP", v.suggestion?.dpp, v.suggestion?.rule],
    ["Purchase Order No.", dv("po_no")], ["NPWP/KTP", dv("vendor_tax_id")], ["Bank Name", dv("bank_name")], ["Beneficiary Name", dv("beneficiary_name")],
    ["Bank Account Number", dv("account_number")], ["Swift Code", dv("swift_code")], ["IFSC Code", dv("ifsc_code")], ["Vendor Email", dv("vendor_email")],
  ];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/extractions" className="link text-sm">← Hasil ekstraksi</Link>
        <h1 className="text-2xl">{att.filename}</h1>
        <p className="muted text-sm">
          Dibaca oleh {row.model} · prompt {row.prompt_version} · isi email {row.email_body_status === "included" ? "ikut dibaca" : row.email_body_status === "empty" ? "kosong" : "tidak tersedia"}.
          Ini hasil AI, bukan data final: periksa terhadap PDF.
        </p>
        <div className="mt-3"><CreateRowButton extractionId={row.id} existingRowId={existingRow?.id ?? null} /></div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card sticky top-4 h-[85vh] overflow-hidden">
          <iframe src={`/api/attachments/${att.id}`} title="PDF" className="h-full w-full" />
          <a href={`/api/attachments/${att.id}`} target="_blank" className="link absolute bottom-2 right-3 rounded bg-white/90 px-2 text-xs">Buka di tab baru</a>
        </div>

        <div className="space-y-4">
          {dups.length > 0 && (
            <p className="alert-warn">Nomor invoice ini juga muncul di ekstraksi lain: {dups.map((d) => <Link key={d.id} href={`/extractions/${d.id}`} className="link mr-2">{d.vendor ?? "?"} ({d.file})</Link>)}</p>
          )}
          {v.issues.length > 0 && (
            <div className="space-y-1.5">
              {v.issues.map((i, k) => <p key={k} className={SEV[i.severity]}><b className="font-bold">{i.field}</b>: {i.message}</p>)}
            </div>
          )}

          <section className="card overflow-hidden">
            <h2 className="border-b border-line px-4 py-2.5 font-display text-sm font-bold text-ink">Usulan baris Payment Schedule</h2>
            <table className="table-soft"><tbody>
              {template.map(([label, value, note]) => (
                <tr key={label}><td className="w-48 text-subtle">{label}</td><td className={value ? "" : "muted"}>{value ?? "—"}{note && <span className="muted ml-2 text-xs">{note}</span>}</td></tr>
              ))}
            </tbody></table>
            {match.suggestions.length > 0 && !match.exact && (
              <p className="muted border-t border-line px-4 py-2.5 text-xs">Kemiripan vendor: {match.suggestions.map((s) => `${s.name} (${Math.round(s.score * 100)}%)`).join(" · ")}</p>
            )}
            <p className="muted border-t border-line px-4 py-2.5 text-xs">Invoice Amount dan DPP diusulkan oleh aturan tetap (bukan AI). Kolom lain (pajak, akun, divisi, dst.) diisi akuntan pada tahap Payment Schedule.</p>
          </section>

          <section className="card overflow-hidden">
            <h2 className="border-b border-line px-4 py-2.5 font-display text-sm font-bold text-ink">Hasil bacaan AI dan bukti</h2>
            <table className="table-soft">
              <thead><tr><th>Field</th><th>Nilai</th><th>Bukti di dokumen</th></tr></thead>
              <tbody>
                <tr><td className="text-subtle">Jenis dokumen</td><td>{x.document_type}</td><td className="muted text-xs">{x.document_type_evidence}</td></tr>
                {FIELDS.map(([k, label]) => {
                  const f = x[k] as Field | DateField;
                  const val = isDate(f) ? (f.iso ? `${f.iso}${f.raw && f.raw !== f.iso ? ` (tertulis "${f.raw}")` : ""}` : f.raw) : f.value;
                  if (!val) return null;
                  return (
                    <tr key={k}>
                      <td className="whitespace-nowrap text-subtle">{label}</td>
                      <td>{val}{isDate(f) && f.ambiguous && <span className="badge ml-2 bg-warn-50 text-warn">tanggal ambigu</span>}{f.source === "email_body" && <span className="badge ml-2 bg-brand-100 text-brand-500">dari email</span>}</td>
                      <td className="muted text-xs">{f.evidence}{f.page ? ` (hal. ${f.page})` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {x.line_items.length > 0 && (
              <table className="table-soft border-t border-line">
                <thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Harga</th><th className="text-right">Jumlah</th></tr></thead>
                <tbody>{x.line_items.map((l, i) => <tr key={i}><td>{l.description}</td><td className="text-right">{l.quantity}</td><td className="text-right">{l.unit_price}</td><td className="text-right">{l.amount}</td></tr>)}</tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
