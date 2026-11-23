import "server-only";
import type { GmailMessage } from "./parse";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Error without response bodies: Gmail error payloads can echo message data. */
export class GmailError extends Error {
  constructor(public status: number, what: string) {
    super(`Gmail API ${what} gagal (HTTP ${status})`);
  }
}

async function call(token: string, path: string, attempt = 0): Promise<Response> {
  const res = await fetch(`${BASE}/${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return call(token, path, attempt + 1);
  }
  return res;
}

export async function getProfileEmail(token: string): Promise<string> {
  const res = await call(token, "profile");
  if (!res.ok) throw new GmailError(res.status, "profile");
  return (await res.json()).emailAddress as string;
}

export async function listMessageIds(token: string, q: string, max = 50): Promise<string[]> {
  const res = await call(token, `messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new GmailError(res.status, "pencarian");
  const j = await res.json();
  return ((j.messages ?? []) as { id: string }[]).map((m) => m.id);
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  const res = await call(token, `messages/${encodeURIComponent(id)}?format=full`);
  if (!res.ok) throw new GmailError(res.status, "membaca email");
  return res.json();
}

export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const res = await call(token, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  if (!res.ok) throw new GmailError(res.status, "mengunduh lampiran");
  const j = await res.json();
  return Buffer.from((j.data as string).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
