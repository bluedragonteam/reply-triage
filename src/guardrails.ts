import { NO_REPLY_CATEGORIES, type TriageResult } from "./types.js";

/**
 * Deterministic checks applied to every model result. The model is good at
 * reading intent; these rules make sure a few properties hold no matter what
 * it returns:
 *
 * - An explicit opt-out is always `unsubscribe`, never gets a drafted reply and
 *   never waits in a human queue (it should be suppressed immediately).
 * - Auto-replies and bounces never get a drafted reply.
 * - A referral must be grounded in the text: names and addresses that do not
 *   appear in the reply are dropped instead of being passed on.
 * - A follow-up date must be a real date in the future.
 * - Low-confidence results are routed to a human.
 */

export interface GuardrailContext {
  /** Cleaned reply text (what the model saw). */
  cleanedText: string;
  /** Full raw reply, used to ground referrals that sit in a signature or forward. */
  rawText: string;
  /** "Today" for the reply, as YYYY-MM-DD. */
  referenceDate: string;
  /** Results below this confidence get needs_human = true. */
  lowConfidenceThreshold: number;
}

export interface GuardrailOutcome {
  result: TriageResult;
  /** Names of the guardrails that changed something. */
  applied: string[];
}

interface Pattern {
  re: RegExp;
  /** Whether a preceding negation ("don't unsubscribe me") cancels the match. */
  negatable: boolean;
}

/** Phrases that unambiguously ask to stop receiving email. */
const UNSUBSCRIBE_PATTERNS: Pattern[] = [
  { re: /\bunsubscrib(?:e|ed|ing)\b/i, negatable: true },
  { re: /\bopt(?:[- ]?out| me out)\b/i, negatable: true },
  {
    re: /\bremove (?:me|us|my (?:e-?mail|address|details|name)|this (?:e-?mail|address))\b.{0,60}?\b(?:list|lists|mailing|database|distribution|contacts?|sequence|campaign|system|crm)\b/i,
    negatable: true,
  },
  { re: /\btake (?:me|us|my (?:e-?mail|address|name)) off\b/i, negatable: true },
  { re: /\b(?:stop|quit|cease) (?:e-?mailing|contacting|messaging|sending (?:me|us))\b/i, negatable: true },
  {
    re: /\b(?:do not|don't|dont|not to|not)\s+(?:e-?mail|contact|message|write to)\s+(?:me|us)\s+(?:again|anymore|any more|in the future|further)\b/i,
    negatable: false,
  },
  { re: /\bno (?:more|further) (?:e-?mails|messages|contact)\b/i, negatable: false },
];

const NEGATION_BEFORE = /\b(?:don't|dont|do not|no need to|not|never|won't|wont|didn't|didnt)\s+(?:\w+\s+){0,2}$/i;

/** True if the text contains an explicit request to stop receiving email. */
export function detectUnsubscribe(text: string): boolean {
  for (const { re, negatable } of UNSUBSCRIBE_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const match of text.matchAll(global)) {
      if (!negatable) return true;
      const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
      if (!NEGATION_BEFORE.test(before)) return true;
    }
  }
  return false;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function groundReferral(
  referral: TriageResult["referral"],
  source: string,
): { referral: TriageResult["referral"]; changed: boolean } {
  if (!referral) return { referral: null, changed: false };
  const haystack = normalize(source);

  const email = referral.email && haystack.includes(referral.email.toLowerCase()) ? referral.email : null;
  // A name counts as grounded if every word of it appears in the text.
  const nameParts = referral.name ? normalize(referral.name).split(/[^\p{L}\p{N}'.-]+/u).filter(Boolean) : [];
  const name =
    referral.name && nameParts.length > 0 && nameParts.every((part) => haystack.includes(part)) ? referral.name : null;

  const changed = email !== referral.email || name !== referral.name;
  if (email === null && name === null) return { referral: null, changed: true };
  return { referral: { name, email }, changed };
}

function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split("-");
  return `${Number(y) + years}-${m}-${d}`;
}

export function applyGuardrails(input: TriageResult, ctx: GuardrailContext): GuardrailOutcome {
  const result: TriageResult = { ...input, referral: input.referral ? { ...input.referral } : null };
  const applied: string[] = [];

  // Referral grounding: never pass on a contact the reply does not contain.
  const grounded = groundReferral(result.referral, `${ctx.cleanedText}\n${ctx.rawText}`);
  if (grounded.changed) {
    result.referral = grounded.referral;
    applied.push("referral_ungrounded_removed");
  }
  if (result.category === "referral" && result.referral === null && !result.needs_human) {
    result.needs_human = true;
    applied.push("referral_without_contact_needs_human");
  }

  // Follow-up date: must be after the reply date and within two years.
  if (result.follow_up_date !== null) {
    const limit = addYears(ctx.referenceDate, 2);
    if (result.follow_up_date <= ctx.referenceDate || result.follow_up_date > limit) {
      result.follow_up_date = null;
      applied.push("follow_up_date_out_of_range_removed");
    }
  }

  // Low confidence goes to a person (an unsubscribe below still overrides this).
  if (result.confidence < ctx.lowConfidenceThreshold && !result.needs_human) {
    result.needs_human = true;
    applied.push("low_confidence_needs_human");
  }

  // Unsubscribe: explicit opt-out phrasing always wins over the model's category.
  if (result.category !== "unsubscribe" && detectUnsubscribe(ctx.cleanedText)) {
    result.category = "unsubscribe";
    applied.push("unsubscribe_keyword_override");
  }
  if (result.category === "unsubscribe") {
    if (result.needs_human || result.suggested_reply !== null || result.follow_up_date !== null) {
      applied.push("unsubscribe_normalized");
    }
    result.needs_human = false;
    result.suggested_reply = null;
    result.follow_up_date = null;
  }

  if (NO_REPLY_CATEGORIES.has(result.category) && result.suggested_reply !== null) {
    result.suggested_reply = null;
    applied.push("no_reply_category_reply_removed");
  }

  return { result, applied };
}
