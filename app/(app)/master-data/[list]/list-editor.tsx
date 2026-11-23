"use client";
import { useActionState, useState } from "react";
import { addItem, setActive, updateItem, type ActionState } from "@/lib/master-data/actions";
import type { FieldDef } from "@/lib/master-data/lists";

type Row = { id: string; active: boolean } & Record<string, string>;
const input = "input w-full";

export function ListEditor({ slug, fields, rows, truncated }: { slug: string; fields: FieldDef[]; rows: Row[]; truncated: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="card max-w-3xl p-4"><AddForm slug={slug} fields={fields} /></div>
      <div className="card max-w-3xl overflow-hidden">
      <table className="table-soft">
        <thead>
          <tr>
            {fields.map((f) => <th key={f.key}>{f.label}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            editing === r.id ? (
              <EditRow key={r.id} slug={slug} fields={fields} row={r} done={() => setEditing(null)} />
            ) : (
              <tr key={r.id} className={r.active ? "" : "opacity-50"}>
                {fields.map((f) => <td key={f.key} className={r.active ? "" : "line-through"}>{r[f.key]}</td>)}
                <td className="space-x-4 whitespace-nowrap text-right">
                  <button className="link" onClick={() => setEditing(r.id)}>Ubah</button>
                  <button className="link" onClick={() => setActive(slug, r.id, !r.active)}>{r.active ? "Nonaktifkan" : "Aktifkan"}</button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      </div>
      {rows.length === 0 && <p className="muted text-sm">Tidak ada data.</p>}
      {truncated && <p className="alert-warn max-w-3xl">Hanya 500 baris pertama yang ditampilkan. Gunakan pencarian.</p>}
    </div>
  );
}

function AddForm({ slug, fields }: { slug: string; fields: FieldDef[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addItem.bind(null, slug), {});
  return (
    <form action={action} className="flex items-start gap-2">
      {fields.map((f) => <input key={f.key} name={f.key} placeholder={f.placeholder ?? f.label} className={input} />)}
      <button disabled={pending} className="btn btn-primary shrink-0">Tambah</button>
      {state.error && <span className="self-center text-sm text-danger">{state.error}</span>}
    </form>
  );
}

function EditRow({ slug, fields, row, done }: { slug: string; fields: FieldDef[]; row: Row; done: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(async (p, f) => {
    const res = await updateItem(slug, row.id, p, f);
    if (res.ok) done();
    return res;
  }, {});
  return (
    <tr>
      <td colSpan={fields.length + 1}>
        <form action={action} className="flex items-start gap-2">
          {fields.map((f) => <input key={f.key} name={f.key} defaultValue={row[f.key]} className={input} />)}
          <button disabled={pending} className="btn btn-primary shrink-0">Simpan</button>
          <button type="button" onClick={done} className="btn shrink-0">Batal</button>
          {state.error && <span className="self-center text-sm text-danger">{state.error}</span>}
        </form>
      </td>
    </tr>
  );
}
