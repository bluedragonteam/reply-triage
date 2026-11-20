import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli, USAGE, type CliIO } from "../src/cli.js";
import { InvalidModelOutputError } from "../src/errors.js";
import type { TriageOutcome } from "../src/types.js";
import { validResult } from "./helpers.js";

const outcome: TriageOutcome = {
  ...validResult(),
  meta: {
    source: "model",
    rule: null,
    model: "claude-opus-5-5",
    attempts: 1,
    guardrails: [],
    cleaning: { quote_removed: false, signature_removed: false, chars: 10 },
    usage: null,
  },
};

function io(stdinText: string | null, triage = vi.fn(async () => outcome)) {
  let out = "";
  let err = "";
  const stdin = Object.assign(Readable.from(stdinText === null ? [] : [Buffer.from(stdinText)]), {
    isTTY: stdinText === null,
  });
  const cliIO: CliIO = {
    stdin,
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    triage,
    version: "0.1.0",
  };
  return { cliIO, triage, out: () => out, err: () => err };
}

describe("runCli", () => {
  it("reads the reply from stdin and prints pretty JSON", async () => {
    const t = io("Sounds good!");
    expect(await runCli([], t.cliIO)).toBe(0);
    expect(t.triage).toHaveBeenCalledWith({ reply: "Sounds good!" }, {});
    expect(JSON.parse(t.out())).toEqual(outcome);
    expect(t.out()).toContain('\n  "category"');
  });

  it("supports --file, --subject, --from, --header, --date, --original and model options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reply-triage-"));
    const replyPath = join(dir, "reply.txt");
    const originalPath = join(dir, "original.txt");
    await writeFile(replyPath, "Let's talk Tuesday.");
    await writeFile(originalPath, "Hi, would a call help?");

    const t = io(null);
    const code = await runCli(
      [
        "--file", replyPath,
        "-s", "Re: hello",
        "--from", "Sam <sam@example.com>",
        "-H", "Auto-Submitted: no",
        "-H", "X-Test: a:b",
        "--date", "2026-11-02",
        "-o", originalPath,
        "--model", "claude-sonnet-5-5",
        "--effort", "medium",
        "--no-fast-path",
        "--compact",
      ],
      t.cliIO,
    );
    expect(code).toBe(0);
    expect(t.triage).toHaveBeenCalledWith(
      {
        reply: "Let's talk Tuesday.",
        subject: "Re: hello",
        from: "Sam <sam@example.com>",
        receivedAt: "2026-11-02",
        headers: { "Auto-Submitted": "no", "X-Test": "a:b" },
        originalEmail: "Hi, would a call help?",
      },
      { model: "claude-sonnet-5-5", effort: "medium", fastPath: false },
    );
    expect(t.out().trim().split("\n")).toHaveLength(1); // --compact
  });

  it("prints help and version", async () => {
    const help = io(null);
    expect(await runCli(["--help"], help.cliIO)).toBe(0);
    expect(help.out()).toBe(USAGE);

    const version = io(null);
    expect(await runCli(["-v"], version.cliIO)).toBe(0);
    expect(version.out()).toBe("0.1.0\n");
  });

  it.each([
    [["--bogus"], "Unknown option"],
    [["positional"], "positional"],
    [["--effort", "turbo"], "--effort must be one of"],
    [["--date", "March 3"], "--date must be YYYY-MM-DD"],
    [["-H", "no-colon"], '--header must look like "Name: value"'],
    [["--file", "/definitely/not/here.txt"], "cannot read --file"],
  ])("exits 2 on usage error %j", async (args, message) => {
    const t = io("hello");
    expect(await runCli(args, t.cliIO)).toBe(2);
    expect(t.err()).toContain(message);
    expect(t.triage).not.toHaveBeenCalled();
  });

  it("exits 2 when stdin is a terminal and no file is given", async () => {
    const t = io(null);
    expect(await runCli([], t.cliIO)).toBe(2);
    expect(t.err()).toContain("no input");
  });

  it("exits 2 on an empty reply", async () => {
    const t = io("   \n");
    expect(await runCli([], t.cliIO)).toBe(2);
    expect(t.err()).toContain("empty");
  });

  it("exits 1 and prints the message when triage fails", async () => {
    const t = io(
      "hello",
      vi.fn(async () => {
        throw new InvalidModelOutputError("Model output failed validation after 2 attempts", ["a", "b"]);
      }),
    );
    expect(await runCli([], t.cliIO)).toBe(1);
    expect(t.err()).toContain("failed validation");
    expect(t.out()).toBe("");
  });
});
