import type { TriageInput, TriageResult } from "./types.js";

/**
 * Deterministic classification for messages that are obviously machine-generated.
 * These never reach the API: they are cheap, instant, and the rules are standard
 * (RFC 3834 Auto-Submitted, RFC 3464 delivery status notifications).
 *
 * The rules are intentionally conservative. Anything that is not clearly an
 * auto-reply or a bounce goes to the model.
 */

export interface FastPathMatch {
  rule: string;
  result: TriageResult;
}

const BOUNCE_SENDER = /^(?:.*<)?\s*(mailer-daemon|postmaster|mail-delivery-subsystem|mail\.delivery\.subsystem)@/i;
const BOUNCE_SUBJECT =
  /^\s*(undeliverable|undelivered mail returned to sender|delivery status notification \(failure\)|mail delivery failed|mail delivery failure|returned mail|delivery failure|failure notice|message not delivered|delivery has failed)(?![a-z])/i;

const AUTO_REPLY_SUBJECT =
  /^\s*(automatic reply|auto(?:matic)?[- ]?reply|auto[- ]?response|autoreply|out of (?:the )?office|ooo\b|away from (?:the )?office|abwesenheitsnotiz|réponse automatique|respuesta automática)/i;

function lowerCaseHeaders(headers: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers ?? {})) {
    map.set(key.trim().toLowerCase(), value.trim());
  }
  return map;
}

function bounceRule(input: TriageInput, headers: Map<string, string>): string | null {
  const contentType = headers.get("content-type") ?? "";
  if (/multipart\/report/i.test(contentType) && /report-type\s*=\s*"?delivery-status/i.test(contentType)) {
    return "content_type_delivery_status";
  }
  if (headers.has("x-failed-recipients")) return "x_failed_recipients_header";
  if (input.from && BOUNCE_SENDER.test(input.from)) return "bounce_sender";
  if (input.subject && BOUNCE_SUBJECT.test(input.subject)) return "bounce_subject";
  return null;
}

function autoReplyRule(input: TriageInput, headers: Map<string, string>): string | null {
  const autoSubmitted = headers.get("auto-submitted");
  // RFC 3834: any value other than "no" marks the message as automatic.
  if (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== "no") return "auto_submitted_header";
  if (headers.has("x-autoreply") || headers.has("x-autorespond")) return "x_autoreply_header";
  if (/^auto[_-]reply$/i.test(headers.get("precedence") ?? "")) return "precedence_auto_reply";
  if (input.subject && AUTO_REPLY_SUBJECT.test(input.subject)) return "auto_reply_subject";
  return null;
}

/** Returns a result without calling the API, or null if the model is needed. */
export function fastPathClassify(input: TriageInput): FastPathMatch | null {
  const headers = lowerCaseHeaders(input.headers);

  // Bounces first: some MTAs also set Auto-Submitted on delivery reports.
  const bounce = bounceRule(input, headers);
  if (bounce) {
    const failed = headers.get("x-failed-recipients");
    return {
      rule: bounce,
      result: {
        category: "bounce",
        confidence: 0.99,
        summary: failed
          ? `Delivery failure notification: the message to ${failed} could not be delivered.`
          : "Delivery failure notification: the message could not be delivered.",
        follow_up_date: null,
        referral: null,
        needs_human: false,
        suggested_reply: null,
      },
    };
  }

  const auto = autoReplyRule(input, headers);
  if (auto) {
    return {
      rule: auto,
      result: {
        category: "auto_reply",
        confidence: 0.97,
        summary: "Automatic reply (for example out-of-office); no human response yet.",
        follow_up_date: null,
        referral: null,
        needs_human: false,
        suggested_reply: null,
      },
    };
  }

  return null;
}
