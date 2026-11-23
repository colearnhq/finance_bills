import "server-only";
import { getMessage } from "@/lib/gmail/api";
import { getAccessToken, getActiveConnection } from "@/lib/gmail/connection";
import { extractBodyText } from "@/lib/gmail/parse";
import { createAdminClient } from "@/lib/supabase/admin";
import { BILLING_ENTITY_PATTERNS, DEFAULT_CURRENCIES } from "./config";
import { ExtractionError, extractWithClaude } from "./model";
import { MODEL, PROMPT_VERSION } from "./schema";
import { validateExtraction } from "./validate";

const MAX_PER_RUN = 10;
const CONCURRENCY = 2;
const STALE_RUNNING_MS = 10 * 60 * 1000;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

export type ItemOutcome = "succeeded" | "failed" | "skipped";
export interface RunResult {
  ok: boolean;
  error?: string;
  succeeded: number;
  failed: number;
  skipped: number;
  notes: string[];
}

type Db = ReturnType<typeof createAdminClient>;
const short = (e: unknown) => (e instanceof Error ? e.message : "Kesalahan tidak diketahui").slice(0, 300);

/**
 * Extracts the chosen PDFs, one Claude call each. Idempotent per attachment: a unique index allows one running
 * extraction at a time, and already-extracted PDFs are skipped unless `redo` is set. Reads Gmail only to fetch
 * the email text that accompanies the PDF.
 */
export async function runExtractions(attachmentIds: string[], userId: string, redo: boolean): Promise<RunResult> {
  const out: RunResult = { ok: true, succeeded: 0, failed: 0, skipped: 0, notes: [] };
  const ids = [...new Set(attachmentIds)];
  if (ids.length === 0) return { ...out, ok: false, error: "Tidak ada PDF yang dipilih." };
  if (ids.length > MAX_PER_RUN) return { ...out, ok: false, error: `Maksimal ${MAX_PER_RUN} PDF per proses. Kurangi pilihan.` };
  const db = createAdminClient();

  // One Gmail token for the whole batch. If Gmail is unavailable, extraction still runs without the email text.
  let token: string | null = null;
  try {
    const conn = await getActiveConnection();
    if (conn) token = await getAccessToken(conn);
  } catch {
    out.notes.push("Gmail tidak bisa diakses: ekstraksi berjalan tanpa isi email.");
  }

  const queue = [...ids];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        const r = await extractOne(db, id, userId, redo, token, out.notes);
        out[r]++;
      }
    }),
  );
  return out;
}

async function extractOne(db: Db, attachmentId: string, userId: string, redo: boolean, token: string | null, notes: string[]): Promise<ItemOutcome> {
  const { data: att } = await db
    .from("email_attachments")
    .select("id,filename,status,storage_path,size_bytes,email_messages(gmail_message_id,subject,from_address)")
    .eq("id", attachmentId)
    .maybeSingle();
  const email = (att?.email_messages as unknown as { gmail_message_id: string; subject: string; from_address: string } | null) ?? null;
  if (!att || !email || att.status !== "stored" || !att.storage_path) {
    notes.push("Satu PDF dilewati: belum tersimpan.");
    return "skipped";
  }

  if (!redo) {
    const { data: done } = await db.from("document_extractions").select("id").eq("attachment_id", attachmentId).eq("status", "succeeded").limit(1);
    if (done?.length) return "skipped";
  }

  // Claim: the partial unique index lets only one running extraction exist per PDF.
  const claim = async () =>
    db
      .from("document_extractions")
      .insert({ attachment_id: attachmentId, model: MODEL, prompt_version: PROMPT_VERSION, email_subject: email.subject, email_from: email.from_address, created_by: userId })
      .select("id")
      .single();
  let { data: row, error } = await claim();
  if (error?.code === "23505") {
    // Someone else is running it, or a crashed run left it "running". Only take over stale ones.
    const { data: running } = await db.from("document_extractions").select("id,created_at").eq("attachment_id", attachmentId).eq("status", "running").maybeSingle();
    if (running && Date.now() - new Date(running.created_at).getTime() > STALE_RUNNING_MS) {
      await db.from("document_extractions").update({ status: "failed", error: "Proses sebelumnya tidak selesai (timeout).", finished_at: new Date().toISOString() }).eq("id", running.id);
      ({ data: row, error } = await claim());
    } else {
      notes.push(`${att.filename}: sedang diproses.`);
      return "skipped";
    }
  }
  if (error || !row) {
    notes.push(`${att.filename}: gagal memulai (${error?.message ?? "?"}).`);
    return "failed";
  }
  const runId = row.id;
  const finish = (patch: Record<string, unknown>) => db.from("document_extractions").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", runId);

  try {
    const dl = await db.storage.from("invoices").download(att.storage_path);
    if (dl.error || !dl.data) throw new ExtractionError("PDF tidak bisa diambil dari Storage.");
    const pdf = Buffer.from(await dl.data.arrayBuffer());
    if (pdf.length > MAX_PDF_BYTES) throw new ExtractionError("PDF lebih dari 15 MB.");

    // Email body: what the model also reads, stored as an audit snapshot.
    let body: string | null = null;
    let bodyStatus: "included" | "unavailable" | "empty" = "unavailable";
    if (token) {
      try {
        body = extractBodyText(await getMessage(token, email.gmail_message_id));
        bodyStatus = body ? "included" : "empty";
      } catch {
        bodyStatus = "unavailable";
      }
    }

    const { extraction, usage } = await extractWithClaude(pdf, { subject: email.subject, from: email.from_address, body });
    const { issues, suggestion } = validateExtraction(extraction, { allowedCurrencies: DEFAULT_CURRENCIES, billingEntityPatterns: BILLING_ENTITY_PATTERNS });
    await finish({
      status: "succeeded",
      result: extraction,
      validation: { issues, suggestion },
      usage,
      email_body_excerpt: body,
      email_body_status: bodyStatus,
    });
    return "succeeded";
  } catch (e) {
    const msg = e instanceof ExtractionError ? e.message : short(e);
    console.error("extraction gagal", runId, msg.slice(0, 120)); // ids only: no document or email text in logs
    await finish({ status: "failed", error: msg });
    notes.push(`${att.filename}: ${msg}`);
    return "failed";
  }
}
