import { describe, expect, it } from "vitest";
import { fastPathClassify } from "../src/fastPath.js";

describe("fastPathClassify", () => {
  it("classifies Auto-Submitted messages as auto_reply (header match is case-insensitive)", () => {
    const match = fastPathClassify({ reply: "I am away.", headers: { "auto-submitted": "Auto-Replied" } });
    expect(match?.rule).toBe("auto_submitted_header");
    expect(match?.result).toMatchObject({ category: "auto_reply", needs_human: false, suggested_reply: null });
  });

  it('ignores Auto-Submitted: no (RFC 3834 value for human mail)', () => {
    expect(fastPathClassify({ reply: "Sounds good", headers: { "Auto-Submitted": "no" } })).toBeNull();
  });

  it.each([
    "Out of Office: Shift scheduling",
    "Automatic reply: Shift scheduling",
    "Auto-Reply: hello",
    "OOO until Monday",
    "Réponse automatique : bonjour",
  ])("classifies subject %j as auto_reply", (subject) => {
    expect(fastPathClassify({ reply: "Away.", subject })?.result.category).toBe("auto_reply");
  });

  it("recognises X-Autoreply and Precedence: auto_reply", () => {
    expect(fastPathClassify({ reply: "x", headers: { "X-Autoreply": "yes" } })?.rule).toBe("x_autoreply_header");
    expect(fastPathClassify({ reply: "x", headers: { Precedence: "auto_reply" } })?.rule).toBe("precedence_auto_reply");
  });

  it("classifies delivery failures by sender, subject, header or content type", () => {
    expect(fastPathClassify({ reply: "x", from: "MAILER-DAEMON@mx.example.net" })?.rule).toBe("bounce_sender");
    expect(fastPathClassify({ reply: "x", from: "Mail Delivery System <postmaster@example.org>" })?.rule).toBe("bounce_sender");
    expect(fastPathClassify({ reply: "x", subject: "Undeliverable: hello" })?.rule).toBe("bounce_subject");
    expect(fastPathClassify({ reply: "x", subject: "Delivery Status Notification (Failure)" })?.rule).toBe("bounce_subject");
    expect(
      fastPathClassify({ reply: "x", headers: { "Content-Type": 'multipart/report; report-type="delivery-status"; boundary=abc' } })?.rule,
    ).toBe("content_type_delivery_status");
  });

  it("mentions the failed recipient when the header provides it", () => {
    const match = fastPathClassify({ reply: "x", headers: { "X-Failed-Recipients": "k.adams@example.com" } });
    expect(match?.result.category).toBe("bounce");
    expect(match?.result.summary).toContain("k.adams@example.com");
  });

  it("prefers bounce over auto_reply when both signals are present", () => {
    const match = fastPathClassify({ reply: "x", subject: "Undeliverable: hi", headers: { "Auto-Submitted": "auto-generated" } });
    expect(match?.result.category).toBe("bounce");
  });

  it("leaves ordinary replies to the model", () => {
    expect(fastPathClassify({ reply: "I'm out of the office today but yes, let's talk.", subject: "Re: Shift scheduling" })).toBeNull();
    expect(fastPathClassify({ reply: "Not interested", subject: "Re: Office scheduling for your team" })).toBeNull();
  });
});
