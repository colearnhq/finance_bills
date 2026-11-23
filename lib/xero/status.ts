import type { SyncRow } from "./sync";

export type Tone = "neutral" | "ok" | "warn" | "bad";
export interface SyncView { label: string; detail: string | null; tone: Tone; canSend: boolean; sendLabel: string; canUnlock: boolean }

export const STALE_CLAIM_MS = 5 * 60 * 1000; // same as claim_xero_sync's default

/** What to show (and allow) for a bill, from its sync record. `null` = never sent. */
export function describeSync(s: SyncRow | null, now: number = Date.now()): SyncView {
  if (!s) return { label: "Belum dikirim", detail: null, tone: "neutral", canSend: true, sendLabel: "Kirim ke Xero", canUnlock: false };
  const running = s.in_progress && s.claimed_at !== null && now - new Date(s.claimed_at).getTime() < STALE_CLAIM_MS;
  if (running) return { label: "Sedang dikirim…", detail: null, tone: "warn", canSend: false, sendLabel: "Kirim ke Xero", canUnlock: false };
  const err = s.last_error;
  if (s.invoice_state === "created") {
    if (s.attachment_state === "done" || s.attachment_state === "none") {
      return { label: s.attachment_state === "none" ? "Draft di Xero (tanpa PDF)" : "Draft di Xero + PDF", detail: s.warning, tone: s.warning ? "warn" : "ok", canSend: false, sendLabel: "Kirim ke Xero", canUnlock: false };
    }
    return { label: "Bill dibuat, PDF belum terunggah", detail: err ?? s.warning, tone: "warn", canSend: true, sendLabel: "Coba unggah PDF lagi", canUnlock: false };
  }
  if (s.invoice_state === "rejected") return { label: "Ditolak Xero", detail: err, tone: "bad", canSend: true, sendLabel: "Kirim ulang", canUnlock: true };
  return { label: "Hasil belum pasti", detail: err ?? "Pengiriman terhenti sebelum ada kepastian.", tone: "warn", canSend: true, sendLabel: "Periksa & kirim ulang", canUnlock: false };
}
