import Link from "next/link";
import { connection } from "next/server";
import { getActiveConnection } from "@/lib/gmail/connection";
import { DEFAULT_QUERY } from "@/lib/gmail/parse";
import { createClient } from "@/lib/supabase/server";
import { InboxTable, type EmailRow } from "./inbox-table";
import { SyncPanel } from "./sync-panel";

const ERRORS: Record<string, string> = {
  config: "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, atau TOKEN_ENCRYPTION_KEY belum diisi di .env.",
  state: "Sesi login Google tidak valid. Coba hubungkan lagi.",
  denied: "Izin Google dibatalkan atau ditolak.",
  no_refresh: "Google tidak memberi refresh token. Cabut akses AP Hub di myaccount.google.com/permissions lalu coba lagi.",
  scope: "Izin membaca Gmail tidak diberikan.",
  save: "Gagal menyimpan koneksi. Pastikan migrasi gmail_inbox sudah dijalankan.",
  oauth: "Gagal menukar kode dengan Google. Periksa Client ID/Secret dan redirect URI.",
};
const FILTERS = [["", "Semua"], ["pdf", "PDF"], ["link", "Link"], ["none", "Tanpa dokumen"]] as const;

type Att = { id: string; filename: string; status: string; error: string | null; size_bytes: number | null; sha256: string | null };
type Row = {
  id: string; from_address: string; subject: string; received_at: string | null; classification: string;
  review_status: string; links: { host: string; path: string }[]; gmail_message_id: string; email_attachments: Att[];
};

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  await connection();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const filter = str("type");
  const showHidden = str("hidden") === "1";

  const conn = await getActiveConnection();
  const db = await createClient();
  let q = db
    .from("email_messages")
    .select("id,from_address,subject,received_at,classification,review_status,links,gmail_message_id,email_attachments(id,filename,status,error,size_bytes,sha256)")
    .order("received_at", { ascending: false })
    .limit(200);
  if (filter === "link") q = q.in("classification", ["link", "link_unsure"]);
  else if (filter) q = q.eq("classification", filter);
  if (!showHidden) q = q.eq("review_status", "new");
  const { data, error } = await q;
  const rows = (data ?? []) as unknown as Row[];

  // Same PDF content arriving in more than one email.
  const shaCount = new Map<string, number>();
  rows.forEach((r) => r.email_attachments.forEach((a) => a.sha256 && shaCount.set(a.sha256, (shaCount.get(a.sha256) ?? 0) + 1)));

  // Latest extraction run per PDF.
  const attIds = rows.flatMap((r) => r.email_attachments.map((a) => a.id));
  const { data: runs } = attIds.length
    ? await db.from("document_extractions").select("id,attachment_id,status,error,created_at").in("attachment_id", attIds).order("created_at", { ascending: false })
    : { data: [] };
  const latest = new Map<string, { id: string; status: string; error: string | null }>();
  // Prefer a successful run over a later failed one, so a good result is never hidden by a retry.
  (runs ?? []).forEach((x) => { const cur = latest.get(x.attachment_id); if (!cur || (cur.status !== "succeeded" && x.status === "succeeded")) latest.set(x.attachment_id, { id: x.id, status: x.status, error: x.error }); });
  const tableRows: EmailRow[] = rows.map((r) => ({
    id: r.id, from: r.from_address, subject: r.subject, receivedAt: r.received_at, classification: r.classification,
    reviewStatus: r.review_status, links: r.links, gmailId: r.gmail_message_id,
    attachments: r.email_attachments.map((a) => ({
      id: a.id, filename: a.filename, status: a.status, error: a.error,
      duplicate: !!a.sha256 && (shaCount.get(a.sha256) ?? 0) > 1, extraction: latest.get(a.id) ?? null,
    })),
  }));

  const href = (type: string, hidden = showHidden) => `/inbox?${new URLSearchParams({ ...(type ? { type } : {}), ...(hidden ? { hidden: "1" } : {}) })}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl">Inbox</h1>
        <p className="muted text-sm">Web ini hanya membaca, tidak mengubah atau menghapus email.</p>
      </div>
      {str("error") && <p className="alert-error">{ERRORS[str("error")] ?? "Terjadi kesalahan."}</p>}
      {str("connected") && <p className="alert-ok">Gmail terhubung.</p>}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {conn ? <span>Terhubung: <b className="font-bold text-ink">{conn.email}</b></span> : <span className="muted">Belum terhubung.</span>}
        <Link href="/inbox/filters" className="link">Filter email</Link>
        <a href="/api/gmail/connect" className="btn">{conn ? "Hubungkan ulang" : "Hubungkan Gmail"}</a>
      </div>
      {conn && <SyncPanel defaultQuery={DEFAULT_QUERY} />}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map(([v, l]) => (
          <Link key={l} href={href(v)} className={`btn ${filter === v ? "btn-primary" : ""}`}>{l}</Link>
        ))}
        <Link href={href(filter, !showHidden)} className="link ml-2">{showHidden ? "sembunyikan 'bukan invoice'" : "tampilkan 'bukan invoice'"}</Link>
      </div>

      {error ? (
        <p className="alert-error">Gagal memuat: {error.message}</p>
      ) : (
        <InboxTable rows={tableRows} />
      )}
      {!error && rows.length === 0 && <p className="muted text-sm">{conn ? "Belum ada email. Klik Sinkronkan." : "Hubungkan Gmail untuk mulai."}</p>}
    </div>
  );
}
