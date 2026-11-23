"use client";
import { useActionState } from "react";
import { syncAction, type SyncState } from "@/lib/gmail/actions";

export function SyncPanel({ defaultQuery }: { defaultQuery: string }) {
  const [res, action, pending] = useActionState<SyncState, FormData>(syncAction, null);
  return (
    <form action={action} className="card space-y-2 p-4 text-sm">
      <div className="flex gap-2">
        <input name="q" defaultValue={defaultQuery} className="input w-full max-w-3xl" aria-label="Pencarian Gmail" />
        <button disabled={pending} className="btn btn-primary shrink-0">{pending ? "Menyinkronkan…" : "Sinkronkan"}</button>
      </div>
      <p className="muted text-xs">Sintaks sama dengan kotak cari Gmail. Aturan di <b>Filter email</b> otomatis ditambahkan ke pencarian ini. Maks. 50 email terbaru per sinkronisasi, 25 email baru sekali proses.</p>
      {res && !res.ok && <p className="alert-error">{res.error}</p>}
      {res?.ok && (
        <p className="alert-ok">
          {res.found} email cocok, {res.newEmails} baru, {res.pdfStored} PDF tersimpan
          {res.pdfFailed > 0 && <span className="text-danger">, {res.pdfFailed} PDF gagal (akan dicoba lagi)</span>}
          {res.remaining > 0 && <span className="text-warn">. Masih ada {res.remaining} email baru, klik Sinkronkan lagi.</span>}
        </p>
      )}
    </form>
  );
}
