/** Column definitions of the Payment Schedule, in the template's order. Shared by the grid, server validation and CSV export. */

export type ColType = "text" | "date" | "money" | "yn" | "list";
/** Master lists an editable cell can pick from. */
export type ListKey = "vendors" | "paymentTypes" | "cashflow" | "accounts" | "divisions" | "taxCategories" | "currencies";

export interface InputCol {
  kind: "input";
  key: string; // DB column
  label: string;
  type: ColType;
  list?: ListKey;
  wide?: boolean;
}
export interface ComputedCol {
  kind: "computed";
  key: string;
  label: string;
  num?: boolean;
}
export type Col = InputCol | ComputedCol;

const i = (key: string, label: string, type: ColType, extra: Partial<InputCol> = {}): InputCol => ({ kind: "input", key, label, type, ...extra });
const c = (key: string, label: string, num = true): ComputedCol => ({ kind: "computed", key, label, num });

export const COLUMNS: Col[] = [
  c("no", "No.", false),
  c("payment_no", "Payment No", false),
  c("xero_ref", "Xero Reference No", false),
  i("input_date", "Input Date", "date"),
  i("payment_status", "Payment Status", "text"),
  i("vendor_name", "Vendor Name", "list", { list: "vendors", wide: true }),
  i("po_no", "Purchase Order No.", "text"),
  i("invoice_no", "Invoice No", "text", { wide: true }),
  i("invoice_date", "Invoice Date", "date"),
  i("due_date", "Due Date", "date"),
  i("description", "Description", "text", { wide: true }),
  i("period_from", "Expense period from", "date"),
  i("period_to", "Expense period to", "date"),
  i("payment_type", "Payment Type", "list", { list: "paymentTypes" }),
  i("cashflow_category", "Cashflow Category", "list", { list: "cashflow", wide: true }),
  i("accounting_account", "Accounting Account", "list", { list: "accounts", wide: true }),
  i("division", "Division", "list", { list: "divisions" }),
  c("department", "Department", false),
  i("tax_category", "Tax Category", "list", { list: "taxCategories" }),
  i("currency", "Currency", "list", { list: "currencies" }),
  i("invoice_amount", "Invoice Amount", "money"),
  i("dpp", "DPP", "money"),
  c("ppn", "PPN"),
  c("pph23", "PPh 23"),
  c("pph21", "PPh 21"),
  c("pph42", "PPh 4 ayat 2"),
  c("umkm", "PPh Final UMKM"),
  c("pph26", "PPh 26"),
  i("other_adjustment", "Other Addition/Deduction", "money"),
  c("amount_og", "Amount to Transfer (OG)"),
  c("acc_payment", "Accumulated Payment"),
  c("acc_tax", "Accumulated Payment (Tax)"),
  c("rate_idr", "Rate to IDR"),
  c("amount_idr", "Amount to Transfer (IDR)"),
  c("rate_usd", "Rate to USD"),
  c("amount_usd", "Amount to Transfer (USD)"),
  c("xero_import", "Import to Xero", false),
  i("tax_note", "Tax Note", "text"),
  i("finance_note", "Finance Note", "text"),
  i("proposed_date", "Proposed Date", "date"),
  i("paid_from", "Paid From", "text"),
  i("npwp_flag", "NPWP?Y/N", "yn"),
  i("npwp_no", "NPWP/KTP", "text"),
  i("bank_name", "Bank Name", "text"),
  i("beneficiary_name", "Beneficiary Name", "text"),
  i("bank_account_no", "Bank Account Number", "text"),
  i("swift_code", "Swift Code", "text"),
  i("ifsc_code", "IFSC Code", "text"),
  i("vendor_email", "Vendor Email", "text", { wide: true }),
  i("pic_email", "PIC Email", "text"),
];

export const INPUT_COLS = COLUMNS.filter((x): x is InputCol => x.kind === "input");
export const INPUT_KEYS = INPUT_COLS.map((x) => x.key);
export const inputCol = (key: string) => INPUT_COLS.find((x) => x.key === key);

/** Parses what a person typed into the value stored in the database. Returns an error message when invalid. */
export function parseInput(type: ColType, raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  switch (type) {
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { ok: false, error: "Tanggal harus berformat YYYY-MM-DD." };
      const d = new Date(`${t}T00:00:00Z`);
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? { ok: false, error: "Tanggal tidak valid." } : { ok: true, value: t };
    }
    case "money": {
      const n = t.replace(/,/g, "");
      if (!/^-?\d{1,16}(\.\d{1,4})?$/.test(n)) return { ok: false, error: "Nominal harus angka (maks. 4 desimal), tanpa simbol." };
      return { ok: true, value: n };
    }
    case "yn": {
      const u = t.toUpperCase();
      return u === "Y" || u === "N" ? { ok: true, value: u } : { ok: false, error: "Isi Y atau N." };
    }
    default:
      return t.length > 500 ? { ok: false, error: "Terlalu panjang (maks. 500 karakter)." } : { ok: true, value: t };
  }
}

/** Validates several typed values at once (one row save). Collects every error so the UI can mark each cell. */
export function parseRowInput(
  values: Record<string, string>,
): { ok: true; values: Record<string, string | null> } | { ok: false; errors: Record<string, string> } {
  const out: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const col = inputCol(key);
    if (!col) { errors[key] = "Kolom tidak dikenal."; continue; }
    const p = parseInput(col.type, typeof raw === "string" ? raw : "");
    if (!p.ok) { errors[key] = p.error; continue; }
    // the accumulation rule matches "PAID" exactly
    out[key] = key === "payment_status" && p.value ? p.value.toUpperCase() : p.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values: out };
}
