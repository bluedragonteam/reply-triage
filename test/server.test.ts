import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidInputError, InvalidModelOutputError } from "../src/errors.js";
import { createTriageServer } from "../src/server.js";
import type { TriageInput, TriageOutcome } from "../src/types.js";
import { validResult } from "./helpers.js";

const outcome: TriageOutcome = {
  ...validResult(),
  meta: {
    source: "model",
    rule: null,
    model: "claude-opus-5-5",
    attempts: 1,
    guardrails: [],
    cleaning: { quote_removed: false, signature_removed: false, chars: 5 },
    usage: null,
  },
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(triage: (input: TriageInput) => Promise<TriageOutcome>, maxBodyBytes?: number) {
  server = createTriageServer({ triage, onError: () => {}, ...(maxBodyBytes ? { maxBodyBytes } : {}) });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const post = (url: string, body: string, contentType = "application/json") =>
  fetch(`${url}/triage`, { method: "POST", headers: { "content-type": contentType }, body });

describe("HTTP server", () => {
  it("triages a valid request", async () => {
    const triage = vi.fn(async () => outcome);
    const url = await start(triage);
    const res = await post(url, JSON.stringify({ reply: "Sounds good", subject: "Re: hi", receivedAt: "2026-11-02" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(outcome);
    expect(triage).toHaveBeenCalledWith({ reply: "Sounds good", subject: "Re: hi", receivedAt: "2026-11-02" });
  });

  it("answers health checks", async () => {
    const url = await start(vi.fn());
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects bodies over the size limit with 413", async () => {
    const triage = vi.fn(async () => outcome);
    const url = await start(triage, 1024);
    const res = await post(url, JSON.stringify({ reply: "x".repeat(5000) }));
    expect(res.status).toBe(413);
    expect(triage).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{nope", "application/json", 400],
    ["missing reply", JSON.stringify({ subject: "hi" }), "application/json", 400],
    ["unknown field", JSON.stringify({ reply: "hi", extra: true }), "application/json", 400],
    ["empty reply", JSON.stringify({ reply: "  " }), "application/json", 400],
    ["wrong content type", "reply=hi", "application/x-www-form-urlencoded", 415],
  ])("returns an error for %s", async (_label, body, contentType, status) => {
    const triage = vi.fn(async () => outcome);
    const url = await start(triage);
    const res = await post(url, body, contentType);
    expect(res.status).toBe(status);
    expect(await res.json()).toHaveProperty("error");
    expect(triage).not.toHaveBeenCalled();
  });

  it("returns 404 and 405 for other routes and methods", async () => {
    const url = await start(vi.fn());
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    const res = await fetch(`${url}/triage`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("maps library errors to 400 and 502 without leaking details", async () => {
    const badInput = await start(async () => {
      throw new InvalidInputError("Reply is 30000 characters after cleaning; the limit is 20000.");
    });
    expect((await post(badInput, JSON.stringify({ reply: "hi" }))).status).toBe(400);
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const badOutput = await start(async () => {
      throw new InvalidModelOutputError("secret details", ["x"]);
    });
    const res = await post(badOutput, JSON.stringify({ reply: "hi" }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("returns 500 for unexpected errors", async () => {
    const url = await start(async () => {
      throw new Error("boom");
    });
    const res = await post(url, JSON.stringify({ reply: "hi" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});
