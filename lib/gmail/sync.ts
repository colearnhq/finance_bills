import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAttachment, getMessage, listMessageIds } from "./api";
import { getAccessToken, getActiveConnection, ReconnectRequired } from "./connection";
import { isPdfBytes, parseMessage, type ParsedAttachment, type ParsedMessage } from "./parse";

const MAX_NEW_PER_SYNC = 25;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const CONCURRENCY = 4;

export interface SyncResult {
  ok: boolean;
  error?: string;
  found: number;
  newEmails: number;
  pdfStored: number;
  pdfFailed: number;
  remaining: number;
}

async function mapLimit<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const short = (e: unknown) => (e instanceof Error ? e.message : "Kesalahan tidak diketahui").slice(0, 300);

/**
 * Finds invoice-like emails and stores their PDFs. Idempotent: emails are keyed by Gmail message id and
 * attachments by (email, MIME part), so running it twice never duplicates anything, and failed
 * attachments are retried on the next run. Only reads from Gmail.
 */
export async function syncInbox(query: string, userId: string): Promise<SyncResult> {
  const result: SyncResult = { ok: true, found: 0, newEmails: 0, pdfStored: 0, pdfFailed: 0, remaining: 0 };
  const conn = await getActiveConnection();
  if (!conn) return { ...result, ok: false, error: "Gmail belum terhubung." };
  const db = createAdminClient();

  try {
    const token = await getAccessToken(conn);
    const ids = await listMessageIds(token, query);
    result.found = ids.length;
    if (!ids.length) return result;

    const { data: known } = await db.from("email_messages").select("id,gmail_message_id").in("gmail_message_id", ids);
    const knownMap = new Map((known ?? []).map((k) => [k.gmail_message_id, k.id]));

    // Known emails need work only if some attachment is still pending or failed.
    const retry = new Set<string>();
    if (known?.length) {
      const { data: bad } = await db
        .from("email_attachments")
        .select("email_message_id")
        .in("email_message_id", known.map((k) => k.id))
        .in("status", ["pending", "failed"]);
      const badIds = new Set((bad ?? []).map((b) => b.email_message_id));
      known.filter((k) => badIds.has(k.id)).forEach((k) => retry.add(k.gmail_message_id));
    }

    const unseen = ids.filter((id) => !knownMap.has(id));
    const todo = [...unseen.slice(0, MAX_NEW_PER_SYNC), ...retry];
    result.remaining = Math.max(0, unseen.length - MAX_NEW_PER_SYNC);

    await mapLimit(todo, CONCURRENCY, async (id) => {
      try {
        const parsed = parseMessage(await getMessage(token, id));
        let emailId = knownMap.get(id);
        if (!emailId) {
          const { data, error } = await db
            .from("email_messages")
            .insert({
              connection_id: conn.id,
              gmail_message_id: parsed.gmailMessageId,
              gmail_thread_id: parsed.threadId,
              from_address: parsed.from,
              subject: parsed.subject,
              received_at: parsed.receivedAt,
              classification: parsed.classification,
              links: parsed.links,
              updated_by: userId,
            })
            .select("id")
            .single();
          if (error) throw error;
          emailId = data.id;
          result.newEmails++;
        }
        for (const att of parsed.attachments.filter((a) => a.isPdf)) {
          await storeAttachment(token, db, emailId!, parsed, att, result);
        }
      } catch (e) {
        console.error("sync: email gagal diproses", id, short(e)); // id only: no subject/sender in logs
      }
    });
  } catch (e) {
    return { ...result, ok: false, error: e instanceof ReconnectRequired ? e.message : short(e) };
  }
  return result;
}

async function storeAttachment(
  token: string,
  db: ReturnType<typeof createAdminClient>,
  emailId: string,
  msg: ParsedMessage,
  att: ParsedAttachment,
  result: SyncResult,
) {
  const { data: row } = await db
    .from("email_attachments")
    .upsert(
      { email_message_id: emailId, part_id: att.partId, filename: att.filename, mime_type: att.mimeType, size_bytes: att.size },
      { onConflict: "email_message_id,part_id", ignoreDuplicates: true },
    )
    .select("id,status");
  const existing = row?.[0] ?? (await db.from("email_attachments").select("id,status").eq("email_message_id", emailId).eq("part_id", att.partId).single()).data;
  if (!existing || existing.status === "stored" || existing.status === "rejected") return;

  const fail = async (status: "failed" | "rejected", error: string) => {
    await db.from("email_attachments").update({ status, error }).eq("id", existing.id);
    if (status === "failed") result.pdfFailed++;
  };
  try {
    if (att.size > MAX_PDF_BYTES) return await fail("rejected", "File lebih dari 15 MB.");
    const buf = await getAttachment(token, msg.gmailMessageId, att.attachmentId);
    if (buf.length > MAX_PDF_BYTES) return await fail("rejected", "File lebih dari 15 MB.");
    if (!isPdfBytes(buf)) return await fail("rejected", "Isi file bukan PDF.");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const path = `gmail/${msg.gmailMessageId}/${att.partId}.pdf`;
    const up = await db.storage.from("invoices").upload(path, buf, { contentType: "application/pdf", upsert: true });
    if (up.error) throw up.error;
    const { error } = await db
      .from("email_attachments")
      .update({ status: "stored", storage_path: path, sha256, size_bytes: buf.length, error: null })
      .eq("id", existing.id);
    if (error) throw error;
    result.pdfStored++;
  } catch (e) {
    await fail("failed", short(e));
  }
}
