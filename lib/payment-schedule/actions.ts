"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Extraction } from "@/lib/extraction/schema";
import type { Suggestion } from "@/lib/extraction/validate";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { parseRowInput } from "./columns";
import { inputDateFromExtraction, prefillFromExtraction } from "./prefill";
import type { DbRow } from "./rows";

export type RowResult =
  | { ok: true; row: DbRow; existed?: boolean }
  | { ok: false; error: string; needCounterYear?: number; fieldErrors?: Record<string, string> };

/** Turns database errors into messages a person can act on. */
function friendly(err: { code?: string; message: string }): { error: string; needCounterYear?: number } {
  const m = err.message.match(/PAYMENT_COUNTER_NOT_SET:(\d{4})/);
  if (m) return { error: `Nomor terakhir tahun ${m[1]} belum diatur. Atur dulu di bagian Penomoran.`, needCounterYear: Number(m[1]) };
  if (err.code === "23503") return { error: "Nilai tidak ada di daftar Master Data. Pilih dari daftar." };
  if (err.code === "23505") return { error: "Data bentrok dengan baris lain (nomor atau ekstraksi yang sama)." };
  if (err.message.includes("Payment No tidak boleh diubah")) return { error: "Payment No tidak boleh diubah." };
  return { error: err.message };
}

/** Creates a row from the values typed in the "Add Data" row. At least one value is required. */
export async function createRow(values: Record<string, string>): Promise<RowResult> {
  const parsed = parseRowInput(values);
  if (!parsed.ok) return { ok: false, error: "Ada isian yang tidak valid.", fieldErrors: parsed.errors };
  if (!Object.values(parsed.values).some((v) => v !== null)) return { ok: false, error: "Isi minimal satu kolom." };
  const { data, error } = await (await createClient()).from("payment_schedule").insert(parsed.values).select("*").single();
  if (error) return { ok: false, ...friendly(error) };
  revalidatePath("/payment-schedule");
  return { ok: true, row: data as DbRow };
}

/** Creates the row for an extraction. Calling it twice returns the existing row instead of a second one. */
export async function createFromExtraction(extractionId: string): Promise<RowResult> {
  if (!z.uuid().safeParse(extractionId).success) return { ok: false, error: "ID tidak valid." };
  const db = await createClient();
  const { data: existing } = await db.from("payment_schedule").select("*").eq("extraction_id", extractionId).maybeSingle();
  if (existing) return { ok: true, row: existing as DbRow, existed: true };

  const { data: ex } = await db.from("document_extractions").select("id,status,result,validation,attachment_id,created_at,finished_at").eq("id", extractionId).maybeSingle();
  if (!ex || ex.status !== "succeeded" || !ex.result) return { ok: false, error: "Hasil ekstraksi tidak ditemukan." };
  const [vendors, { data: currencies }] = await Promise.all([
    fetchAll<{ name: string }>(db, "md_vendors", "name", { order: "name", activeOnly: true }),
    db.from("md_currencies").select("code").eq("active", true),
  ]);
  const prefill = prefillFromExtraction(
    ex.result as Extraction,
    ((ex.validation as { suggestion?: Suggestion | null } | null)?.suggestion ?? null),
    { vendors: vendors.map((v) => v.name), currencies: (currencies ?? []).map((c) => c.code) },
  );
  const { data, error } = await db
    .from("payment_schedule")
    // Input Date = the day the invoice was extracted. Setting it makes the database assign the Payment No right away.
    .insert({ ...prefill, input_date: inputDateFromExtraction(ex.finished_at ?? ex.created_at), extraction_id: ex.id, attachment_id: ex.attachment_id, ai_values: prefill })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") { // lost a race with another click: return the winner
      const { data: again } = await db.from("payment_schedule").select("*").eq("extraction_id", extractionId).maybeSingle();
      if (again) return { ok: true, row: again as DbRow, existed: true };
    }
    return { ok: false, ...friendly(error) };
  }
  revalidatePath("/payment-schedule");
  return { ok: true, row: data as DbRow };
}

/** Saves the changed fields of one row in a single update (one audit entry per field, written by the trigger). */
export async function updateRow(id: string, changes: Record<string, string>): Promise<RowResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "ID tidak valid." };
  const parsed = parseRowInput(changes);
  if (!parsed.ok) return { ok: false, error: "Ada isian yang tidak valid.", fieldErrors: parsed.errors };
  if (Object.keys(parsed.values).length === 0) return { ok: false, error: "Tidak ada perubahan." };
  const { data, error } = await (await createClient()).from("payment_schedule").update(parsed.values).eq("id", id).select("*").single();
  if (error) return { ok: false, ...friendly(error) };
  return { ok: true, row: data as DbRow };
}

export async function deleteDraftRow(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "ID tidak valid." };
  const { error, count } = await (await createClient()).from("payment_schedule").delete({ count: "exact" }).eq("id", id).is("seq", null);
  if (error) return { ok: false, error: error.message };
  if (!count) return { ok: false, error: "Baris yang sudah bernomor tidak bisa dihapus." };
  revalidatePath("/payment-schedule");
  return { ok: true };
}

/** Sets or raises the last used Payment No of a year (never lowers: a number could be issued twice). */
export async function setCounter(year: number, last: number): Promise<{ ok: boolean; error?: string }> {
  const p = z.object({ year: z.number().int().min(2020).max(2100), last: z.number().int().min(0).max(99998) }).safeParse({ year, last });
  if (!p.success) return { ok: false, error: "Tahun atau nomor tidak valid." };
  const { error } = await (await createClient()).rpc("set_payment_counter", { p_year: p.data.year, p_last: p.data.last });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/payment-schedule");
  return { ok: true };
}
