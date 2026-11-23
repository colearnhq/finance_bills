import { describe, expect, it } from "vitest";
import { buildQuery, matchesRule, sanitizePattern } from "./filters-core";

describe("sanitizePattern", () => {
  it("removes characters that could break out of a quoted Gmail term", () => {
    expect(sanitizePattern('foo" OR from:boss@x.com "')).toBe("foo OR from:boss@x.com");
    expect(sanitizePattern("a (b) {c} \\d")).toBe("a b c d");
  });
  it("collapses whitespace, trims and caps the length", () => {
    expect(sanitizePattern("  a \n\t b  ")).toBe("a b");
    expect(sanitizePattern("x".repeat(300))).toHaveLength(100);
  });
  it("returns empty when nothing usable is left", () => {
    expect(sanitizePattern('"" ()')).toBe("");
  });
});

describe("buildQuery", () => {
  const base = 'subject:(INV OR INVOICE) newer_than:30d';
  it("returns the base unchanged without rules", () => {
    expect(buildQuery(base, [])).toBe(base);
  });
  it("wraps the base and appends exclusions", () => {
    expect(
      buildQuery(base, [
        { kind: "subject", pattern: "Summary of failures" },
        { kind: "sender", pattern: "noreply@google.com" },
      ]),
    ).toBe('(subject:(INV OR INVOICE) newer_than:30d) -subject:"Summary of failures" -from:"noreply@google.com"');
  });
  it("cannot be used to inject extra operators", () => {
    const q = buildQuery(base, [{ kind: "subject", pattern: 'x" OR in:anywhere "' }]);
    expect(q).toBe('(subject:(INV OR INVOICE) newer_than:30d) -subject:"x OR in:anywhere"');
    expect(q.match(/"/g)).toHaveLength(2);
  });
  it("skips rules that sanitise to nothing", () => {
    expect(buildQuery(base, [{ kind: "subject", pattern: '""' }])).toBe(base);
  });
});

describe("matchesRule", () => {
  const email = { subject: "Summary of failures for Google Apps Script: Consultant Invoice", from: "noreply-apps-scripts-notifications@google.com" };
  it("matches subject and sender case-insensitively as substrings", () => {
    expect(matchesRule({ kind: "subject", pattern: "summary of FAILURES" }, email)).toBe(true);
    expect(matchesRule({ kind: "sender", pattern: "apps-scripts-notifications" }, email)).toBe(true);
  });
  it("does not cross kinds or match empty patterns", () => {
    expect(matchesRule({ kind: "sender", pattern: "Summary of failures" }, email)).toBe(false);
    expect(matchesRule({ kind: "subject", pattern: '""' }, email)).toBe(false);
  });
});

import { extractAddress, suggestRule, suggestSubjectPattern } from "./filters-core";

describe("extractAddress", () => {
  it("handles display names and bare addresses", () => {
    expect(extractAddress('"Accounts Receivable" via Infra <Infra@colearn.id>')).toBe("infra@colearn.id");
    expect(extractAddress("noreply@google.com")).toBe("noreply@google.com");
  });
});

describe("suggestSubjectPattern", () => {
  it("cuts at the first separator", () => {
    expect(suggestSubjectPattern("Summary of failures for Google Apps Script: Consultant Invoice")).toBe("Summary of failures for Google Apps Script");
  });
  it("drops reply prefixes and tokens with digits", () => {
    expect(suggestSubjectPattern("Re: Fwd: Payment reminder 2026")).toBe("Payment reminder");
    expect(suggestSubjectPattern("Service Invoice - Nadila C - 11/2/2026")).toBe("Service Invoice");
  });
  it("falls back to the full subject when too little is left", () => {
    expect(suggestSubjectPattern("INV-2026-0001")).toBe("INV-2026-0001");
  });
});

describe("suggestRule", () => {
  it("suggests the sender for automated senders", () => {
    expect(suggestRule({ subject: "Summary of failures", from: "noreply-apps-scripts-notifications@google.com" })).toEqual({
      kind: "sender",
      pattern: "noreply-apps-scripts-notifications@google.com",
    });
  });
  it("suggests the subject for human senders, never the whole sender", () => {
    expect(suggestRule({ subject: "Thank you for your payment", from: "Infra <infra@colearn.id>" })).toEqual({ kind: "subject", pattern: "Thank you for your payment" });
  });
});
