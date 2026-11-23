"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { buildQuery, type Rule } from "./filters-core";
import { DEFAULT_QUERY } from "./parse";
import { syncInbox, type SyncResult } from "./sync";

export type SyncState = SyncResult | null;

export async function syncAction(_prev: SyncState, form: FormData): Promise<SyncState> {
  const { data } = await (await createClient()).auth.getUser();
  if (!data.user) return { ok: false, error: "Sesi habis, silakan login ulang.", found: 0, newEmails: 0, pdfStored: 0, pdfFailed: 0, remaining: 0 };
  const q = z.string().trim().max(500).safeParse(form.get("q") ?? "");
  // Active exclusion rules are added to the Gmail query, so excluded emails are never fetched.
  const db = await createClient();
  const { data: rules } = await db.from("email_exclusion_rules").select("kind,pattern").eq("active", true);
  const query = buildQuery(q.success && q.data ? q.data : DEFAULT_QUERY, (rules ?? []) as Rule[]);
  const result = await syncInbox(query, data.user.id);
  revalidatePath("/inbox");
  return result;
}

export async function setReviewStatus(id: string, status: "new" | "not_invoice") {
  if (!z.uuid().safeParse(id).success) return;
  await (await createClient()).from("email_messages").update({ review_status: status }).eq("id", id);
  revalidatePath("/inbox");
}
