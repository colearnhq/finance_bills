"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { chooseXeroTenant, deleteBill, disconnectXero, prepareBills, rebuildBill, sendBillsToXero, unlockRejectedBill, type PrepareResult } from "@/lib/xero/actions";
import type { BillHeader, BillLine } from "@/lib/xero/bill";
import { COLS, type Rec } from "@/lib/xero/columns";
import { describeSync, type Tone } from "@/lib/xero/status";
import type { SyncRow } from "@/lib/xero/sync";
import { btn, ConfirmDialog, type Dialog } from "../ui";

export interface Candidate { id: string; paymentNo: string; vendor: string; invoiceNo: string; ok: boolean; problems: string[]; warnings: string[] }
export interface BillView {
  id: string; status: "prepared" | "exported"; exportedAt: string | null; exportCount: number;
  stale: { kind: "changed" | "broken"; messages: string[] } | null;
  header: Omit<BillHeader, "payment_schedule_id"> & { payment_schedule_id?: string }; lines: BillLine[];
  sync: SyncRow | null;
}
export interface XeroStatus {
  configured: boolean; connected: boolean; tenantName: string | null; isDemo: boolean | null; needsTenantChoice: boolean;
  tenants: { tenantId: string; tenantName: string }[]; refreshDaysLeft: number | null; productionWritesAllowed: boolean;
}
const TONE: Record<Tone, string> = { neutral: "text-subtle", ok: "text-ok", warn: "text-warn", bad: "text-danger" };

const W_STATUS = 210;
const W_XERO = 250;
const SEND_LIMIT = 10;

