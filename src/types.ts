import { z } from "zod";

/** Every category a reply can be triaged into. Order is used for reports. */
export const CATEGORIES = [
  "interested",
  "question",
  "meeting_request",
  "not_now",
  "not_interested",
  "unsubscribe",
  "referral",
  "auto_reply",
  "bounce",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Categories for which a suggested reply must never be produced. */
export const NO_REPLY_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "unsubscribe",
  "auto_reply",
  "bounce",
]);

export const ReferralSchema = z
  .object({
    name: z.string().trim().min(1).nullable(),
    email: z.email().nullable(),
  })
  .strict();

export type Referral = z.infer<typeof ReferralSchema>;

/** The validated triage result. Field names are snake_case to match the JSON output. */
export const TriageResultSchema = z
  .object({
    category: z.enum(CATEGORIES),
    confidence: z.number().min(0).max(1),
    summary: z.string().trim().min(1).max(500),
    follow_up_date: z.iso.date().nullable(),
    referral: ReferralSchema.nullable(),
    needs_human: z.boolean(),
    suggested_reply: z.string().trim().min(1).max(2000).nullable(),
  })
  .strict();

export type TriageResult = z.infer<typeof TriageResultSchema>;

const MAX_FIELD_CHARS = 100_000;

/** Input accepted by the library, the CLI and the HTTP endpoint. */
export const TriageInputSchema = z
  .object({
    /** The raw reply body (plain text). Quoted history and signatures are stripped automatically. */
    reply: z.string().max(MAX_FIELD_CHARS),
    subject: z.string().max(2_000).optional(),
    /** Sender address or "Name <address>". */
    from: z.string().max(1_000).optional(),
    /** The outbound email this is a reply to. Used as context only. */
    originalEmail: z.string().max(MAX_FIELD_CHARS).optional(),
    /** Raw message headers, if you have them. Keys are matched case-insensitively. */
    headers: z.record(z.string(), z.string().max(10_000)).optional(),
    /** When the reply was received; used to resolve relative dates. Defaults to now. */
    receivedAt: z.union([z.iso.datetime({ offset: true }), z.iso.date(), z.date()]).optional(),
  })
  .strict();

export type TriageInput = z.input<typeof TriageInputSchema>;

export type TriageSource = "fast_path" | "model" | "refusal";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface TriageMeta {
  /** Where the result came from: a deterministic rule, the model, or a model refusal. */
  source: TriageSource;
  /** Which fast-path rule matched, if any. */
  rule: string | null;
  /** Model ID used, or null when no API call was made. */
  model: string | null;
  /** Number of API calls made (0 for the fast path, at most 2). */
  attempts: number;
  /** Deterministic guardrails that changed the model's output. */
  guardrails: string[];
  cleaning: {
    quote_removed: boolean;
    signature_removed: boolean;
    /** Characters of reply text actually considered after cleaning. */
    chars: number;
  };
  usage: TokenUsage | null;
}

export type TriageOutcome = TriageResult & { meta: TriageMeta };
