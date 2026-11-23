"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { runExtractions, type RunResult } from "./run";

export type ExtractState = RunResult | null;

export async function extractAction(attachmentIds: string[], redo: boolean): Promise<RunResult> {
  const empty = { succeeded: 0, failed: 0, skipped: 0, notes: [] as string[] };
  const { data } = await (await createClient()).auth.getUser();
  if (!data.user) return { ...empty, ok: false, error: "Sesi habis, silakan login ulang." };
  const ids = z.array(z.uuid()).max(50).safeParse(attachmentIds);
  if (!ids.success) return { ...empty, ok: false, error: "Pilihan tidak valid." };
  const result = await runExtractions(ids.data, data.user.id, redo);
  revalidatePath("/inbox");
  revalidatePath("/extractions");
  return result;
}
