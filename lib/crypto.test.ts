import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

describe("secret encryption", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
  it("round-trips and never stores plaintext", () => {
    const blob = encryptSecret("1//refresh-token");
    expect(blob).not.toContain("refresh-token");
    expect(decryptSecret(blob)).toBe("1//refresh-token");
  });
  it("uses a fresh IV each time", () => {
    expect(encryptSecret("a")).not.toBe(encryptSecret("a"));
  });
  it("rejects tampering and a wrong key", () => {
    const blob = encryptSecret("secret");
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(blob)).toThrow();
  });
  it("requires a 32-byte key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "short";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/not set/);
  });
});
