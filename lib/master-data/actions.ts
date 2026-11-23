"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getList } from "./lists";

export type ActionState = { error?: string; ok?: boolean };

/** Builds a validator from the list definition so only declared fields are ever written. */
function parseFields(slug: string, form: FormData) {
  const list = getList(slug);
  if (!list) return { error: "Daftar tidak dikenal." } as const;
  const shape: Record<string, z.ZodType> = {};
  for (const f of list.fields) {
    let s = z.string().trim().min(1, `${f.label} wajib diisi.`).max(300);
    if (list.table === "md_currencies") s = s.toUpperCase().regex(/^[A-Z]{3}$/, "Kode harus 3 huruf.");
    shape[f.key] = s;
  }
  const parsed = z.object(shape).safeParse(Object.fromEntries(list.fields.map((f) => [f.key, form.get(f.key) ?? ""])));
  if (!parsed.success) return { error: parsed.error.issues[0].message } as const;
  return { list, values: parsed.data as Record<string, string> } as const;
}

function friendly(err: { code?: string; message: string }) {
  if (err.code === "23505") return "Nilai tersebut sudah ada.";
  return err.message;
}

export async function addItem(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const p = parseFields(slug, form);
  if ("error" in p) return { error: p.error };
  const { error } = await (await createClient()).from(p.list.table).insert(p.values);
  if (error) return { error: friendly(error) };
  revalidatePath(`/master-data/${slug}`);
  return { ok: true };
}

export async function updateItem(slug: string, id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const p = parseFields(slug, form);
  if ("error" in p) return { error: p.error };
  const { error } = await (await createClient()).from(p.list.table).update(p.values).eq("id", id);
  if (error) return { error: friendly(error) };
  revalidatePath(`/master-data/${slug}`);
  return { ok: true };
}

export async function setActive(slug: string, id: string, active: boolean) {
  const list = getList(slug);
  if (!list || !z.uuid().safeParse(id).success) return;
  await (await createClient()).from(list.table).update({ active }).eq("id", id);
  revalidatePath(`/master-data/${slug}`);
}
