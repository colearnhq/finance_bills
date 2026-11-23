// One-off seed of dropdown lists from the team's dropdown-list-values.csv (entity ID only).
// Usage:
//   node scripts/seed-master-data.mjs <path-to-csv> --dry-run     # parse and count only
//   node --env-file=.env.local scripts/seed-master-data.mjs <path-to-csv>   # write to Supabase
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only, never in the browser).
// Idempotent: upserts on the unique key and never deactivates or deletes existing rows.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const [path, flag] = process.argv.slice(2);
if (!path) {
  console.error("Usage: node scripts/seed-master-data.mjs <csv> [--dry-run]");
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const rows = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
const header = rows[0].map((h) => h.trim());
const idx = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Column not found: ${name}`);
  return i;
};
const col = (name) => rows.slice(1).map((r) => (r[idx(name)] ?? "").trim());
const uniq = (a) => [...new Set(a.filter(Boolean))];

const div = col("Division"), dep = col("Department");
const acc = col("Accounting Account#_ID"), accName = col("Accounting Account Name_ID");
const plan = [
  { table: "md_vendors", conflict: "name", data: uniq(col("Vendor Name")).map((name) => ({ name })) },
  { table: "md_cashflow_categories", conflict: "name", data: uniq(col("Cashflow Category")).map((name) => ({ name })) },
  { table: "md_tax_categories", conflict: "name", data: uniq(col("Tax Category_ID")).map((name) => ({ name })) },
  { table: "md_divisions", conflict: "division", data: div.map((division, i) => ({ division, department: dep[i] })).filter((r) => r.division && r.department) },
  { table: "md_accounts", conflict: "code", data: acc.map((code, i) => ({ code, name: accName[i] })).filter((r) => r.code && r.name) },
];

for (const p of plan) console.log(`${p.table}: ${p.data.length} rows`);
if (flag === "--dry-run") process.exit(0);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

for (const p of plan) {
  for (let i = 0; i < p.data.length; i += 500) {
    const { error } = await supabase.from(p.table).upsert(p.data.slice(i, i + 500), { onConflict: p.conflict, ignoreDuplicates: true });
    if (error) { console.error(`${p.table}: ${error.message}`); process.exit(1); }
  }
  console.log(`${p.table}: seeded`);
}
