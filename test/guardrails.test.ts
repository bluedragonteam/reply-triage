import { describe, expect, it } from "vitest";
import { applyGuardrails, detectUnsubscribe, type GuardrailContext } from "../src/guardrails.js";
import { validResult } from "./helpers.js";

const ctx = (text: string, overrides: Partial<GuardrailContext> = {}): GuardrailContext => ({
  cleanedText: text,
  rawText: text,
  referenceDate: "2026-11-02",
  lowConfidenceThreshold: 0.6,
  ...overrides,
});

describe("detectUnsubscribe", () => {
  it.each([
    "Unsubscribe",
    "please unsubscribe me",
    "Could you take me off your list?",
    "Remove my address from your mailing list, thanks.",
    "Please remove me from this sequence",
    "Stop emailing me.",
    "Under GDPR, do not contact me again.",
    "I'd like to opt out.",
    "No more emails please.",
    "I already unsubscribed and still get these.",
  ])("detects %j", (text) => {
    expect(detectUnsubscribe(text)).toBe(true);
  });

  it.each([
    "No need to unsubscribe me, this is useful.",
    "Don't unsubscribe me, just send it next quarter.",
    "Not interested right now, check back in March.",
    "Remove me from the CC, and add Priya instead.", // no list wording: left to the model
    "Please don't email me, call me instead.",
  ])("does not fire on %j", (text) => {
    expect(detectUnsubscribe(text)).toBe(false);
  });
});

describe("applyGuardrails", () => {
  it("forces unsubscribe when the reply explicitly opts out, whatever the model said", () => {
    const { result, applied } = applyGuardrails(
      validResult({ category: "not_interested", needs_human: true, suggested_reply: "Understood!" }),
      ctx("Not interested. Please remove me from your mailing list."),
    );
    expect(result).toMatchObject({ category: "unsubscribe", needs_human: false, suggested_reply: null, follow_up_date: null });
    expect(applied).toContain("unsubscribe_keyword_override");
  });

  it("normalizes an unsubscribe from the model (no reply, no human, no follow-up)", () => {
    const { result, applied } = applyGuardrails(
      validResult({ category: "unsubscribe", needs_human: true, suggested_reply: "Sorry!", follow_up_date: "2027-03-01", confidence: 0.4 }),
      ctx("Kindly leave me out of future sends."),
    );
    expect(result).toMatchObject({ category: "unsubscribe", needs_human: false, suggested_reply: null, follow_up_date: null });
    expect(applied).toContain("unsubscribe_normalized");
  });

  it("removes suggested replies for auto replies and bounces", () => {
    for (const category of ["auto_reply", "bounce"] as const) {
      const { result, applied } = applyGuardrails(validResult({ category }), ctx("I am away until Monday."));
      expect(result.suggested_reply).toBeNull();
      expect(applied).toContain("no_reply_category_reply_removed");
    }
  });

  it("keeps a referral that appears in the reply", () => {
    const text = "Try Priya Raman (priya.raman@example.com).";
    const referral = { name: "Priya Raman", email: "priya.raman@example.com" };
    const { result, applied } = applyGuardrails(validResult({ category: "referral", referral }), ctx(text));
    expect(result.referral).toEqual(referral);
    expect(applied).toEqual([]);
  });

  it("drops an invented email but keeps the grounded name", () => {
    const { result, applied } = applyGuardrails(
      validResult({ category: "referral", referral: { name: "Sven", email: "sven@example.com" } }),
      ctx("Please reach out to Sven in our Rotterdam office."),
    );
    expect(result.referral).toEqual({ name: "Sven", email: null });
    expect(applied).toContain("referral_ungrounded_removed");
  });

  it("drops a fully invented referral and routes the reply to a human", () => {
    const { result, applied } = applyGuardrails(
      validResult({ category: "referral", referral: { name: "Jane Doe", email: "jane@example.com" } }),
      ctx("Talk to our ops team."),
    );
    expect(result.referral).toBeNull();
    expect(result.needs_human).toBe(true);
    expect(applied).toEqual(["referral_ungrounded_removed", "referral_without_contact_needs_human"]);
  });

  it("grounds a referral against the raw reply when it sits in the stripped part", () => {
    const { result } = applyGuardrails(
      validResult({ category: "referral", referral: { name: "Ana Ruiz", email: "ana@example.org" } }),
      ctx("See below, she is the right person.", { rawText: "See below.\n\n-- \nAna Ruiz ana@example.org" }),
    );
    expect(result.referral?.email).toBe("ana@example.org");
  });

  it("removes follow-up dates that are not in the future or too far out", () => {
    for (const date of ["2026-11-02", "2025-03-01", "2030-01-01"]) {
      const { result, applied } = applyGuardrails(validResult({ category: "not_now", follow_up_date: date }), ctx("Later."));
      expect(result.follow_up_date).toBeNull();
      expect(applied).toContain("follow_up_date_out_of_range_removed");
    }
    const { result } = applyGuardrails(validResult({ category: "not_now", follow_up_date: "2027-03-01" }), ctx("Ask me in March."));
    expect(result.follow_up_date).toBe("2027-03-01");
  });

  it("flags low-confidence results for a human", () => {
    const { result, applied } = applyGuardrails(validResult({ confidence: 0.3 }), ctx("Hmm, maybe?"));
    expect(result.needs_human).toBe(true);
    expect(applied).toContain("low_confidence_needs_human");
  });

  it("does not mutate its input", () => {
    const input = validResult({ category: "unsubscribe", referral: { name: "X", email: null } });
    const snapshot = structuredClone(input);
    applyGuardrails(input, ctx("unsubscribe"));
    expect(input).toEqual(snapshot);
  });
});
