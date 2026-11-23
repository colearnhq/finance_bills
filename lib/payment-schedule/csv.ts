import { D, type Num } from "./calc";
import { COLUMNS } from "./columns";
import type { Computed, DbRow } from "./rows";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-19" -> "19 Oct 26", the format used in the sheet. */
export function sheetDate(iso: string | null): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1].slice(2)}` : "";
}

/** Quotes a cell. Text that a spreadsheet could run as a formula gets a leading apostrophe. */
export function csvCell(v: string, isText: boolean): string {
  let s = v;
  if (isText && /^[=+@\t\r]/.test(s)) s = `'${s}`;
  if (isText && /^-(?!\d)/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (n: Num | null) => (n ? n.toFixed(2) : "");
const plain = (v: unknown): string => (v === null || v === undefined ? "" : D(v as string | number).toString());

export interface ExportLookups {
  accountNames: Map<string, string>; // code -> name
}

/** CSV in the template's column order and header, with computed columns filled in. */
export function toCsv(rows: DbRow[], computed: Map<string, Computed>, lk: ExportLookups): string {
  const lines = [COLUMNS.map((c) => csvCell(c.label, false)).join(",")];
  const sorted = [...rows].sort((a, b) => (a.seq === null ? 1 : 0) - (b.seq === null ? 1 : 0) || (a.fiscal_year ?? 0) - (b.fiscal_year ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  for (const r of sorted) {
    const c = computed.get(r.id)!;
    const cells = COLUMNS.map((col) => {
      if (col.kind === "computed") {
        switch (col.key) {
          case "no": return csvCell(c.no === null ? "" : String(c.no), false);
          case "payment_no": return csvCell(c.payment_no ?? "", false);
          case "xero_ref": return csvCell(c.xero_ref ?? "", true);
          case "department": return csvCell(c.department ?? "", true);
          case "xero_import": return csvCell(r.xero_import_status ?? "", true);
          case "rate_idr": case "rate_usd": { const n = c[col.key as "rate_idr"]; return n ? n.toString() : ""; }
          default: return money(c[col.key as keyof Computed] as Num | null);
        }
      }
      const v = r[col.key];
      if (v === null || v === undefined || v === "") return "";
      if (col.type === "date") return sheetDate(String(v));
      if (col.type === "money") return plain(v);
      if (col.key === "accounting_account") return csvCell(lk.accountNames.get(String(v)) ?? String(v), true);
      return csvCell(String(v), true);
    });
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
