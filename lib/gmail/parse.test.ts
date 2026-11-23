import { describe, expect, it } from "vitest";
import { isPdfBytes, parseMessage, type GmailMessage } from "./parse";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const msg = (parts: GmailMessage["payload"]): GmailMessage => ({
  id: "abc123",
  threadId: "t1",
  internalDate: "1760860000000",
  payload: { headers: [{ name: "From", value: "Billing <billing@vendor.co>" }, { name: "Subject", value: "Invoice INV/5920" }], ...parts },
});

describe("parseMessage", () => {
  it("classifies an email with a PDF attachment", () => {
    const p = parseMessage(
      msg({ parts: [{ partId: "0", mimeType: "text/plain", body: { data: b64("hi") } }, { partId: "1", filename: "INV-5920.pdf", mimeType: "application/pdf", body: { attachmentId: "A1", size: 2048 } }] }),
    );
    expect(p.classification).toBe("pdf");
    expect(p.attachments).toEqual([{ partId: "1", attachmentId: "A1", filename: "INV-5920.pdf", mimeType: "application/pdf", size: 2048, isPdf: true }]);
    expect(p.from).toBe("Billing <billing@vendor.co>");
    expect(p.receivedAt).toBe(new Date(1760860000000).toISOString());
  });

  it("detects a PDF sent as octet-stream by its filename", () => {
    const p = parseMessage(msg({ parts: [{ partId: "1", filename: "faktur.PDF", mimeType: "application/octet-stream", body: { attachmentId: "A2" } }] }));
    expect(p.classification).toBe("pdf");
  });

  it("does not treat other attachments as invoices", () => {
    const p = parseMessage(msg({ parts: [{ partId: "1", filename: "photo.jpg", mimeType: "image/jpeg", body: { attachmentId: "A3" } }] }));
    expect(p.classification).toBe("none");
  });

  it("classifies invoice links and drops query strings", () => {
    const p = parseMessage(msg({ mimeType: "text/html", body: { data: b64('<a href="https://billing.vendor.co/invoices/99/download?token=SECRET123">x</a>') } }));
    expect(p.classification).toBe("link");
    expect(p.links).toEqual([{ host: "billing.vendor.co", path: "/invoices/99/download" }]);
    expect(JSON.stringify(p)).not.toContain("SECRET123");
  });

  it("marks unrelated links as unsure and ignores noise", () => {
    const p = parseMessage(msg({ mimeType: "text/plain", body: { data: b64("see https://vendor.co/about and https://facebook.com/x") } }));
    expect(p.classification).toBe("link_unsure");
    expect(p.links).toEqual([{ host: "vendor.co", path: "/about" }]);
  });

  it("returns none when there is nothing", () => {
    expect(parseMessage(msg({ mimeType: "text/plain", body: { data: b64("thanks") } })).classification).toBe("none");
  });
});

describe("isPdfBytes", () => {
  it("checks the magic header", () => {
    expect(isPdfBytes(Buffer.from("%PDF-1.7 ..."))).toBe(true);
    expect(isPdfBytes(Buffer.from("<html>"))).toBe(false);
  });
});

import { extractBodyText } from "./parse";

describe("extractBodyText", () => {
  it("prefers text/plain", () => {
    const t = extractBodyText({ id: "1", payload: { parts: [{ mimeType: "text/plain", body: { data: b64("Halo,\n\nTerlampir invoice.") } }, { mimeType: "text/html", body: { data: b64("<p>other</p>") } }] } });
    expect(t).toBe("Halo,\nTerlampir invoice.");
  });
  it("strips HTML, scripts and styles", () => {
    const t = extractBodyText({ id: "1", payload: { mimeType: "text/html", body: { data: b64("<style>p{x:y}</style><p>Total &amp; tax</p><script>evil()</script><div>Due 30 days</div>") } } });
    expect(t).toBe("Total & tax\nDue 30 days");
  });
  it("ignores attachment parts and truncates long bodies", () => {
    const long = "x".repeat(10000);
    expect(extractBodyText({ id: "1", payload: { mimeType: "text/plain", body: { data: b64(long) } } })).toHaveLength(6000);
    expect(extractBodyText({ id: "1", payload: { parts: [{ filename: "a.txt", mimeType: "text/plain", body: { data: b64("secret") } }] } })).toBe("");
  });
});
