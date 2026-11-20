import Anthropic from "@anthropic-ai/sdk";
import { cleanReply } from "./clean.js";
import {
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_MAX_TOKENS,
  resolveConfig,
  type Effort,
} from "./config.js";
import { InvalidInputError, InvalidModelOutputError } from "./errors.js";
import { fastPathClassify } from "./fastPath.js";
import { applyGuardrails } from "./guardrails.js";
import { buildUserMessage, OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT } from "./prompt.js";
import {
  TriageInputSchema,
  TriageResultSchema,
  type TokenUsage,
  type TriageInput,
  type TriageMeta,
  type TriageOutcome,
  type TriageResult,
} from "./types.js";

export interface TriageOptions {
  /** A configured Anthropic client. Created lazily (only if the model is needed) when omitted. */
  client?: Anthropic;
  /** Model ID. Defaults to REPLY_TRIAGE_MODEL or claude-opus-5-5. */
  model?: string;
  /** Effort level. Defaults to REPLY_TRIAGE_EFFORT or "low". */
  effort?: Effort;
  /** Server-side refusal fallbacks (`fallbacks: "default"`). Defaults to on, except for Haiku models. */
  fallbacks?: boolean;
  /** Set to false to send every reply to the model (useful for evaluation). Default true. */
  fastPath?: boolean;
  /** Results below this confidence are flagged needs_human. Default 0.6. */
  lowConfidenceThreshold?: number;
  /** Cleaned replies longer than this are rejected. Default 20,000 characters. */
  maxReplyChars?: number;
  maxTokens?: number;
  /** Environment used to resolve defaults. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

const MAX_ATTEMPTS = 2;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models without server-side fallback support. */
function supportsFallbacks(model: string): boolean {
  return !/haiku/i.test(model);
}

function toReferenceDate(receivedAt: TriageInput["receivedAt"]): string {
  if (receivedAt === undefined) return new Date().toISOString().slice(0, 10);
  if (receivedAt instanceof Date) return receivedAt.toISOString().slice(0, 10);
  // Date-only strings are used as-is; datetimes are converted to their UTC date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) return receivedAt;
  return new Date(receivedAt).toISOString().slice(0, 10);
}

function emptyUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function addUsage(total: TokenUsage, usage: Anthropic.Beta.BetaUsage): void {
  total.input_tokens += usage.input_tokens ?? 0;
  total.output_tokens += usage.output_tokens ?? 0;
  total.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
}

/** Parse and validate the model's text output. Returns an error string instead of throwing. */
export function parseModelOutput(text: string): { ok: true; value: TriageResult } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "response was not valid JSON" };
  }
  const parsed = TriageResultSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: issues.join("; ") };
  }
  return { ok: true, value: parsed.data };
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function refusalResult(): TriageResult {
  return {
    category: "other",
    confidence: 0,
    summary: "The model declined to classify this reply; a person should read it.",
    follow_up_date: null,
    referral: null,
    needs_human: true,
    suggested_reply: null,
  };
}

/**
 * Triage one reply: clean it, try the deterministic fast path, otherwise ask
 * Claude for a structured result, validate it (retrying once), and apply
 * guardrails.
 */
export function triage(input: TriageInput, options: TriageOptions = {}): Promise<TriageOutcome> {
  return runTriage(input, options, () => options.client ?? new Anthropic());
}

async function runTriage(
  rawInput: TriageInput,
  options: TriageOptions,
  getClient: () => Anthropic,
): Promise<TriageOutcome> {
  const parsedInput = TriageInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    const issues = parsedInput.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new InvalidInputError(`Invalid input: ${issues.join("; ")}`, issues);
  }
  const input = parsedInput.data;
  const cleaned = cleanReply(input.reply);
  const cleaning: TriageMeta["cleaning"] = {
    quote_removed: cleaned.quoteRemoved,
    signature_removed: cleaned.signatureRemoved,
    chars: cleaned.text.length,
  };

  if (options.fastPath !== false) {
    const match = fastPathClassify(input);
    if (match) {
      return {
        ...match.result,
        meta: { source: "fast_path", rule: match.rule, model: null, attempts: 0, guardrails: [], cleaning, usage: null },
      };
    }
  }

  if (cleaned.text === "") {
    throw new InvalidInputError("Reply is empty after removing whitespace, quoted history and signature.");
  }
  const maxChars = options.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
  if (cleaned.text.length > maxChars) {
    throw new InvalidInputError(
      `Reply is ${cleaned.text.length} characters after cleaning; the limit is ${maxChars}. ` +
        "Split it or raise maxReplyChars instead of truncating.",
    );
  }

  const config = resolveConfig(options.env ?? process.env);
  const model = options.model ?? config.model;
  const effort = options.effort ?? config.effort;
  const useFallbacks = (options.fallbacks ?? config.fallbacks) && supportsFallbacks(model);
  const client = getClient();
  const referenceDate = toReferenceDate(input.receivedAt);

  const usage = emptyUsage();
  const errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userMessage = buildUserMessage({
      cleanedReply: cleaned.text,
      referenceDate,
      input,
      ...(errors.length > 0 ? { previousError: errors[errors.length - 1] } : {}),
    });

    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Thinking stays adaptive (the default); effort is the depth/cost control.
      output_config: { effort, format: { type: "json_schema", schema: OUTPUT_JSON_SCHEMA } },
      // The system prompt is static, so it is cached across requests.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
      ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    const response = await client.beta.messages.create(params);
    addUsage(usage, response.usage);

    const meta = (source: TriageMeta["source"], guardrails: string[]): TriageMeta => ({
      source,
      rule: null,
      model: response.model ?? model,
      attempts: attempt,
      guardrails,
      cleaning,
      usage: { ...usage },
    });

    // A refusal (after any server-side fallback) is not retried: route to a person.
    if (response.stop_reason === "refusal") {
      return { ...refusalResult(), meta: meta("refusal", []) };
    }

    if (response.stop_reason === "max_tokens") {
      errors.push("response was cut off at max_tokens");
      continue;
    }

    const parsed = parseModelOutput(textOf(response));
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }

    const { result, applied } = applyGuardrails(parsed.value, {
      cleanedText: cleaned.text,
      rawText: input.reply,
      referenceDate,
      lowConfidenceThreshold: options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    });
    return { ...result, meta: meta("model", applied) };
  }

  throw new InvalidModelOutputError(
    `Model output failed validation after ${MAX_ATTEMPTS} attempts: ${errors.join(" | ")}`,
    errors,
  );
}

/** Bind options once (for example a shared client) and reuse them for many replies. */
export function createTriager(options: TriageOptions = {}): (input: TriageInput) => Promise<TriageOutcome> {
  let client = options.client;
  // The client is created on first model call, so fast-path-only workloads never need credentials.
  const getClient = (): Anthropic => (client ??= new Anthropic());
  return (input) => runTriage(input, options, getClient);
}
