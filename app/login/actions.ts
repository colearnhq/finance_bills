"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function login(_prev: { error?: string }, form: FormData): Promise<{ error?: string }> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Email dan password wajib diisi." };
  const { error } = await (await createClient()).auth.signInWithPassword({ email, password });
  if (error) return { error: "Email atau password salah." };
  redirect("/");
}

export async function logout() {
  await (await createClient()).auth.signOut();
  redirect("/login");
}
