import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Authorised preview: checks the user can see the row (RLS), then redirects to a 60-second signed URL. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new NextResponse("Not found", { status: 404 });
  const { data: att } = await (await createClient()).from("email_attachments").select("storage_path,status").eq("id", id).maybeSingle();
  if (!att || att.status !== "stored" || !att.storage_path) return new NextResponse("Not found", { status: 404 });
  const { data } = await createAdminClient().storage.from("invoices").createSignedUrl(att.storage_path, 60);
  if (!data) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
