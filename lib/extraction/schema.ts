import { z } from "zod";

/** Bump when the schema or prompt changes: stored with every extraction for audit. */
export const PROMPT_VERSION = "2026-11-11.2";
export const MODEL = "claude-sonnet-5-5";

/**
 * A value read from the document, with where it came from. `value` is null when the document does not state it:
 * the model must never fill a field by guessing or calculating.
 */
const field = z.object({
  value: z.string().nullable(),
  evidence: z.string().nullable(), // short verbatim quote containing the value
  page: z.number().int().nullable(),
  source: z.enum(["document", "email_body"]).nullable(),
});

/** Dates keep the printed text; `iso` is YYYY-MM-DD, and `ambiguous` flags numeric dates readable two ways. */
const dateField = z.object({
  raw: z.string().nullable(),
  iso: z.string().nullable(),
  ambiguous: z.boolean(),
  evidence: z.string().nullable(),
  page: z.number().int().nullable(),
  source: z.enum(["document", "email_body"]).nullable(),
});

export const ExtractionSchema = z.object({
  document_type: z.enum(["invoice", "receipt", "credit_note", "statement", "other"]),
  document_type_evidence: z.string().nullable(),
  vendor_name: field, // who issues the invoice (payee), not who is billed
  vendor_email: field,
  vendor_tax_id: field, // NPWP / tax ID of the vendor
  billed_to: field, // the customer entity named on the document
  invoice_no: field,
  po_no: field,
  invoice_date: dateField,
  due_date: dateField,
  period_from: dateField, // service / billing period start
  period_to: dateField,
  description: field, // short summary of what was bought
  currency: field, // ISO 4217 code, e.g. IDR, USD
  subtotal: field, // amount before tax, as printed
  discount: field,
  tax_amount: field, // VAT/PPN/GST total as printed
  total: field, // grand total as printed
  amount_paid: field,
  amount_due: field,
  line_items: z.array(
    z.object({
      description: z.string().nullable(),
      quantity: z.string().nullable(),
      unit_price: z.string().nullable(),
      amount: z.string().nullable(),
    }),
  ),
  bank_name: field,
  beneficiary_name: field,
  account_number: field,
  swift_code: field,
  ifsc_code: field,
  already_paid: z.boolean().nullable(), // the document says it is paid
  notes: z.array(z.string()), // anomalies worth a human look (several invoices in one file, unreadable parts...)
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type Field = z.infer<typeof field>;
export type DateField = z.infer<typeof dateField>;
