import type Anthropic from "@anthropic-ai/sdk";
import { vi } from "vitest";
import type { TriageResult } from "../src/types.js";

export const validResult = (overrides: Partial<TriageResult> = {}): TriageResult => ({
  category: "interested",
  confidence: 0.9,
  summary: "They want to try the product.",
  follow_up_date: null,
  referral: null,
  needs_human: false,
  suggested_reply: "Thanks! I'll send over the details today.",
  ...overrides,
});

type FakeMessage = {
  text?: string;
  stop_reason?: Anthropic.Beta.BetaStopReason;
  model?: string;
};

/** Builds a minimal BetaMessage-shaped object; only the fields the classifier reads. */
export function fakeMessage({ text = "", stop_reason = "end_turn", model = "claude-opus-5-5" }: FakeMessage = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text },
    ],
    stop_reason,
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

export const jsonMessage = (result: unknown) => fakeMessage({ text: JSON.stringify(result) });

/** A fake Anthropic client whose beta.messages.create returns the given responses in order. */
export function mockClient(...responses: Array<Anthropic.Beta.BetaMessage | Error>) {
  const queue = [...responses];
  const create = vi.fn(async (_params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
    const next = queue.shift();
    if (!next) throw new Error("mock client: no more responses queued");
    if (next instanceof Error) throw next;
    return next;
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create };
}
