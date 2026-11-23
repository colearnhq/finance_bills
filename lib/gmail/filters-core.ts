/** Pure helpers for email exclusion rules. No I/O. */

export type RuleKind = "subject" | "sender";
export interface Rule {
  kind: RuleKind;
  pattern: string;
}

/**
 * Makes a pattern safe to embed inside a quoted Gmail search term: removes quotes, braces, parentheses,
 * backslashes and control characters, and collapses whitespace. Returns "" when nothing usable is left.
 */
export function sanitizePattern(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f"'(){}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * Final Gmail query = base search AND NOT each exclusion.
 * Gmail matches whole words / phrases for subject: and from:, not arbitrary substrings.
 */
export function buildQuery(base: string, rules: Rule[]): string {
  const terms = rules
    .map((r) => ({ ...r, pattern: sanitizePattern(r.pattern) }))
    .filter((r) => r.pattern)
    .map((r) => `-${r.kind === "subject" ? "subject" : "from"}:"${r.pattern}"`);
  const b = base.trim();
  return terms.length ? `(${b}) ${terms.join(" ")}` : b;
}

/** Case-insensitive substring match, used to clean up emails that were synced before a rule existed. */
export function matchesRule(rule: Rule, email: { subject: string; from: string }): boolean {
  const p = sanitizePattern(rule.pattern).toLowerCase();
  if (!p) return false;
  return (rule.kind === "subject" ? email.subject : email.from).toLowerCase().includes(p);
}

/** "Name <a@b.c>" -> "a@b.c". Falls back to the trimmed input. */
export function extractAddress(from: string): string {
  const m = from.match(/<([^<>\s]+@[^<>\s]+)>/) ?? from.match(/([^\s<>"]+@[^\s<>"]+)/);
  return (m ? m[1] : from).trim().toLowerCase();
}

const AUTOMATED = /(no-?reply|do-?not-?reply|notification|notifications|mailer-daemon|alerts?@|bounce)/i;

/**
 * Suggests a rule when a user marks an email "not an invoice".
 * Automated senders (noreply, notifications) -> sender rule. Everything else -> subject rule, because a
 * human sender (e.g. People Ops) may also send real invoices. The user can always edit the suggestion.
 */
export function suggestRule(email: { subject: string; from: string }): Rule {
  const address = extractAddress(email.from);
  if (AUTOMATED.test(address)) return { kind: "sender", pattern: address };
  return { kind: "subject", pattern: suggestSubjectPattern(email.subject) };
}

/**
 * Keeps the stable beginning of a subject: drops reply/forward prefixes, cuts at the first ":", " - ", " | " or "#",
 * and removes tokens containing digits (invoice numbers, dates). Falls back to the cleaned full subject.
 */
export function suggestSubjectPattern(subject: string): string {
  let s = subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "");
  const full = sanitizePattern(s);
  s = s.split(/\s[-–|]\s|:|#/)[0];
  const cleaned = sanitizePattern(
    s
      .split(/\s+/)
      .filter((t) => !/\d/.test(t))
      .join(" "),
  );
  return cleaned.length >= 3 ? cleaned : full;
}
