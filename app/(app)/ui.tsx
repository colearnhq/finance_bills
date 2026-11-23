/** Shared look of buttons and the confirm dialog (colearn-finance style). */
export const BTN = "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-bold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:!bg-[#a4b3cd] disabled:!text-white";
export const BTN_VARIANT = {
  light: "bg-[#dbeeff] text-[#1e5af6]",
  primary: "bg-[#1e5af6] text-white",
  danger: "bg-[#ffe7ec] text-[#e02954]",
} as const;
export const btn = (v: keyof typeof BTN_VARIANT, extra = "") => `${BTN} ${BTN_VARIANT[v]} ${extra}`;

export type Dialog = { title: string; text: string; primary: string; secondary: string; danger?: boolean; onPrimary: () => void; onSecondary: () => void };

export function ConfirmDialog({ d, busy }: { d: Dialog; busy: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-bold text-[#181b25]">{d.title}</h2>
        <p className="text-sm text-[#5e6c84]">{d.text}</p>
        <div className="flex justify-end gap-2 pt-2">
          <button className={btn(d.danger ? "light" : "danger")} onClick={d.onSecondary} disabled={busy}>{d.secondary}</button>
          <button className={btn(d.danger ? "danger" : "primary")} onClick={d.onPrimary} disabled={busy}>{d.primary}</button>
        </div>
      </div>
    </div>
  );
}
