"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { matchesRule, sanitizePattern, type Rule } from "./filters-core";

export type FilterState = { error?: string; ok?: boolean; message?: string };

const schema = z.object({
  kind: z.enum(["subject", "sender"]),
  pattern: z.string().transform(sanitizePattern).pipe(z.string().min(3, "Pola minimal 3 karakter (setelah karakter khusus dibuang).")),
  note: z.string().trim().max(200).transform((s) => s || null),
});

export async function addRule(_prev: FilterState, form: FormData): Promise<FilterState> {
  const p = schema.safeParse({ kind: form.get("kind"), pattern: form.get("pattern") ?? "", note: form.get("note") ?? "" });
  if (!p.success) return { error: p.error.issues[0].message };
  const { error } = await (await createClient()).from("email_exclusion_rules").insert(p.data);
  if (error) return { error: error.code === "23505" ? "Aturan itu sudah ada." : error.message };
  revalidatePath("/inbox/filters");
  return { ok: true };
}

export async function toggleRule(id: string, active: boolean) {
  if (!z.uuid().safeParse(id).success) return;
  await (await createClient()).from("email_exclusion_rules").update({ active }).eq("id", id);
  revalidatePath("/inbox/filters");
}

export async function deleteRule(id: string) {
  if (!z.uuid().safeParse(id).success) return;
  await (await createClient()).from("email_exclusion_rules").delete().eq("id", id);
  revalidatePath("/inbox/filters");
}

/** Marks already-synced emails that match an active rule as "not an invoice" (reversible from the Inbox). */
export async function hideMatching(): Promise<FilterState> {
  const db = await createClient();
  const { data: rules, error: e1 } = await db.from("email_exclusion_rules").select("kind,pattern").eq("active", true);
  if (e1) return { error: e1.message };
  if (!rules?.length) return { error: "Belum ada aturan aktif." };
  let emails: { id: string; subject: string; from_address: string }[];
  try {
    emails = await fetchAll(db, "email_messages", "id,subject,from_address", { order: "id", where: (q) => q.eq("review_status", "new") });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Gagal memuat email." };
  }
  const ids = emails
    .filter((m) => rules.some((r) => matchesRule(r as { kind: "subject" | "sender"; pattern: string }, { subject: m.subject, from: m.from_address })))
    .map((m) => m.id);
  if (ids.length) {
    const { error } = await db.from("email_messages").update({ review_status: "not_invoice" }).in("id", ids);
    if (error) return { error: error.message };
  }
  revalidatePath("/inbox");
  return { ok: true, message: `${ids.length} email di Inbox disembunyikan.` };
}

const ruleInput = z.object({ kind: z.enum(["subject", "sender"]), pattern: schema.shape.pattern });

type EmailRow = { id: string; subject: string; from_address: string; email_attachments: { status: string }[] };

/** Emails still in the Inbox ("new") that a rule would hide, excluding the one being marked. */
async function findMatches(rule: Rule, exceptId: string) {
  const data = await fetchAll<EmailRow>(await createClient(), "email_messages", "id,subject,from_address,email_attachments(status)", {
    order: "id",
    where: (q) => q.eq("review_status", "new").neq("id", exceptId),
  });
  return data.filter((m) => matchesRule(rule, { subject: m.subject, from: m.from_address }));
}

export type RulePreview = { error?: string; total: number; withPdf: number; samples: string[] };

/** What would happen if this rule existed: how many other Inbox emails match, and how many of them have a stored PDF. */
export async function previewRule(emailId: string, kind: string, pattern: string): Promise<RulePreview> {
  const p = ruleInput.safeParse({ kind, pattern });
  if (!p.success || !z.uuid().safeParse(emailId).success) return { error: "Pola tidak valid (minimal 3 karakter).", total: 0, withPdf: 0, samples: [] };
  const m = await findMatches(p.data, emailId);
  return {
    total: m.length,
    withPdf: m.filter((x) => x.email_attachments.some((a) => a.status === "stored")).length,
    samples: m.slice(0, 4).map((x) => x.subject),
  };
}

/**
 * Marks one email "not an invoice" and, optionally, saves a rule from it. Matches are recomputed here on the
 * server (the client preview is not trusted). Hiding other emails is reversible from the Inbox.
 */
export async function markNotInvoice(
  emailId: string,
  rule: { kind: string; pattern: string; note: string } | null,
  hideOthers: boolean,
): Promise<FilterState> {
  if (!z.uuid().safeParse(emailId).success) return { error: "Email tidak valid." };
  const db = await createClient();
  let hidden = 0;
  if (rule) {
    const p = schema.safeParse({ kind: rule.kind, pattern: rule.pattern, note: rule.note });
    if (!p.success) return { error: p.error.issues[0].message };
    const { error } = await db.from("email_exclusion_rules").insert(p.data);
    if (error && error.code !== "23505") return { error: error.message }; // already exists: fine
    if (hideOthers) {
      const ids = (await findMatches(p.data, emailId)).map((m) => m.id);
      if (ids.length) {
        const { error: e2 } = await db.from("email_messages").update({ review_status: "not_invoice" }).in("id", ids);
        if (e2) return { error: e2.message };
        hidden = ids.length;
      }
    }
  }
  const { error } = await db.from("email_messages").update({ review_status: "not_invoice" }).eq("id", emailId);
  if (error) return { error: error.message };
  revalidatePath("/inbox");
  revalidatePath("/inbox/filters");
  return { ok: true, message: rule ? `Aturan disimpan. ${hidden} email lain disembunyikan.` : "Email ditandai bukan invoice." };
}
