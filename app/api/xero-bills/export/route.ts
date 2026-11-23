import { NextResponse } from "next/server";
import { z } from "zod";
import { billsToCsv } from "@/lib/xero/csv";
import { loadBills } from "@/lib/xero/load";
import { createClient } from "@/lib/supabase/server";

const body = z.object({ ids: z.array(z.uuid()).min(1).max(500) });

/**
 * CSV of the selected bills in Xero's import layout. Exporting LOCKS the bills (status exported): what was sent stays on
 * record. Downloading an already exported bill again is allowed and only raises its export_count.
 */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new NextResponse("Permintaan tidak valid", { status: 400 });
  const db = await createClient();
  const { data: claims } = await db.auth.getClaims();
  const uid = (claims?.claims?.sub as string | undefined) ?? null;

  let bills;
  try { bills = await loadBills(db, parsed.data.ids); } catch { return new NextResponse("Gagal memuat bill", { status: 500 }); }
  if (bills.length !== new Set(parsed.data.ids).size) return new NextResponse("Sebagian bill tidak ditemukan", { status: 404 });

  const now = new Date().toISOString();
  for (const b of bills) {
    const patch = b.status === "prepared"
      ? { status: "exported", exported_at: now, exported_by: uid, sent_via: "csv", export_count: b.export_count + 1 }
      : { export_count: b.export_count + 1 };
    const { error } = await db.from("xero_bills").update(patch).eq("id", b.id);
    if (error) return new NextResponse(`Gagal menandai bill ${b.reference_no}: ${error.message}`, { status: 500 });
    if (b.status === "prepared") await db.from("payment_schedule").update({ xero_import_status: "EXPORTED" }).eq("id", b.payment_schedule_id);
  }

  const csv = billsToCsv(bills.map((b) => ({ header: b, lines: b.xero_bill_lines })));
  const stamp = now.slice(0, 16).replace(/[-:T]/g, "");
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="xero-bills-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
