"use client";
import { useEffect, useState, useTransition } from "react";
import { markNotInvoice, previewRule, type RulePreview } from "@/lib/gmail/filters";
import { suggestRule } from "@/lib/gmail/filters-core";

type Email = { id: string; subject: string; from: string };

export function NotInvoiceButton({ email }: { email: Email }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>Bukan invoice</button>
      {open && <Dialog email={email} close={() => setOpen(false)} />}
    </>
  );
}

function Dialog({ email, close }: { email: Email; close: () => void }) {
  const suggestion = suggestRule(email);
  const [mode, setMode] = useState<"only" | "rule">("rule");
  const [kind, setKind] = useState<string>(suggestion.kind);
  const [pattern, setPattern] = useState(suggestion.pattern);
  const [note, setNote] = useState("");
  const [hideOthers, setHideOthers] = useState<boolean | null>(null); // null = follow the safe default
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (mode !== "rule") return;
    let stale = false;
    const t = setTimeout(async () => {
      const r = await previewRule(email.id, kind, pattern);
      if (!stale) setPreview(r);
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [mode, kind, pattern, email.id]);

  // Safe default: hide other matches only when none of them has a stored PDF.
  const hide = hideOthers ?? (preview ? preview.withPdf === 0 : false);

  const submit = () =>
    start(async () => {
      const res = await markNotInvoice(email.id, mode === "rule" ? { kind, pattern, note } : null, mode === "rule" && hide);
      if (res.error) setError(res.error);
      else close();
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={close}>
      <div className="card w-full max-w-lg space-y-4 p-6 text-left" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div>
          <h2 className="font-display text-base font-bold text-ink">Tandai bukan invoice</h2>
          <p className="muted mt-1 line-clamp-2 text-sm">{email.subject}</p>
        </div>

        <label className="flex items-start gap-2"><input type="radio" checked={mode === "rule"} onChange={() => setMode("rule")} className="mt-1" />
          <span><b className="font-bold text-ink">Buat aturan dari email ini</b><br /><span className="muted text-xs">Email serupa tidak akan diunduh lagi saat sinkronisasi.</span></span></label>

        {mode === "rule" && (
          <div className="space-y-3 rounded-lg bg-brand-50 p-3">
            <div className="flex gap-2">
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="input">
                <option value="subject">Judul mengandung</option>
                <option value="sender">Pengirim</option>
              </select>
              <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="input w-full" aria-label="Pola" />
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (opsional)" className="input w-full" />
            {preview?.error && <p className="text-sm text-danger">{preview.error}</p>}
            {preview && !preview.error && (
              <div className="space-y-1 text-sm">
                <p>Cocok dengan <b>{preview.total}</b> email lain di Inbox{preview.total > 0 && <>, <b className={preview.withPdf ? "text-warn" : ""}>{preview.withPdf}</b> di antaranya punya PDF</>}.</p>
                {preview.withPdf > 0 && <p className="alert-warn">Aturan ini mencakup email yang sudah berisi PDF. Pastikan bukan invoice yang sebenarnya, misalnya pengirim yang juga mengirim invoice asli.</p>}
                {kind === "sender" && <p className="muted text-xs">Aturan pengirim mengecualikan <i>semua</i> email dari alamat ini.</p>}
                {preview.samples.map((s) => <p key={s} className="muted truncate text-xs">• {s}</p>)}
                {preview.total > 0 && (
                  <label className="flex items-center gap-2 pt-1"><input type="checkbox" checked={hide} onChange={(e) => setHideOthers(e.target.checked)} /> Sembunyikan juga {preview.total} email lain yang cocok</label>
                )}
              </div>
            )}
          </div>
        )}

        <label className="flex items-start gap-2"><input type="radio" checked={mode === "only"} onChange={() => setMode("only")} className="mt-1" />
          <span><b className="font-bold text-ink">Hanya email ini</b></span></label>

        {error && <p className="alert-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={close} disabled={pending}>Batal</button>
          <button className="btn btn-primary" onClick={submit} disabled={pending || (mode === "rule" && !!preview?.error)}>{pending ? "Menyimpan…" : "Simpan"}</button>
        </div>
      </div>
    </div>
  );
}
