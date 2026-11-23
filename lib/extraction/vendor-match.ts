/** Suggests entries of the vendor master list for a name read from an invoice. Suggestions only: a person picks. */

const LEGAL = new Set(["pt", "cv", "tbk", "ud", "ltd", "inc", "llc", "pte", "co", "corp", "corporation", "limited", "gmbh", "bv"]);

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t))
    .join(" ");
}

const bigrams = (s: string) => {
  const c = s.replace(/\s+/g, " ");
  const out = new Map<string, number>();
  for (let i = 0; i < c.length - 1; i++) out.set(c.slice(i, i + 2), (out.get(c.slice(i, i + 2)) ?? 0) + 1);
  return out;
};

function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / (A.size + B.size - inter || 1);
}

export interface VendorMatch {
  exact: string | null;
  suggestions: { name: string; score: number }[];
}

export function matchVendor(name: string | null, vendors: string[], limit = 3, threshold = 0.5): VendorMatch {
  const n = name ? normalizeName(name) : "";
  if (!n) return { exact: null, suggestions: [] };
  let exact: string | null = null;
  const scored: { name: string; score: number }[] = [];
  for (const v of vendors) {
    const nv = normalizeName(v);
    if (!nv) continue;
    if (nv === n) { exact ??= v; continue; }
    // Token overlap handles reordered names; bigram overlap handles typos and abbreviations.
    const score = Math.max(jaccard(n, nv), dice(n, nv));
    if (score >= threshold) scored.push({ name: v, score: Math.round(score * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { exact, suggestions: scored.slice(0, limit) };
}
