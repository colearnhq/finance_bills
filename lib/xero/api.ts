/** Thin, typed wrappers over the Xero endpoints we use. Only the fields we read are typed. */
import type { XeroClient } from "./client";

export interface XContact { ContactID: string; Name: string; ContactStatus?: string }
export interface XAccount { Code?: string; Name?: string; Status?: string; Type?: string }
export interface XTaxRate { Name: string; TaxType: string; Status?: string; EffectiveRate?: number; DisplayTaxRate?: number }
export interface XTrackingCategory { Name: string; Status?: string; Options?: { Name: string; Status?: string }[] }
export interface XInvoice { InvoiceID: string; InvoiceNumber?: string; Status?: string; Total?: number; HasErrors?: boolean; ValidationErrors?: { Message?: string }[]; Contact?: { ContactID?: string } }
export interface XAttachment { AttachmentID?: string; FileName?: string }
export interface XOrganisation { Name?: string; IsDemoCompany?: boolean; BaseCurrency?: string; CountryCode?: string }

/** Xero's `where` filter has no escaping for quotes, so a value containing one is refused instead of being guessed at. */
export function whereLiteral(value: string): string {
  if (/["\\\r\n]/.test(value)) throw new Error("Nilai mengandung karakter yang tidak didukung filter Xero.");
  return `"${value}"`;
}

export const findContactsByName = async (x: XeroClient, name: string) =>
  (await x.get<{ Contacts?: XContact[] }>("/Contacts", { where: `Name==${whereLiteral(name)}` })).Contacts ?? [];
export const listAccounts = async (x: XeroClient) => (await x.get<{ Accounts?: XAccount[] }>("/Accounts")).Accounts ?? [];
export const listTaxRates = async (x: XeroClient) => (await x.get<{ TaxRates?: XTaxRate[] }>("/TaxRates")).TaxRates ?? [];
export const listTrackingCategories = async (x: XeroClient) => (await x.get<{ TrackingCategories?: XTrackingCategory[] }>("/TrackingCategories")).TrackingCategories ?? [];
export const getOrganisation = async (x: XeroClient) => (await x.get<{ Organisations?: XOrganisation[] }>("/Organisation")).Organisations?.[0] ?? null;

export const findBillsByNumber = async (x: XeroClient, invoiceNumber: string) =>
  (await x.get<{ Invoices?: XInvoice[] }>("/Invoices", { where: `Type=="ACCPAY" AND InvoiceNumber==${whereLiteral(invoiceNumber)}` })).Invoices ?? [];

/** PUT creates; unitdp=4 asks Xero to keep 4 decimals on unit amounts instead of rounding to 2. */
export const createBill = async (x: XeroClient, invoice: unknown, idempotencyKey: string) =>
  (await x.put<{ Invoices?: XInvoice[] }>("/Invoices", { query: { unitdp: "4" }, json: { Invoices: [invoice] }, idempotencyKey })).Invoices ?? [];

export const listInvoiceAttachments = async (x: XeroClient, invoiceId: string) =>
  (await x.get<{ Attachments?: XAttachment[] }>(`/Invoices/${encodeURIComponent(invoiceId)}/Attachments`)).Attachments ?? [];

export const uploadInvoiceAttachment = (x: XeroClient, invoiceId: string, fileName: string, bytes: Uint8Array, idempotencyKey: string) =>
  x.put<unknown>(`/Invoices/${encodeURIComponent(invoiceId)}/Attachments/${encodeURIComponent(fileName)}`, { body: bytes, contentType: "application/pdf", idempotencyKey });
