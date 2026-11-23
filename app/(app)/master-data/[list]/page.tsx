import { notFound } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getList } from "@/lib/master-data/lists";
import { ListEditor } from "./list-editor";

export default async function MasterDataPage({ params, searchParams }: PageProps<"/master-data/[list]">) {
  await connection(); // per-request data: opt out of prerendering before anything time-dependent runs
  const { list: slug } = await params;
  const list = getList(slug);
  if (!list) notFound();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const showInactive = sp.inactive === "1";

  let query = (await createClient()).from(list.table).select("*").order(list.orderBy).limit(500);
  if (!showInactive) query = query.eq("active", true);
  if (q) query = query.ilike(list.fields[0].key, `%${q.replace(/[%,]/g, "")}%`);
  const { data, error } = await query;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl">{list.title}</h1>
        <p className="muted text-sm">{list.description}</p>
      </div>
      <form className="flex items-center gap-3 text-sm">
        <input name="q" defaultValue={q} placeholder="Cari…" className="input" />
        <label className="flex items-center gap-1.5 text-subtle">
          <input type="checkbox" name="inactive" value="1" defaultChecked={showInactive} /> tampilkan nonaktif
        </label>
        <button className="btn">Terapkan</button>
      </form>
      {error ? (
        <p className="alert-error">Gagal memuat data: {error.message}</p>
      ) : (
        <ListEditor
          slug={list.slug}
          fields={list.fields}
          rows={(data ?? []) as ({ id: string; active: boolean } & Record<string, string>)[]}
          truncated={(data?.length ?? 0) >= 500}
        />
      )}
    </div>
  );
}
