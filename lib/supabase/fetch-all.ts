import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reads every row of a table page by page. PostgREST caps one response at 1,000 rows no matter what `.limit()` says,
 * so a plain `.limit(5000)` silently returns a truncated list (the vendor list has 2,342 rows).
 */
export async function fetchAll<T = Record<string, unknown>>(
  db: SupabaseClient,
  table: string,
  columns: string,
  opts: { order: string; activeOnly?: boolean; where?: (q: any) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(columns).order(opts.order).range(from, from + PAGE - 1);
    if (opts.activeOnly) q = q.eq("active", true);
    if (opts.where) q = opts.where(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
