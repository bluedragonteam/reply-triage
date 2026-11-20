/**
 * Defaults and environment handling. Every setting can also be passed in code.
 *
 *   REPLY_TRIAGE_MODEL       model ID (default: claude-opus-5-5)
 *   REPLY_TRIAGE_EFFORT      low | medium | high | xhigh | max (default: low)
 *   REPLY_TRIAGE_FALLBACKS   "default" to enable server-side refusal fallbacks, "off" to disable (default: default)
 *   ANTHROPIC_API_KEY        read by the Anthropic SDK itself
 */

export const DEFAULT_MODEL = "claude-opus-5-5";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Classification is a short, well-specified task; low effort keeps latency and cost down. */
export const DEFAULT_EFFORT: Effort = "low";

/** Enough room for adaptive thinking plus a JSON object with a short draft reply. */
export const DEFAULT_MAX_TOKENS = 4096;

export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Cleaned replies longer than this are rejected rather than silently truncated. */
export const DEFAULT_MAX_REPLY_CHARS = 20_000;

export interface ResolvedConfig {
  model: string;
  effort: Effort;
  fallbacks: boolean;
}

export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const model = env.REPLY_TRIAGE_MODEL?.trim() || DEFAULT_MODEL;

  const rawEffort = env.REPLY_TRIAGE_EFFORT?.trim().toLowerCase();
  if (rawEffort && !isEffort(rawEffort)) {
    throw new Error(`REPLY_TRIAGE_EFFORT must be one of ${EFFORT_LEVELS.join(", ")} (got "${rawEffort}")`);
  }

  const rawFallbacks = env.REPLY_TRIAGE_FALLBACKS?.trim().toLowerCase();
  if (rawFallbacks && rawFallbacks !== "default" && rawFallbacks !== "off") {
    throw new Error(`REPLY_TRIAGE_FALLBACKS must be "default" or "off" (got "${rawFallbacks}")`);
  }

  return {
    model,
    effort: (rawEffort as Effort | undefined) ?? DEFAULT_EFFORT,
    fallbacks: rawFallbacks !== "off",
  };
}
