/** Entities this install books invoices for. A "billed to" that matches none of them is flagged for review. */
export const BILLING_ENTITY_PATTERNS: RegExp[] = [/IQ\s*Edukasi/i];

/** Currencies the Payment Schedule accepts (mirrors the Currency master list). */
export const DEFAULT_CURRENCIES = ["IDR", "USD", "SGD", "INR", "AED", "EUR"];
