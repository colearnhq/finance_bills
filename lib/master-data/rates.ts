"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "./actions";

const num = (label: string) =>
  z
    .string()
    .trim()
    .transform((s) => s.replace(/,/g, ""))
    .refine((s) => s === "" || (/^\d+(\.\d+)?$/.test(s) && Number(s) > 0), `${label} harus angka positif.`)
    .transform((s) => (s === "" ? null : s));

const schema = z.object({
  rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal wajib diisi."),
  week: z.string().trim().max(50).transform((s) => s || null),
  usd_idr: num("USD→IDR"),
  sgd_usd: num("SGD→USD"),
  usd_inr: num("USD→INR"),
  usd_aed: num("USD→AED"),
  usd_eur: num("USD→EUR"),
});

/** Insert or overwrite the rate row of a date. */
export async function saveRate(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = schema.safeParse(Object.fromEntries(Object.keys(schema.shape).map((k) => [k, form.get(k) ?? ""])));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { error } = await (await createClient()).from("fx_rates").upsert(parsed.data, { onConflict: "rate_date" });
  if (error) return { error: error.message };
  revalidatePath("/rates");
  return { ok: true };
}
