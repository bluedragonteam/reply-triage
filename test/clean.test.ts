import { describe, expect, it } from "vitest";
import { cleanReply, stripQuotedText, stripSignature } from "../src/clean.js";

describe("stripQuotedText", () => {
  it("cuts at a Gmail attribution line", () => {
    const raw = "Sounds good, let's talk.\n\nOn Mon, Nov 2, 2026 at 9:14 AM Mira <mira@example.com> wrote:\n> Hi,\n> would a call help?";
    expect(stripQuotedText(raw)).toEqual({ text: "Sounds good, let's talk.", removed: true });
  });

  it("handles an attribution wrapped over two lines", () => {
    const raw = "Yes please.\n\nOn Mon, Nov 2, 2026 at 9:14 AM Mira Patel <\nmira@example.com> wrote:\n> Hi";
    expect(stripQuotedText(raw).text).toBe("Yes please.");
  });

  it("cuts at an Outlook header block", () => {
    const raw = [
      "Tuesday works.",
      "",
      "From: Mira Patel <mira@example.com>",
      "Sent: Monday, November 2, 2026 9:14 AM",
      "To: Ops <ops@example.com>",
      "Subject: Hello",
      "",
      "Hi there",
    ].join("\r\n");
    expect(stripQuotedText(raw).text).toBe("Tuesday works.");
  });

  it("cuts at the Outlook underscore separator and Original Message marker", () => {
    expect(stripQuotedText("Ok.\n\n________________________________\nFrom: x").text).toBe("Ok.");
    expect(stripQuotedText("Ok.\n-----Original Message-----\nFrom: x").text).toBe("Ok.");
  });

  it("recognises non-English attributions", () => {
    expect(stripQuotedText("Merci.\n\nLe lun. 2 nov. 2026 à 09:14, Mira <m@example.com> a écrit :\n> Bonjour").text).toBe("Merci.");
    expect(stripQuotedText("Danke.\n\nAm 02.11.2026 um 09:14 schrieb Mira <m@example.com>:\n> Hallo").text).toBe("Danke.");
  });

  it("drops inline '>' quoted lines but keeps interleaved answers", () => {
    const raw = "> Do you use SAP?\nYes, S/4HANA.\n> How many sites?\nThree.";
    expect(stripQuotedText(raw)).toEqual({ text: "Yes, S/4HANA.\nThree.", removed: true });
  });

  it("does not treat a sentence starting with 'On' as a quote header", () => {
    const raw = "On second thought, send me the deck.";
    expect(stripQuotedText(raw)).toEqual({ text: raw, removed: false });
  });

  it("does not cut at a body line that merely starts with From:", () => {
    const raw = "From: our side, Thursday is fine.\nLooking forward to it.";
    expect(stripQuotedText(raw).removed).toBe(false);
  });
});

describe("stripSignature", () => {
  it("removes a sign-off and short signature block", () => {
    const raw = "Yes, let's try it.\n\nThanks,\nDaniela Ortiz\nOps Lead | Larkspur Freight\n+1 555 0100";
    expect(stripSignature(raw)).toEqual({ text: "Yes, let's try it.", removed: true });
  });

  it("removes everything after the RFC 3676 delimiter", () => {
    const raw = "Not now, maybe in March.\n-- \nSam Reyes\nsam@example.com";
    expect(stripSignature(raw)).toEqual({ text: "Not now, maybe in March.", removed: true });
  });

  it("removes mobile footers", () => {
    expect(stripSignature("Call me Tuesday.\n\nSent from my iPhone").text).toBe("Call me Tuesday.");
    expect(stripSignature("Call me.\n\nGet Outlook for iOS").text).toBe("Call me.");
  });

  it("keeps a body whose only line is a sign-off word", () => {
    expect(stripSignature("Thanks!")).toEqual({ text: "Thanks!", removed: false });
  });

  it("does not strip a long tail after an early 'Thanks,'", () => {
    const raw = [
      "Thanks,",
      "here is the situation in detail.",
      "We have three warehouses and roughly two hundred people on rotating shifts across all of them every week.",
      "Pricing would need to work per site.",
    ].join("\n");
    expect(stripSignature(raw).removed).toBe(false);
  });

  it("keeps a P.S. after the sign-off", () => {
    const raw = "Sounds good.\n\nBest,\nSam\nP.S. talk to jo@example.com too";
    expect(stripSignature(raw).removed).toBe(false);
  });

  it("does not treat 'Thanks, but no' as a sign-off", () => {
    const raw = "Thanks, but we're all set.";
    expect(stripSignature(raw)).toEqual({ text: raw, removed: false });
  });
});

describe("cleanReply", () => {
  it("strips both quote and signature", () => {
    const raw = "Let's do Thursday.\n\nBest,\nSam\n\nOn Mon, Nov 2, 2026 at 9:14 AM Mira <m@example.com> wrote:\n> Hi";
    expect(cleanReply(raw)).toEqual({ text: "Let's do Thursday.", quoteRemoved: true, signatureRemoved: true });
  });

  it("falls back to the original text when cleaning would leave nothing", () => {
    const raw = "> only quoted text\n> nothing new";
    expect(cleanReply(raw)).toEqual({ text: raw, quoteRemoved: false, signatureRemoved: false });
  });

  it("normalises CRLF and collapses blank lines", () => {
    expect(cleanReply("Line one.\r\n\r\n\r\n\r\nLine two.\r\n").text).toBe("Line one.\n\nLine two.");
  });
});
