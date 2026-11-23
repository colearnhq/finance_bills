/** Pure parsing and screening of Gmail API messages (format=full). No I/O. */

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export type Classification = "pdf" | "link" | "link_unsure" | "none";
export interface ParsedAttachment {
  partId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  isPdf: boolean;
}
export interface ParsedMessage {
  gmailMessageId: string;
  threadId: string | null;
  from: string;
  subject: string;
  receivedAt: string | null;
  attachments: ParsedAttachment[];
  links: { host: string; path: string }[];
  classification: Classification;
}

/** Default search, same heuristic as the spike. Gmail matches whole words, not substrings. */
export const DEFAULT_QUERY =
  'subject:(INV OR INVOICE OR TAGIHAN OR "FAKTUR") OR (INVOICE has:attachment filename:pdf) newer_than:30d';

const decode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function walk(part: GmailPart | undefined, atts: ParsedAttachment[], texts: string[]) {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    const mime = part.mimeType ?? "application/octet-stream";
    atts.push({
      partId: part.partId ?? String(atts.length),
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: mime,
      size: part.body.size ?? 0,
      isPdf: /pdf/i.test(mime) || /\.pdf$/i.test(part.filename),
    });
  } else if (part.body?.data && (part.mimeType === "text/plain" || part.mimeType === "text/html")) {
    texts.push(decode(part.body.data));
  }
  part.parts?.forEach((p) => walk(p, atts, texts));
}

const NOISE = /(unsubscribe|w3\.org|googleusercontent|fonts\.g|facebook|twitter|linkedin|instagram|youtube|\.(png|jpg|gif)$)/i;
const INVOICE_HINT = /inv|bill|billing|payment|faktur|tagihan|receipt|download/i;

/** Host + path only. Query strings often carry signed secrets, so they are dropped. */
export function extractLinks(texts: string[]): { host: string; path: string }[] {
  const found = new Map<string, { host: string; path: string }>();
  for (const text of texts) {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
      try {
        const u = new URL(m[0].replace(/[.,;]+$/, ""));
        const key = u.host + u.pathname;
        if (!found.has(key)) found.set(key, { host: u.host, path: u.pathname });
      } catch {
        /* ignore malformed URLs */
      }
    }
  }
  return [...found.values()].filter((l) => !NOISE.test(l.host + l.path));
}

export function parseMessage(m: GmailMessage): ParsedMessage {
  const headers = Object.fromEntries((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  const attachments: ParsedAttachment[] = [];
  const texts: string[] = [];
  walk(m.payload, attachments, texts);
  const links = extractLinks(texts);
  const invoiceLinks = links.filter((l) => INVOICE_HINT.test(l.host + l.path));

  let classification: Classification = "none";
  if (attachments.some((a) => a.isPdf)) classification = "pdf";
  else if (invoiceLinks.length) classification = "link";
  else if (links.length) classification = "link_unsure";

  const ms = Number(m.internalDate);
  return {
    gmailMessageId: m.id,
    threadId: m.threadId ?? null,
    from: headers.from ?? "",
    subject: headers.subject ?? "(tanpa subjek)",
    receivedAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
    attachments,
    links: (invoiceLinks.length ? invoiceLinks : links).slice(0, 5),
    classification,
  };
}

/** True when the bytes really are a PDF (magic header), whatever the sender claimed. */
export const isPdfBytes = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

const MAX_BODY_CHARS = 6000;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Readable text of an email: text/plain if present, else HTML with tags stripped. Truncated to keep requests small. */
export function extractBodyText(m: GmailMessage): string {
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (p?: GmailPart) => {
    if (!p) return;
    if (!p.filename && p.body?.data) {
      if (p.mimeType === "text/plain") plain.push(decode(p.body.data));
      else if (p.mimeType === "text/html") html.push(decode(p.body.data));
    }
    p.parts?.forEach(visit);
  };
  visit(m.payload);
  const text = plain.length
    ? plain.join("\n")
    : html
        .join("\n")
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<(br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (e) => ENTITIES[e] ?? e);
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}
