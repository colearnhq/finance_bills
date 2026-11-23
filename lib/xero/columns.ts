import { D } from "@/lib/payment-schedule/calc";
import type { BillHeader, BillLine } from "./bill";
import { xeroDate } from "./csv";

export type Rec = { header: Omit<BillHeader, "payment_schedule_id"> & { payment_schedule_id?: string }; line: BillLine };
export type Col = { label: string; w: number; get: (r: Rec) => string; right?: boolean; wrap?: boolean };

/**
 * "6049500.000000" or the number 6049500 -> "6,049,500". PostgREST returns numeric columns as JSON numbers while the
 * types say string, so this accepts both (a number must never reach string methods).
 */
export const money = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined || v === "") return "";
  const [i, d] = D(v).toFixed().split(".");
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${d ? `.${d}` : ""}`;
};
const norm = (v: string | null | undefined) => v ?? "";

/** The 27 fields of Xero's bill import template, in order. */
export const COLS: Col[] = [
  { label: "Xero Reference No", w: 250, get: (r) => r.header.reference_no },
  { label: "*ContactName", w: 220, get: (r) => r.header.contact_name },
  { label: "EmailAddress", w: 210, get: (r) => norm(r.header.email_address) },
  { label: "POAddressLine1", w: 150, get: (r) => norm(r.header.po_address_line1) },
  { label: "POAddressLine2", w: 150, get: (r) => norm(r.header.po_address_line2) },
  { label: "POAddressLine3", w: 150, get: (r) => norm(r.header.po_address_line3) },
  { label: "POAddressLine4", w: 150, get: (r) => norm(r.header.po_address_line4) },
  { label: "POCity", w: 120, get: (r) => norm(r.header.po_city) },
  { label: "PORegion", w: 120, get: (r) => norm(r.header.po_region) },
  { label: "POPostalCode", w: 130, get: (r) => norm(r.header.po_postal_code) },
  { label: "POCountry", w: 120, get: (r) => norm(r.header.po_country) },
  { label: "*InvoiceNumber", w: 250, get: (r) => r.header.invoice_number },
  { label: "*InvoiceDate", w: 120, get: (r) => xeroDate(r.header.invoice_date) },
  { label: "*DueDate", w: 120, get: (r) => xeroDate(r.header.due_date) },
  { label: "Total", w: 150, right: true, get: (r) => money(r.header.total) },
  { label: "InventoryItemCode", w: 150, get: () => "" },
  { label: "Description", w: 320, wrap: true, get: (r) => r.line.description },
  { label: "*Quantity", w: 90, right: true, get: (r) => money(r.line.quantity) },
  { label: "*UnitAmount", w: 160, right: true, get: (r) => money(r.line.unit_amount) },
  { label: "*AccountCode", w: 130, get: (r) => norm(r.line.account_code) },
  { label: "*TaxType", w: 120, get: (r) => r.line.tax_type },
  { label: "TaxAmount", w: 120, right: true, get: (r) => money(r.line.tax_amount) },
  { label: "TrackingName1", w: 130, get: (r) => norm(r.header.tracking_name1) },
  { label: "TrackingOption1", w: 150, get: (r) => norm(r.header.tracking_option1) },
  { label: "TrackingName2", w: 140, get: (r) => norm(r.header.tracking_name2) },
  { label: "TrackingOption2", w: 150, get: (r) => norm(r.header.tracking_option2) },
  { label: "Currency", w: 100, get: (r) => r.header.currency },
];
