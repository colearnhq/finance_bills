"use client";
import { useMemo, useState, useTransition, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { createRow, deleteDraftRow, setCounter, updateRow } from "@/lib/payment-schedule/actions";
import { D, TAX_TRIGGERS, type Num } from "@/lib/payment-schedule/calc";
import { COLUMNS, INPUT_COLS, type Col, type InputCol } from "@/lib/payment-schedule/columns";
import { computeAll, type Computed, type DbRow } from "@/lib/payment-schedule/rows";
import { Combobox } from "./combobox";
import { btn, ConfirmDialog, type Dialog } from "../ui";

export interface Lists {
  vendors: string[]; paymentTypes: string[]; cashflow: string[]; accounts: { code: string; name: string }[];
  divisions: { division: string; department: string }[]; taxCategories: string[]; currencies: string[];
}

/** Same interaction model as colearn-finance's Finance Database: NONE (read), EDITING (one row at a time, Save/Discard), ADDING (pinned input row). */
type Mode = "none" | "edit" | "add";
type Draft = Record<string, string>;

const ACCOUNT_SEP = " — ";
const HEADER_H = 48; // px, keeps the pinned "add" row exactly under the header
const W_ACTIONS = 190;
const W_SOURCE = 112;

// colearn-finance palette (primary #1e5af6, light #dbeeff, danger #e02954 on #ffe7ec)
const colWidth = (col: Col): number => {
  if (col.kind === "computed") return col.key === "no" ? 72 : col.key === "payment_no" ? 160 : col.key === "department" ? 150 : 160;
  if (col.wide) return 260;
  return { date: 150, money: 160, yn: 100, text: 180, list: 200 }[col.type];
};

const fmt = (n: Num | null): string => {
  if (!n) return "";
  const [i, d] = n.toFixed(2).split(".");
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${d}`;
};
const fmtRate = (n: Num | null) => (n ? n.toString() : "");

export function Grid({ initialRows, lists, rates, counters, defaultYear, highlightId }: {
  initialRows: DbRow[]; lists: Lists; rates: { date: string; usdIdr: string }[];
  counters: { fiscal_year: number; last_seq: number }[]; defaultYear: number; highlightId: string | null;
}) {
  const [rows, setRows] = useState<DbRow[]>(initialRows);
  const [mode, setMode] = useState<Mode>("none");
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyWarn, setOnlyWarn] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pending, start] = useTransition();
  const [counterList, setCounterList] = useState(counters);

  const accountName = useMemo(() => new Map(lists.accounts.map((a) => [a.code, a.name])), [lists.accounts]);
  const sets = useMemo(() => ({
    vendors: new Set(lists.vendors), paymentTypes: new Set(lists.paymentTypes), cashflow: new Set(lists.cashflow),
    accounts: new Set(lists.accounts.map((a) => `${a.code}${ACCOUNT_SEP}${a.name}`)), divisions: new Set(lists.divisions.map((d) => d.division)),
    taxCategories: new Set(lists.taxCategories), currencies: new Set(lists.currencies),
  }), [lists]);
  const options = useMemo(() => ({
    vendors: lists.vendors, paymentTypes: lists.paymentTypes, cashflow: lists.cashflow,
    accounts: lists.accounts.map((a) => `${a.code}${ACCOUNT_SEP}${a.name}`), divisions: lists.divisions.map((d) => d.division),
    taxCategories: lists.taxCategories, currencies: lists.currencies, status: ["PAID"],
  }), [lists]);
  const computed = useMemo(
    () => computeAll(rows, {
      departments: new Map(lists.divisions.map((d) => [d.division, d.department])),
      rates: new Map(rates.map((r) => [r.date, { usdIdr: D(r.usdIdr) }])),
    }),
    [rows, lists.divisions, rates],
  );

  // Same vendor + invoice number on more than one row: possible duplicate.
  const dupeKey = (vendor: unknown, invoice: unknown) => `${vendor}|${String(invoice).toLowerCase()}`;
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    rows.forEach((r) => { if (r.vendor_name && r.invoice_no) { const k = dupeKey(r.vendor_name, r.invoice_no); seen.set(k, (seen.get(k) ?? 0) + 1); } });
    return new Set(rows.filter((r) => r.vendor_name && r.invoice_no && (seen.get(dupeKey(r.vendor_name, r.invoice_no)) ?? 0) > 1).map((r) => r.id));
  }, [rows]);

  useEffect(() => {
    if (highlightId) document.getElementById(`row-${highlightId}`)?.scrollIntoView({ block: "center" });
  }, [highlightId]);

  const display = (r: DbRow, col: InputCol): string => {
    const v = r[col.key];
    if (v === null || v === undefined || v === "") return "";
    if (col.type === "money") return D(v as string | number).toString();
    if (col.key === "accounting_account") return `${v}${ACCOUNT_SEP}${accountName.get(String(v)) ?? ""}`;
    return String(v);
  };
  const toDraft = (r: DbRow): Draft => Object.fromEntries(INPUT_COLS.map((c) => [c.key, display(r, c)]));
  const original = (id: string | null) => rows.find((r) => r.id === id) ?? null;

  /** Fields whose typed value differs from what is stored. */
  const changedKeys = (r: DbRow): string[] => INPUT_COLS.filter((c) => (draft[c.key] ?? "").trim() !== display(r, c)).map((c) => c.key);
  const filledKeys = (): string[] => INPUT_COLS.filter((c) => (draft[c.key] ?? "").trim() !== "").map((c) => c.key);

  const listErrors = (keys: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const c of INPUT_COLS) {
      const t = (draft[c.key] ?? "").trim();
      if (keys.includes(c.key) && c.type === "list" && t && c.list && !sets[c.list].has(t)) out[c.key] = "Pilih nilai dari daftar.";
    }
    return out;
  };
  const toPayload = (keys: string[]): Draft =>
    Object.fromEntries(keys.map((k) => {
      const t = (draft[k] ?? "").trim();
      return [k, k === "accounting_account" ? t.split(ACCOUNT_SEP)[0] : t];
    }));
  const isDuplicate = (excludeId: string | null): boolean => {
    const v = (draft.vendor_name ?? "").trim(), n = (draft.invoice_no ?? "").trim();
    return !!v && !!n && rows.some((x) => x.id !== excludeId && x.vendor_name === v && String(x.invoice_no ?? "").toLowerCase() === n.toLowerCase());
  };

  const aiChanged = (r: DbRow, col: InputCol): string | null => {
    const ai = r.ai_values?.[col.key];
    if (ai === null || ai === undefined) return null;
    const cur = display(r, col);
    if (col.type === "money" ? cur !== "" && D(cur).eq(D(ai)) : cur === ai) return null;
    return ai;
  };

  // ---- mode handling --------------------------------------------------
  const resetRowEdit = () => { setEditId(null); setDraft({}); setErrors({}); };
  const closeDialog = () => setDialog(null);

  const beginEditRow = (r: DbRow) => {
    if (mode !== "edit" || editId !== null || pending) return;
    setEditId(r.id); setDraft(toDraft(r)); setErrors({});
  };

  const discardRow = () => resetRowEdit();

  const doSaveRow = (thenFinish = false) => {
    const r = original(editId);
    if (!r) return;
    const keys = changedKeys(r);
    start(async () => {
      const res = await updateRow(r.id, toPayload(keys));
      if (res.ok) { setRows((all) => all.map((x) => (x.id === r.id ? res.row : x))); resetRowEdit(); setNotice(null); if (thenFinish) setMode("none"); }
      else { setErrors(res.fieldErrors ?? {}); setNotice(res.error); }
    });
  };

  /** Save button of a row: validate, ask about a possible duplicate, then write. */
  const saveRow = (thenFinish = false) => {
    const r = original(editId);
    if (!r) return;
    const keys = changedKeys(r);
    if (keys.length === 0) { resetRowEdit(); if (thenFinish) setMode("none"); return; }
    const errs = listErrors(keys);
    if (Object.keys(errs).length) { setErrors(errs); setNotice("Ada isian yang belum valid. Periksa sel yang berwarna merah."); return; }
    setErrors({}); setNotice(null);
    if ((keys.includes("vendor_name") || keys.includes("invoice_no")) && isDuplicate(r.id)) {
      setDialog({
        title: `Invoice "${draft.invoice_no}" dari vendor ini sudah ada`,
        text: "Vendor dan Invoice No yang sama muncul di baris lain. Periksa apakah ini duplikat, atau lanjutkan jika memang tagihan yang berbeda.",
        primary: "Lanjut simpan", secondary: "Perbaiki isian", danger: true,
        onPrimary: () => { closeDialog(); doSaveRow(thenFinish); }, onSecondary: closeDialog,
      });
      return;
    }
    doSaveRow(thenFinish);
  };

  const finishEdit = () => {
    const r = original(editId);
    if (r && changedKeys(r).length > 0) {
      setDialog({
        title: "Selesai mengedit?", text: "Masih ada perubahan yang belum disimpan pada satu baris.",
        primary: "Simpan dan selesai", secondary: "Buang perubahan",
        onPrimary: () => { closeDialog(); saveRow(true); }, onSecondary: () => { closeDialog(); resetRowEdit(); setMode("none"); },
      });
      return;
    }
    resetRowEdit(); setMode("none");
  };

  const startAdd = () => { setMode("add"); setDraft({}); setErrors({}); setNotice(null); };
  const discardAdd = () => { resetRowEdit(); setMode("none"); };

  const doCreate = () => {
    const keys = filledKeys();
    start(async () => {
      const res = await createRow(toPayload(keys));
      if (res.ok) { setRows((all) => [...all, res.row]); resetRowEdit(); setMode("none"); setNotice(null); }
      else { setErrors(res.fieldErrors ?? {}); setNotice(res.error); }
    });
  };

  const finishAdd = () => {
    const keys = filledKeys();
    if (keys.length === 0) { discardAdd(); return; }
    const errs = listErrors(keys);
    if (Object.keys(errs).length) { setErrors(errs); setNotice("Ada isian yang belum valid. Periksa sel yang berwarna merah."); return; }
    setErrors({}); setNotice(null);
    const confirmCreate = () => setDialog({
      title: "Selesai menambah data?", text: "Pastikan data sudah benar sebelum disimpan.",
      primary: "Simpan dan selesai", secondary: "Kembali",
      onPrimary: () => { closeDialog(); doCreate(); }, onSecondary: closeDialog,
    });
    if (isDuplicate(null)) {
      setDialog({
        title: `Invoice "${draft.invoice_no}" dari vendor ini sudah ada`,
        text: "Vendor dan Invoice No yang sama muncul di baris lain. Lanjutkan hanya jika ini tagihan yang berbeda.",
        primary: "Lanjut", secondary: "Perbaiki isian", danger: true,
        onPrimary: confirmCreate, onSecondary: closeDialog,
      });
      return;
    }
    confirmCreate();
  };

  const askDelete = (r: DbRow) => setDialog({
    title: "Hapus baris ini?", text: "Hanya baris yang belum bernomor yang bisa dihapus. Tindakan ini tidak bisa dibatalkan.",
    primary: "Hapus", secondary: "Batal", danger: true,
    onPrimary: () => {
      closeDialog();
      start(async () => {
        const res = await deleteDraftRow(r.id);
        if (res.ok) { setRows((all) => all.filter((x) => x.id !== r.id)); if (editId === r.id) resetRowEdit(); } else setNotice(res.error ?? "Gagal menghapus.");
      });
    },
    onSecondary: closeDialog,
  });

  const visible = rows
    .filter((r) => {
      const c = computed.get(r.id)!;
      if (onlyWarn && c.warnings.length === 0 && !dupes.has(r.id)) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [r.vendor_name, r.invoice_no, r.description, c.payment_no].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
    })
    .sort((a, b) => (a.seq === null ? 1 : 0) - (b.seq === null ? 1 : 0) || (a.fiscal_year ?? 0) - (b.fiscal_year ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));

  // ---- layout: explicit widths + sticky offsets ---------------------------
  const editing = mode === "edit";
  const leftCols = [...(editing ? [W_ACTIONS] : []), W_SOURCE, colWidth(COLUMNS[0]), colWidth(COLUMNS[1])];
  const offsets = leftCols.map((_, i) => leftCols.slice(0, i).reduce((a, b) => a + b, 0));
  const lead = editing ? 1 : 0; // index of the "Sumber" column inside leftCols
  const stickyStyle = (slot: number) => ({ left: offsets[slot] });
  const totalWidth = leftCols.reduce((a, b) => a + b, 0) + COLUMNS.slice(2).reduce((a, c) => a + colWidth(c), 0);
  const slotOf = (idx: number) => (idx < 2 ? lead + 1 + idx : -1);

  const rowBg = (i: number) => (i % 2 === 0 ? "bg-white" : "bg-[#f3faff]");
  const compBg = (i: number) => (i % 2 === 0 ? "bg-[#f1f4f9]" : "bg-[#e8f0fa]");

  // ---- cell editor ------------------------------------------------------
  const editor = (col: InputCol, auto = false): ReactNode => {
    const err = errors[col.key];
    const set = (v: string) => { setDraft((d) => ({ ...d, [col.key]: v })); if (err) setErrors((x) => { const n = { ...x }; delete n[col.key]; return n; }); };
    const cls = `h-full w-full rounded-sm bg-white px-2 text-sm text-ink outline-none ring-1 ring-inset focus:ring-2 focus:ring-brand-500 ${err ? "bg-danger-50 ring-danger" : "ring-line"} ${col.type === "money" ? "text-right tabular-nums" : ""}`;
    const optList = col.key === "payment_status" ? options.status : col.list ? options[col.list] : null;
    if (optList) return <Combobox value={draft[col.key] ?? ""} onChange={set} options={optList} className={cls} title={err} placeholder="—" autoFocus={auto} allowCustom={col.key === "payment_status"} />;
    return (
      <input
        autoFocus={auto}
        value={draft[col.key] ?? ""}
        onChange={(e) => set(e.target.value)}
        type={col.type === "date" ? "date" : "text"}
        inputMode={col.type === "money" ? "decimal" : undefined}
        title={err}
        placeholder={col.type === "date" ? "" : "—"}
        className={cls}
      />
    );
  };

  const th = "sticky top-0 font-display border border-[#d5dfee] px-3 text-center align-middle text-[13px] font-bold leading-tight text-white";
  const td = "border border-[#d5dfee] px-3 text-sm align-middle";
  const rowH = { height: 56 };

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 flex flex-col gap-3 overflow-auto bg-white p-4" : "space-y-3"}>
      <CounterBar counters={counterList} defaultYear={defaultYear} onSaved={(y, n) => setCounterList((l) => [...l.filter((c) => c.fiscal_year !== y), { fiscal_year: y, last_seq: n }].sort((a, b) => a.fiscal_year - b.fiscal_year))} setNotice={setNotice} />
      {notice && <p className="alert-warn flex justify-between"><span>{notice}</span><button className="link" onClick={() => setNotice(null)}>tutup</button></p>}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button className={btn("light", "!px-2")} onClick={() => setFullscreen((f) => !f)} title={fullscreen ? "Keluar layar penuh" : "Layar penuh"}>{fullscreen ? "⤡" : "⤢"}</button>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari vendor, invoice, deskripsi…" className="h-10 w-80 rounded-md border-2 border-[#a4b3cd] bg-white px-3 text-sm text-[#181b25] placeholder:text-faint focus:border-[#1e5af6] focus:outline-none" />
        <label className="flex items-center gap-1.5 text-[#5e6c84]"><input type="checkbox" checked={onlyWarn} onChange={(e) => setOnlyWarn(e.target.checked)} /> hanya yang ada peringatan</label>

        <div className="ml-auto flex items-center gap-2">
          {mode === "none" && <>
            <button className={btn("light")} onClick={() => { setMode("edit"); resetRowEdit(); }} disabled={pending}>✎ Edit Data</button>
            <button className={btn("light")} onClick={startAdd} disabled={pending}>＋ Add Data</button>
          </>}
          {mode === "edit" && <>
            <button className={btn("primary")} onClick={finishEdit} disabled={pending}>✓ Finish Edit</button>
            <button className={btn("light")} disabled>＋ Add Data</button>
          </>}
          {mode === "add" && <>
            <button className={btn("danger")} onClick={discardAdd} disabled={pending}>✕ Discard Add</button>
            <button className={btn("primary")} onClick={finishAdd} disabled={pending}>✓ Finish Add</button>
          </>}
          {mode === "none"
            ? <a href="/api/payment-schedule/export" className={btn("light")}>Export CSV</a>
            : <span className={btn("light", "!bg-[#a4b3cd] !text-white cursor-not-allowed")}>Export CSV</span>}
        </div>
      </div>
      <div className="flex justify-between text-sm text-[#5e6c84]">
        <span>{mode === "edit" ? (editId ? "Ubah isian lalu klik Save pada baris ini." : "Klik sebuah baris untuk mengeditnya. Satu baris dalam satu waktu.") : mode === "add" ? "Isi baris di bagian atas tabel, lalu klik Finish Add." : "Klik Edit Data untuk mengubah, atau Add Data untuk menambah baris."}</span>
        <span>Showing {visible.length} of {rows.length} row{rows.length === 1 ? "" : "s"}{pending && " · menyimpan…"}</span>
      </div>


      <div className={`overflow-auto rounded-lg border border-[#d5dfee] bg-white ${fullscreen ? "min-h-0 flex-1" : "max-h-[72vh]"}`}>
        <table className="border-separate border-spacing-0" style={{ tableLayout: "fixed", width: totalWidth }}>
          <colgroup>
            {editing && <col style={{ width: W_ACTIONS }} />}
            <col style={{ width: W_SOURCE }} />
            {COLUMNS.map((col) => <col key={col.key} style={{ width: colWidth(col) }} />)}
          </colgroup>
          <thead>
            <tr style={{ height: HEADER_H }}>
              {editing && <th className={`${th} left-0 z-30 bg-[#1a48d0]`} style={stickyStyle(0)}>Actions</th>}
              <th className={`${th} z-30 bg-[#1a48d0]`} style={stickyStyle(lead)}>Sumber</th>
              {COLUMNS.map((col, idx) => {
                const slot = slotOf(idx);
                return (
                  <th key={col.key} className={`${th} ${slot >= 0 ? "z-30" : "z-20"} ${(idx + 1) % 2 === 0 ? "bg-[#1a48d0]" : "bg-[#4a83f9]"}`} style={slot >= 0 ? stickyStyle(slot) : undefined}>
                    {col.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {mode === "add" && (
              <tr style={rowH}>
                <td className={`${td} sticky z-20 bg-[#fffbe9] text-xs font-bold text-[#e8641f]`} style={{ ...stickyStyle(lead), top: HEADER_H }}>Baris baru</td>
                {COLUMNS.map((col, idx) => {
                  const slot = slotOf(idx);
                  const pin = { position: "sticky" as const, top: HEADER_H, ...(slot >= 0 ? stickyStyle(slot) : {}) };
                  return col.kind === "computed"
                    ? <td key={col.key} className={`${td} z-10 bg-[#f1f4f9] text-center text-faint ${slot >= 0 ? "!z-20" : ""}`} style={pin}>otomatis</td>
                    : <td key={col.key} className={`${td} z-10 bg-[#fffbe9] p-1`} style={pin}>{editor(col, col.key === "vendor_name")}</td>;
                })}
              </tr>
            )}
            {visible.map((r, i) => {
              const c = computed.get(r.id)!;
              const isRowEditing = editing && editId === r.id;
              const warn = [...c.warnings, ...(dupes.has(r.id) ? ["Vendor + Invoice No yang sama muncul di baris lain (kemungkinan duplikat)."] : [])];
              const isDupe = dupes.has(r.id);
              const bg = r.id === highlightId ? "bg-[#dbeeff]" : isRowEditing ? "bg-[#fffbe9]" : rowBg(i);
              const clickable = editing && editId === null;
              return (
                <tr key={r.id} id={`row-${r.id}`} style={rowH} className={clickable ? "cursor-pointer hover:brightness-95" : ""} onClick={() => beginEditRow(r)}>
                  {editing && (
                    <td className={`${td} sticky left-0 z-20 p-2 ${bg}`}>
                      <div className="flex gap-2">
                        <button className={btn("danger", "!px-2 !py-1 flex-1")} disabled={!isRowEditing || pending} onClick={(e) => { e.stopPropagation(); discardRow(); }}>Discard</button>
                        <button className={btn("light", "!px-2 !py-1 flex-1")} disabled={!isRowEditing || pending} onClick={(e) => { e.stopPropagation(); saveRow(); }}>Save</button>
                        {r.seq === null && !isRowEditing && <button className="text-xs text-[#e02954] hover:underline" disabled={pending} onClick={(e) => { e.stopPropagation(); askDelete(r); }} title="Hapus baris yang belum bernomor">hapus</button>}
                      </div>
                    </td>
                  )}
                  <td className={`${td} sticky z-20 text-xs ${bg}`} style={stickyStyle(lead)}>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      {warn.length > 0 && <span title={warn.join("\n")} className="cursor-help text-warn">⚠</span>}
                      {r.attachment_id && <a className="link" target="_blank" href={`/api/attachments/${r.attachment_id}`}>PDF</a>}
                      {r.extraction_id && <Link className="link" href={`/extractions/${r.extraction_id}`}>AI</Link>}
                    </div>
                  </td>
                  {COLUMNS.map((col, idx) => {
                    const slot = slotOf(idx);
                    const pos = slot >= 0 ? `sticky z-20 ` : "";
                    const st = slot >= 0 ? stickyStyle(slot) : undefined;
                    if (col.kind === "computed") {
                      return <td key={col.key} style={st} className={`${td} ${pos}${compBg(i)} text-[#5e6c84] ${col.num ? "text-right tabular-nums" : ""}`}><div className="line-clamp-2 break-words">{col.key === "xero_import" ? (typeof r.xero_import_status === "string" ? r.xero_import_status : "") : computedText(col.key, c) || <TaxHint colKey={col.key} r={r} />}</div></td>;
                    }
                    if (isRowEditing) return <td key={col.key} style={st} className={`${td} ${pos}p-1 ${bg}`}>{editor(col)}</td>;
                    const ai = aiChanged(r, col);
                    const text = display(r, col);
                    return (
                      <td key={col.key} style={st} className={`${td} ${pos}${bg} ${isDupe ? "text-[#ff6b6b]" : "text-[#181b25]"} ${col.type === "money" ? "text-right tabular-nums" : ""}`}>
                        <div className="line-clamp-2 break-words" title={text}>
                          {text}
                          {ai !== null && <span title={`Nilai AI: ${ai}`} className="ml-0.5 cursor-help text-lg font-bold leading-none text-[#e8641f]">*</span>}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && mode !== "add" && <p className="p-4 text-sm text-[#5e6c84]">{rows.length === 0 ? "Belum ada baris. Buat dari hasil ekstraksi, atau klik Add Data." : "Tidak ada baris yang cocok."}</p>}
      </div>

      {dialog && <ConfirmDialog d={dialog} busy={pending} />}
    </div>
  );
}

/** Why a tax cell is blank: its tax applies to the Tax Category but an input it needs is missing. */
function TaxHint({ colKey, r }: { colKey: string; r: DbRow }) {
  const trigger = TAX_TRIGGERS[colKey as keyof typeof TAX_TRIGGERS];
  const category = typeof r.tax_category === "string" ? r.tax_category : "";
  if (!trigger || !category || !trigger.test(category)) return null;
  const missing = !r.dpp ? "isi DPP" : colKey === "pph21" && r.npwp_flag !== "Y" && r.npwp_flag !== "N" ? "isi NPWP? Y/N" : null;
  return missing ? <span className="text-xs italic text-warn">{missing}</span> : null;
}

function computedText(key: string, c: Computed): string {
  switch (key) {
    case "no": return c.no === null ? "" : String(c.no);
    case "payment_no": return c.payment_no ?? "";
    case "xero_ref": return c.xero_ref ?? "";
    case "department": return c.department ?? "";
    case "xero_import": return "";
    case "rate_idr": return fmtRate(c.rate_idr);
    case "rate_usd": return fmtRate(c.rate_usd);
    default: return fmt(c[key as keyof Computed] as Num | null);
  }
}

function CounterBar({ counters, defaultYear, onSaved, setNotice }: {
  counters: { fiscal_year: number; last_seq: number }[]; defaultYear: number;
  onSaved: (year: number, last: number) => void; setNotice: (m: string | null) => void;
}) {
  const [year, setYear] = useState(String(defaultYear));
  const [last, setLast] = useState("");
  const [pending, start] = useTransition();
  const has = counters.some((c) => c.fiscal_year === defaultYear);
  const submit = () => start(async () => {
    const res = await setCounter(Number(year), Number(last));
    if (res.ok) { onSaved(Number(year), Number(last)); setLast(""); setNotice(null); } else setNotice(res.error ?? "Gagal menyimpan nomor.");
  });
  return (
    <details className={`card p-3 text-sm ${has ? "" : "border-warn/30 bg-warn-50"}`} open={!has}>
      <summary className="cursor-pointer text-ink">
        Penomoran Payment No: {counters.length ? counters.map((c) => `${c.fiscal_year}: terakhir ${c.last_seq}`).join(" · ") : "belum diatur"}
        {!has && <b className="ml-2 text-warn">Atur dulu sebelum mengisi Input Date.</b>}
      </summary>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-subtle">Tahun<input value={year} onChange={(e) => setYear(e.target.value)} className="input block w-24" inputMode="numeric" /></label>
        <label className="space-y-1 text-xs text-subtle">Nomor terakhir yang sudah dipakai di spreadsheet<input value={last} onChange={(e) => setLast(e.target.value)} className="input block w-64" inputMode="numeric" placeholder="mis. 735" /></label>
        <button className="btn btn-primary" onClick={submit} disabled={pending || last === ""}>Simpan</button>
        <p className="muted w-full text-xs">Nomor berikutnya = angka ini + 1. Nomor hanya boleh dinaikkan, tidak diturunkan, agar tidak pernah terbit dua kali. Baris mendapat Payment No saat Input Date pertama kali diisi.</p>
      </div>
    </details>
  );
}
