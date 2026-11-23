"use client";
import { useActionState } from "react";
import { addRule, hideMatching, type FilterState } from "@/lib/gmail/filters";

export function RuleForms() {
  const [add, addAction, adding] = useActionState<FilterState, FormData>(addRule, {});
  const [hide, hideAction, hiding] = useActionState<FilterState, FormData>(() => hideMatching(), {});
  return (
    <div className="space-y-3">
      <form action={addAction} className="card flex max-w-4xl flex-wrap items-end gap-3 p-4">
        <label className="block space-y-1 text-xs font-bold text-subtle">Jenis
          <select name="kind" className="input block"><option value="subject">Judul mengandung</option><option value="sender">Pengirim</option></select>
        </label>
        <label className="block flex-1 space-y-1 text-xs font-bold text-subtle">Pola
          <input name="pattern" required placeholder="mis. Summary of failures" className="input block w-full" />
        </label>
        <label className="block flex-1 space-y-1 text-xs font-bold text-subtle">Catatan (opsional)
          <input name="note" className="input block w-full" />
        </label>
        <button disabled={adding} className="btn btn-primary">Tambah</button>
        {add.error && <span className="w-full text-sm text-danger">{add.error}</span>}
      </form>
      <form action={hideAction} className="flex max-w-4xl items-center gap-3 text-sm">
        <button disabled={hiding} className="btn">{hiding ? "Memproses…" : "Sembunyikan email lama yang cocok"}</button>
        <span className="muted text-xs">Menandai email yang sudah ada di Inbox sebagai &quot;bukan invoice&quot; (bisa dikembalikan).</span>
        {hide.message && <span className="text-ok">{hide.message}</span>}
        {hide.error && <span className="text-danger">{hide.error}</span>}
      </form>
    </div>
  );
}
