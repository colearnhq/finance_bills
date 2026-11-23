"use client";
import { useActionState } from "react";
import { saveRate } from "@/lib/master-data/rates";
import type { ActionState } from "@/lib/master-data/actions";

const lbl = "block space-y-1 text-xs font-bold text-subtle";

export function RateForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveRate, {});
  return (
    <form action={action} className="card flex flex-wrap items-end gap-3 p-4">
      <label className={lbl}>Date<input type="date" name="rate_date" required className="input block" /></label>
      <label className={lbl}>Week<input name="week" className="input block w-24" /></label>
      {(["usd_idr", "sgd_usd", "usd_inr", "usd_aed", "usd_eur"] as const).map((k) => (
        <label key={k} className={lbl}>{k.replace("_", " → ").toUpperCase()}<input name={k} inputMode="decimal" className="input block w-28" /></label>
      ))}
      <button disabled={pending} className="btn btn-primary">Simpan</button>
      {state.error && <span className="text-sm text-danger">{state.error}</span>}
      {state.ok && <span className="text-sm text-ok">Tersimpan.</span>}
    </form>
  );
}
