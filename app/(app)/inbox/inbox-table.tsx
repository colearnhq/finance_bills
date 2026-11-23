"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { extractAction } from "@/lib/extraction/actions";
import type { RunResult } from "@/lib/extraction/run";
import { setReviewStatus } from "@/lib/gmail/actions";
import { NotInvoiceButton } from "./not-invoice-button";

export type AttRow = {
  id: string; filename: string; status: string; error: string | null; duplicate: boolean;
  extraction: { id: string; status: string; error: string | null } | null;
};
export type EmailRow = {
  id: string; from: string; subject: string; receivedAt: string | null; classification: string; reviewStatus: string;
  links: { host: string; path: string }[]; gmailId: string; attachments: AttRow[];
};

const TYPES: Record<string, { label: string; cls: string }> = {
  pdf: { label: "PDF", cls: "bg-ok-50 text-ok" },
  link: { label: "Link invoice", cls: "bg-warn-50 text-warn" },
  link_unsure: { label: "Link (tidak yakin)", cls: "bg-orange-50 text-orange-600" },
  none: { label: "Tanpa dokumen", cls: "bg-brand-50 text-subtle" },
};
const MAX_PER_RUN = 10;

export function InboxTable({ rows }: { rows: EmailRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [redo, setRedo] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [pending, start] = useTransition();

  const selectable = (r: EmailRow) => r.reviewStatus === "new" && r.attachments.some((a) => a.status === "stored");
  const selectableIds = rows.filter(selectable).map((r) => r.id);
  const chosenRows = rows.filter((r) => selected.has(r.id));
  const attachmentIds = chosenRows.flatMap((r) => r.attachments.filter((a) => a.status === "stored" && (redo || a.extraction?.status !== "succeeded")).map((a) => a.id));

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const run = () => start(async () => { setResult(null); const r = await extractAction(attachmentIds, redo); setResult(r); if (r.ok) setSelected(new Set()); });

  return (
    <div className="space-y-3">
      <div className="card sticky top-2 z-10 flex flex-wrap items-center gap-3 p-3 text-sm">
        <span className="muted">{selected.size} email dipilih, {attachmentIds.length} PDF akan diekstrak</span>
        <label className="flex items-center gap-1.5 text-subtle"><input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} /> ekstrak ulang yang sudah diekstrak</label>
        <button className="btn btn-primary" disabled={pending || attachmentIds.length === 0 || attachmentIds.length > MAX_PER_RUN} onClick={run}>
          {pending ? "Mengekstrak… (bisa beberapa menit)" : `Ekstrak ${attachmentIds.length || ""} PDF`}
        </button>
        {attachmentIds.length > MAX_PER_RUN && <span className="text-warn">Maksimal {MAX_PER_RUN} PDF per proses. Kurangi pilihan.</span>}
        {result && !result.ok && <span className="w-full text-danger">{result.error}</span>}
        {result?.ok && (
          <span className={`w-full ${result.failed ? "text-warn" : "text-ok"}`}>
            {result.succeeded} berhasil{result.failed > 0 && `, ${result.failed} gagal`}{result.skipped > 0 && `, ${result.skipped} dilewati`}.
            {result.notes.map((n) => <span key={n} className="block text-xs text-subtle">• {n}</span>)}
          </span>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="table-soft">
          <thead>
            <tr>
              <th className="w-8"><input type="checkbox" aria-label="Pilih semua" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectableIds))} /></th>
              {["Tanggal", "Dari", "Subjek", "Tipe", "Lampiran / link", ""].map((h) => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = TYPES[r.classification];
              return (
                <tr key={r.id} className={r.reviewStatus === "not_invoice" ? "opacity-50" : ""}>
                  <td>{selectable(r) && <input type="checkbox" aria-label="Pilih email" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}</td>
                  <td className="whitespace-nowrap">{r.receivedAt?.slice(0, 16).replace("T", " ")}</td>
                  <td>{r.from}</td>
                  <td>{r.subject}</td>
                  <td><span className={`badge ${t.cls}`}>{t.label}</span></td>
                  <td className="space-y-0.5">
                    {r.attachments.map((a) => (
                      <div key={a.id}>
                        {a.status === "stored" ? <a className="link" target="_blank" href={`/api/attachments/${a.id}`}>{a.filename}</a> : <span>{a.filename}</span>}
                        {a.status !== "stored" && <span className="ml-1 text-xs text-danger">{a.status === "rejected" ? "ditolak" : "gagal"}: {a.error}</span>}
                        {a.duplicate && <span className="badge ml-1 bg-warn-50 text-warn">PDF sama di email lain</span>}
                        {a.extraction?.status === "succeeded" && <Link href={`/extractions/${a.extraction.id}`} className="badge ml-1 bg-brand-100 text-brand-500">Lihat hasil</Link>}
                        {a.extraction?.status === "failed" && <span className="badge ml-1 bg-danger-50 text-danger" title={a.extraction.error ?? ""}>ekstraksi gagal</span>}
                        {a.extraction?.status === "running" && <span className="badge ml-1 bg-brand-50 text-subtle">mengekstrak…</span>}
                      </div>
                    ))}
                    {r.attachments.length === 0 && r.links.map((l) => <div key={l.host + l.path} className="muted text-xs">{l.host}{l.path.slice(0, 40)}</div>)}
                  </td>
                  <td className="space-x-4 whitespace-nowrap text-right">
                    <a className="link" target="_blank" rel="noreferrer" href={`https://mail.google.com/mail/u/0/#all/${r.gmailId}`}>Gmail</a>
                    {r.reviewStatus === "new" ? (
                      <NotInvoiceButton email={{ id: r.id, subject: r.subject, from: r.from }} />
                    ) : (
                      <button className="link" onClick={() => setReviewStatus(r.id, "new")}>Kembalikan</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
