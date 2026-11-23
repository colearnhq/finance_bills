import type { DateField, Extraction, Field } from "@/lib/extraction/schema";
import type { Suggestion } from "@/lib/extraction/validate";
import { isRealIsoDate } from "@/lib/extraction/validate";
import { matchVendor } from "@/lib/extraction/vendor-match";
import { parseInput } from "./columns";

export type Prefill = Record<string, string | null>;

const text = (f: Field): string | null => (f.value && f.value.trim() ? f.value.trim().slice(0, 500) : null);
const date = (f: DateField): string | null => (isRealIsoDate(f.iso) ? f.iso : null);
const money = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const p = parseInput("money", v);
  return p.ok ? p.value : null;
};

/**
 * Values proposed for a new Payment Schedule row from an extraction. Only what is safe to propose:
 * - vendor only when the name matches the master list exactly (otherwise left empty for a person to pick);
 * - currency only when it is in the Currency list;
 * - Invoice Amount / DPP only from the rule-based suggestion;
 * - accounts, division, tax category, status etc. are always left for the accountant.
 * Input Date is NOT here: it is set from the extraction time by `inputDateFromExtraction` (see createFromExtraction).
 */
export function prefillFromExtraction(x: Extraction, suggestion: Suggestion | null, lists: { vendors: string[]; currencies: string[] }): Prefill {
  const cur = x.currency.value?.toUpperCase() ?? null;
  return {
    vendor_name: matchVendor(x.vendor_name.value, lists.vendors).exact,
    invoice_no: text(x.invoice_no),
    po_no: text(x.po_no),
    invoice_date: date(x.invoice_date),
    due_date: date(x.due_date),
    description: text(x.description),
    period_from: date(x.period_from),
    period_to: date(x.period_to),
    currency: cur && lists.currencies.includes(cur) ? cur : null,
    invoice_amount: money(suggestion?.invoiceAmount),
    dpp: money(suggestion?.dpp),
    npwp_no: text(x.vendor_tax_id),
    bank_name: text(x.bank_name),
    beneficiary_name: text(x.beneficiary_name),
    bank_account_no: text(x.account_number),
    swift_code: text(x.swift_code),
    ifsc_code: text(x.ifsc_code),
    vendor_email: text(x.vendor_email),
  };
}

/** The company works in Jakarta time: the Input Date is the calendar day (Asia/Jakarta) the email's invoice was extracted. */
export function inputDateFromExtraction(extractedAt: string | Date): string | null {
  const d = new Date(extractedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