export function XeroBills({ candidates, bills, xero, flash }: { candidates: Candidate[]; bills: BillView[]; xero: XeroStatus; flash: { kind: "ok" | "error"; text: string } | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set()); // schedule rows to prepare
  const [selected, setSelected] = useState<Set<string>>(new Set()); // bills to export
  const [failed, setFailed] = useState<PrepareResult[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "prepared" | "exported">("all");
  const [failures, setFailures] = useState<{ reference: string; message: string }[]>([]);
  const canWrite = xero.connected && !xero.needsTenantChoice && (xero.isDemo === true || xero.productionWritesAllowed);

  const readyIds = candidates.filter((c) => c.ok).map((c) => c.id);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bills.filter((b) => (filter === "all" || b.status === filter) && (!q || [b.header.reference_no, b.header.contact_name, ...b.lines.map((l) => l.description)].some((v) => v.toLowerCase().includes(q))));
  }, [bills, query, filter]);
  const records = visible.reduce((n, b) => n + b.lines.length, 0);

  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };

  const prepare = () => start(async () => {
    const res = await prepareBills([...picked]);
    setFailed(res.results.filter((r) => !r.ok));
    const done = res.results.filter((r) => r.ok).length;
    setNotice(res.error ?? (res.ok ? `${done} bill disiapkan.` : `${done} bill disiapkan, ${res.results.length - done} ditolak (lihat alasannya di daftar).`));
    setPicked(new Set());
    router.refresh();
  });

  const doExport = () => start(async () => {
    const res = await fetch("/api/xero-bills/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...selected] }) });
    if (!res.ok) { setNotice(`Ekspor gagal: ${await res.text()}`); router.refresh(); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "xero-bills.csv";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    setNotice(`${selected.size} bill diekspor.`);
    setSelected(new Set());
    router.refresh();
  });

  const askExport = () => {
    const prepared = bills.filter((b) => selected.has(b.id) && b.status === "prepared");
    if (prepared.length === 0) { doExport(); return; }
    const stale = prepared.filter((b) => b.stale).length;
    setDialog({
      title: `Ekspor ${selected.size} bill dan kunci?`,
      text: `${prepared.length} bill akan berstatus Exported dan tidak bisa diubah lagi. ${stale ? `${stale} di antaranya tidak sama lagi dengan Payment Schedule: siapkan ulang dulu bila perlu. ` : ""}Pastikan data sudah benar sebelum diimpor ke Xero.`,
      primary: "Ekspor dan kunci", secondary: "Batal", danger: stale > 0,
      onPrimary: () => { setDialog(null); doExport(); }, onSecondary: () => setDialog(null),
    });
  };

  const askDelete = (b: BillView) => setDialog({
    title: "Hapus bill ini?", text: `${b.header.reference_no} akan dihapus. Baris Payment Schedule-nya tidak berubah dan bisa disiapkan lagi.`,
    primary: "Hapus", secondary: "Batal", danger: true,
    onPrimary: () => {
      setDialog(null);
      start(async () => {
        const r = await deleteBill(b.id);
        if (!r.ok) setNotice(r.error ?? "Gagal menghapus.");
        setSelected((s) => { const n = new Set(s); n.delete(b.id); return n; });
        router.refresh();
      });
    },
    onSecondary: () => setDialog(null),
  });

  const rebuild = (b: BillView) => start(async () => {
    const r = await rebuildBill(b.id);
    setNotice(r.ok ? `${b.header.reference_no} disiapkan ulang.` : `Tidak bisa disiapkan ulang: ${r.problems.join(" ")}`);
    router.refresh();
  });

  const send = (ids: string[]) => start(async () => {
    const res = await sendBillsToXero(ids);
    const bad = res.results.filter((r) => !r.outcome.ok);
    setFailures(bad.map((r) => ({ reference: r.reference, message: r.outcome.problems.length > 1 ? r.outcome.problems.join(" | ") : r.outcome.message })));
    const sent = res.results.length - bad.length;
    setNotice(res.error ?? (bad.length === 0 ? `${sent} bill terkirim ke Xero sebagai Draft.` : `${sent} terkirim, ${bad.length} belum berhasil (lihat alasannya di bawah).`));
    setSelected(new Set());
    router.refresh();
  });

  const askSend = () => {
    const sendable = bills.filter((b) => selected.has(b.id) && describeSync(b.sync).canSend);
    if (sendable.length === 0) { setNotice("Tidak ada bill terpilih yang bisa dikirim."); return; }
    if (sendable.length > SEND_LIMIT) { setNotice(`Maksimal ${SEND_LIMIT} bill sekali kirim (batas panggilan Xero 60 per menit). Pilih lebih sedikit.`); return; }
    setDialog({
      title: `Kirim ${sendable.length} bill ke Xero?`,
      text: `Draft bill dibuat di organisasi "${xero.tenantName}" (${xero.isDemo ? "Demo Company" : "PRODUKSI"}) beserta PDF aslinya. Bill akan terkunci di sini. Tidak ada yang disetujui atau dibayar di Xero.`,
      primary: "Kirim ke Xero", secondary: "Batal", danger: xero.isDemo !== true,
      onPrimary: () => { setDialog(null); send(sendable.map((b) => b.id)); }, onSecondary: () => setDialog(null),
    });
  };

  const unlock = (b: BillView) => start(async () => {
    const r = await unlockRejectedBill(b.id);
    setNotice(r.ok ? `${b.header.reference_no} dibuka kuncinya: bisa disiapkan ulang atau dikirim lagi.` : r.error ?? "Gagal membuka kunci.");
    router.refresh();
  });

  const th = "sticky top-0 font-display border border-[#d5dfee] px-3 text-center align-middle text-[13px] font-bold leading-tight text-white";
  const td = "border border-[#d5dfee] px-3 text-sm align-middle";
  const total = W_STATUS + W_XERO + COLS.reduce((n, c) => n + c.w, 0);

  return (
    <div className="space-y-4">
      {flash && <p className={flash.kind === "ok" ? "alert-ok" : "alert-error"}>{flash.text}</p>}
      <XeroPanel xero={xero} setNotice={setNotice} setDialog={setDialog} />
      {notice && <p className="alert-warn flex justify-between"><span>{notice}</span><button className="link" onClick={() => setNotice(null)}>tutup</button></p>}
      {failures.length > 0 && (
        <ul className="space-y-1 rounded-md border border-danger/30 bg-danger-50 px-4 py-2 text-xs text-danger">
          {failures.map((f) => <li key={f.reference}><b>{f.reference}</b>: {f.message}</li>)}
        </ul>
      )}

      <details className="card p-4 text-sm" open={candidates.length > 0}>
        <summary className="cursor-pointer font-display font-bold text-ink">
          Siap disiapkan dari Payment Schedule ({candidates.length}){readyIds.length > 0 && <span className="ml-2 font-normal text-ok">{readyIds.length} siap</span>}
        </summary>
        {candidates.length === 0 ? <p className="muted mt-3">Semua baris bernomor sudah punya bill. Baris yang belum bernomor (Input Date kosong) tidak muncul di sini.</p> : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button className={btn("primary")} disabled={picked.size === 0 || pending} onClick={prepare}>Siapkan {picked.size > 0 ? `${picked.size} ` : ""}bill</button>
              <button className={btn("light")} disabled={readyIds.length === 0 || pending} onClick={() => setPicked(picked.size === readyIds.length ? new Set() : new Set(readyIds))}>{picked.size === readyIds.length && readyIds.length > 0 ? "Batal pilih semua" : "Pilih semua yang siap"}</button>
              {pending && <span className="muted">memproses…</span>}
            </div>
            <ul className="divide-y divide-[#d5dfee] rounded-md border border-[#d5dfee]">
              {candidates.map((c) => {
                const fail = failed.find((f) => f.id === c.id);
                return (
                  <li key={c.id} className="flex gap-3 px-3 py-2">
                    <input type="checkbox" className="mt-1" disabled={!c.ok} checked={picked.has(c.id)} onChange={() => setPicked((p) => toggle(p, c.id))} aria-label={`Pilih ${c.paymentNo}`} />
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-ink">{c.paymentNo} <span className="font-normal text-subtle">· {c.vendor || "(tanpa vendor)"} · {c.invoiceNo || "(tanpa no invoice)"}</span></div>
                      {c.ok
                        ? <div className="text-xs text-ok">Siap{c.warnings.length > 0 && <span className="text-warn"> · {c.warnings.join(" ")}</span>}</div>
                        : <ul className="list-disc pl-5 text-xs text-danger">{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
                      {fail && <div className="text-xs text-danger">Ditolak: {fail.problems.join(" ")}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </details>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari referensi, kontak, deskripsi…" className="h-10 w-80 rounded-md border-2 border-[#a4b3cd] bg-white px-3 text-sm text-[#181b25] placeholder:text-slate-400 focus:border-[#1e5af6] focus:outline-none" />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-10 rounded-md border-2 border-[#a4b3cd] bg-white px-2 text-sm text-ink focus:border-[#1e5af6] focus:outline-none" aria-label="Filter status">
          <option value="all">Semua status</option><option value="prepared">Prepared</option><option value="exported">Exported</option>
        </select>
        <span className="text-[#5e6c84]">{visible.length} bill · {records} record</span>
        <div className="ml-auto flex items-center gap-2">
          <button className={btn("light")} disabled={visible.length === 0} onClick={() => setSelected(selected.size === visible.length ? new Set() : new Set(visible.map((b) => b.id)))}>{selected.size === visible.length && visible.length > 0 ? "Batal pilih" : "Pilih semua"}</button>
          <button className={btn("light")} disabled={selected.size === 0 || pending} onClick={askExport}>Ekspor CSV{selected.size > 0 ? ` (${selected.size})` : ""}</button>
          <button className={btn("primary")} disabled={selected.size === 0 || pending || !canWrite} onClick={askSend} title={canWrite ? undefined : "Hubungkan Xero (Demo Company) dulu"}>Kirim ke Xero{selected.size > 0 ? ` (${selected.size})` : ""}</button>
        </div>
      </div>

      <div className="max-h-[68vh] overflow-auto rounded-lg border border-[#d5dfee] bg-white">
        <table className="border-separate border-spacing-0" style={{ tableLayout: "fixed", width: total }}>
          <colgroup><col style={{ width: W_STATUS }} /><col style={{ width: W_XERO }} />{COLS.map((c) => <col key={c.label} style={{ width: c.w }} />)}</colgroup>
          <thead>
            <tr style={{ height: 48 }}>
              <th className={`${th} left-0 z-30 bg-[#1a48d0]`}>Status</th>
              <th className={`${th} z-20 bg-[#4a83f9]`}>Xero</th>
              {COLS.map((c, i) => <th key={c.label} className={`${th} ${i === 0 ? "z-30" : "z-20"} ${i % 2 === 0 ? "bg-[#4a83f9]" : "bg-[#1a48d0]"}`} style={i === 0 ? { left: W_STATUS } : undefined}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.map((b, bi) => {
              const bg = bi % 2 === 0 ? "bg-white" : "bg-[#f3faff]";
              return b.lines.map((line, li) => {
                const rec: Rec = { header: b.header, line };
                const first = li === 0;
                const top = first ? "border-t-2 border-t-[#a4b3cd]" : "";
                return (
                  <tr key={`${b.id}:${line.line_no}`} style={{ height: 52 }}>
                    <td className={`${td} sticky left-0 z-10 py-1 ${bg} ${top}`}>
                      {first && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" checked={selected.has(b.id)} onChange={() => setSelected((s) => toggle(s, b.id))} aria-label={`Pilih ${b.header.reference_no}`} />
                            <span className={`badge ${b.status === "exported" ? "bg-ok-50 text-ok" : "bg-warn-50 text-warn"}`}>{b.status === "exported" ? (b.sync ? "Terkunci" : "Exported") : "Prepared"}</span>
                            {b.stale && <span title={b.stale.messages.join("\n")} className="cursor-help text-warn">⚠</span>}
                          </div>
                          {b.status === "prepared" && (
                            <div className="flex gap-2 text-xs">
                              <button className="link disabled:opacity-50" disabled={pending} onClick={() => rebuild(b)}>Siapkan ulang</button>
                              <button className="text-danger hover:underline disabled:opacity-50" disabled={pending} onClick={() => askDelete(b)}>Hapus</button>
                            </div>
                          )}
                          {b.status === "exported" && <div className="text-xs text-subtle">{b.exportCount}× diunduh</div>}
                        </div>
                      )}
                    </td>
                    <td className={`${td} ${bg} ${top} py-1`}>
                      {first && <XeroCell b={b} canWrite={canWrite} pending={pending} onSend={() => send([b.id])} onUnlock={() => unlock(b)} />}
                    </td>
                    {COLS.map((c, ci) => {
                      const v = c.get(rec);
                      return (
                        <td key={c.label} style={ci === 0 ? { left: W_STATUS } : undefined} className={`${td} ${ci === 0 ? "sticky z-10 " : ""}${bg} ${top} ${c.right ? "text-right tabular-nums" : ""} ${c.label === "*UnitAmount" && v.startsWith("-") ? "text-danger" : "text-ink"}`}>
                          <div className={c.wrap ? "line-clamp-2 break-words" : "truncate"} title={v}>{v}</div>
                        </td>
                      );
                    })}
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
        {visible.length === 0 && <p className="p-4 text-sm text-[#5e6c84]">{bills.length === 0 ? "Belum ada bill. Siapkan dari daftar di atas." : "Tidak ada bill yang cocok."}</p>}
      </div>
      <p className="text-xs text-subtle">Total hanya ditampilkan di sini dan dikosongkan di CSV, seperti contoh (Xero menghitungnya dari baris). Kolom alamat PO belum punya sumber data, jadi kosong.</p>
      {dialog && <ConfirmDialog d={dialog} busy={pending} />}
    </div>
  );
}

function XeroCell({ b, canWrite, pending, onSend, onUnlock }: { b: BillView; canWrite: boolean; pending: boolean; onSend: () => void; onUnlock: () => void }) {
  const v = describeSync(b.sync);
  return (
    <div className="space-y-0.5">
      <div className={`text-xs font-bold ${TONE[v.tone]}`}>{v.label}</div>
      {v.detail && <div className="line-clamp-2 text-[11px] leading-tight text-subtle" title={v.detail}>{v.detail}</div>}
      <div className="flex gap-2 text-xs">
        {b.sync && v.canSend && canWrite && <button className="link disabled:opacity-50" disabled={pending} onClick={onSend}>{v.sendLabel}</button>}
        {v.canUnlock && <button className="text-danger hover:underline disabled:opacity-50" disabled={pending} onClick={onUnlock}>Buka kunci</button>}
      </div>
    </div>
  );
}

function XeroPanel({ xero, setNotice, setDialog }: { xero: XeroStatus; setNotice: (m: string | null) => void; setDialog: (d: Dialog | null) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tenant, setTenant] = useState(xero.tenants[0]?.tenantId ?? "");

  if (!xero.configured) {
    return <p className="alert-warn">Xero belum dikonfigurasi: isi XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI, dan TOKEN_ENCRYPTION_KEY di <code>apps/web/.env</code>, lalu restart.</p>;
  }
  if (!xero.connected) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <div><b className="font-display text-ink">Xero belum terhubung</b><p className="muted">Hubungkan untuk mengirim bill sebagai Draft beserta PDF-nya. Mulai dengan Demo Company.</p></div>
        <a href="/api/xero/connect" className={btn("primary")}>Hubungkan Xero</a>
      </div>
    );
  }
  if (xero.needsTenantChoice) {
    return (
      <div className="card flex flex-wrap items-center gap-3 p-4 text-sm">
        <b className="font-display text-ink">Pilih organisasi Xero</b>
        <select value={tenant} onChange={(e) => setTenant(e.target.value)} className="h-10 rounded-md border-2 border-[#a4b3cd] bg-white px-2 text-sm text-ink focus:border-[#1e5af6] focus:outline-none" aria-label="Organisasi Xero">
          {xero.tenants.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
        </select>
        <button className={btn("primary")} disabled={pending || !tenant} onClick={() => start(async () => { const r = await chooseXeroTenant(tenant); setNotice(r.ok ? null : r.error ?? "Gagal."); router.refresh(); })}>Pakai organisasi ini</button>
      </div>
    );
  }
  const blocked = xero.isDemo !== true && !xero.productionWritesAllowed;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <b className="font-display text-ink">Terhubung ke {xero.tenantName}</b>
          {xero.isDemo === true && <span className="badge bg-ok-50 text-ok">Demo Company</span>}
          {xero.isDemo === false && <span className="badge bg-danger-50 text-danger">PRODUKSI</span>}
          {xero.isDemo === null && <span className="badge bg-warn-50 text-warn">Jenis organisasi tidak diketahui</span>}
        </div>
        {blocked && <p className="text-xs text-danger">Pengiriman ke organisasi non-demo dimatikan. Set XERO_ALLOW_PRODUCTION_WRITES=true di .env (lalu restart) hanya setelah Anda yakin.</p>}
        {xero.refreshDaysLeft !== null && xero.refreshDaysLeft <= 7 && <p className="text-xs text-warn">Akses Xero habis dalam sekitar {xero.refreshDaysLeft} hari bila tidak dipakai. Hubungkan ulang bila perlu.</p>}
      </div>
      <div className="flex gap-2">
        <a href="/api/xero/connect" className={btn("light")}>Hubungkan ulang</a>
        <button className={btn("danger")} disabled={pending} onClick={() => setDialog({
          title: "Putuskan Xero?", text: "Koneksi di AP Hub dihapus. Bill yang sudah terkirim tetap ada di Xero dan tetap terkunci di sini.",
          primary: "Putuskan", secondary: "Batal", danger: true,
          onPrimary: () => { setDialog(null); start(async () => { await disconnectXero(); router.refresh(); }); }, onSecondary: () => setDialog(null),
        })}>Putuskan</button>
      </div>
    </div>
  );
}
