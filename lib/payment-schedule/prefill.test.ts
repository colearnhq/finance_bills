import { describe, expect, it } from "vitest";
import { inputDateFromExtraction } from "./prefill";

describe("inputDateFromExtraction", () => {
  it("uses the Jakarta calendar day, not the UTC day", () => {
    expect(inputDateFromExtraction("2026-11-17T23:30:00Z")).toBe("2026-11-18"); // 06:30 WIB the next day
    expect(inputDateFromExtraction("2026-11-18T16:59:59Z")).toBe("2026-11-18"); // 23:59:59 WIB
    expect(inputDateFromExtraction("2026-11-18T17:00:00Z")).toBe("2026-11-19"); // 00:00 WIB
  });
  it("crosses the year boundary in Jakarta time", () => {
    expect(inputDateFromExtraction("2026-12-31T18:00:00Z")).toBe("2027-01-01");
  });
  it("returns null for an invalid timestamp", () => {
    expect(inputDateFromExtraction("not a date")).toBeNull();
  });
});
