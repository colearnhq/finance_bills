import { csvCell } from "@/lib/payment-schedule/csv";
import { D } from "@/lib/payment-schedule/calc";
import type { BillHeader, BillLine } from "./bill";

/** Header of Xero's bill import template, exactly as in the team's sample CSV. */
export const XERO_HEADERS = [
  "Xero Reference No", "*ContactName", "EmailAddress",
  "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion", "POPostalCode", "POCountry",
  "*InvoiceNumber", "*InvoiceDate", "*DueDate", "Total", "InventoryItemCode", "Description",
  "*Quantity", "*UnitAmount", "*AccountCode", "*TaxType", "TaxAmount",
  "TrackingName1", "TrackingOption1", "TrackingName2", "TrackingOption2", "Currency",
] as const;

/** "2026-01-31" -> "31/1/2026" (day/month/year without padding, as in the sample). */
export function xeroDate(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : "";
}

const plain = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "" : D(v).toFixed());

export interface CsvBill { header: Omit<BillHeader, "payment_schedule_id">; lines: BillLine[] }

/**
 * One CSV record per bill line. Like the sample, Total, TaxAmount and InventoryItemCode are left blank
 * (Xero works the total out from the lines); the total is only shown inside AP Hub.
 */
export function billsToCsv(bills: CsvBill[]): string {
  const out = [XERO_HEADERS.map((h) => csvCell(h, false)).join(",")];
  for (const { header: h, lines } of bills) {
    for (const l of [...lines].sort((a, b) => a.line_no - b.line_no)) {
      const cells = [
        csvCell(h.reference_no, true), csvCell(h.contact_name, true), csvCell(h.email_address ?? "", true),
        csvCell(h.po_address_line1 ?? "", true), csvCell(h.po_address_line2 ?? "", true), csvCell(h.po_address_line3 ?? "", true), csvCell(h.po_address_line4 ?? "", true),
        csvCell(h.po_city ?? "", true), csvCell(h.po_region ?? "", true), csvCell(h.po_postal_code ?? "", true), csvCell(h.po_country ?? "", true),
        csvCell(h.invoice_number, true), xeroDate(h.invoice_date), xeroDate(h.due_date), "", "", csvCell(l.description, true),
        plain(l.quantity), plain(l.unit_amount), csvCell(l.account_code ?? "", true), csvCell(l.tax_type, true), plain(l.tax_amount),
        csvCell(h.tracking_name1 ?? "", true), csvCell(h.tracking_option1 ?? "", true), csvCell(h.tracking_name2 ?? "", true), csvCell(h.tracking_option2 ?? "", true),
        csvCell(h.currency, true),
      ];
      out.push(cells.join(","));
    }
  }
  return out.join("\r\n") + "\r\n";
}
