import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { triage as defaultTriage, type TriageOptions } from "./classifier.js";
import { EFFORT_LEVELS, isEffort } from "./config.js";
import { InvalidInputError, InvalidModelOutputError } from "./errors.js";
import type { TriageInput, TriageOutcome } from "./types.js";

export const USAGE = `Usage: reply-triage [options] < reply.txt
       reply-triage --file reply.txt [options]

Classifies a reply to an outbound sales email and prints JSON.

Options:
  -f, --file <path>       Read the reply body from a file instead of stdin
  -s, --subject <text>    Subject line of the reply
      --from <address>    Sender, e.g. "Ana Ruiz <ana@example.com>"
  -o, --original <path>   File containing the original outbound email (context)
  -H, --header <k: v>     Raw header, repeatable (e.g. -H "Auto-Submitted: auto-replied")
      --date <YYYY-MM-DD> Date the reply was received (default: today)
      --model <id>        Model ID (default: $REPLY_TRIAGE_MODEL or claude-opus-5-5)
      --effort <level>    ${EFFORT_LEVELS.join(" | ")} (default: low)
      --no-fast-path      Always call the model, even for obvious auto-replies
      --compact           Print single-line JSON
  -h, --help              Show this help
  -v, --version           Show the version

Exit codes: 0 success, 1 triage failed, 2 usage error.
`;

export interface CliIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** Injected for tests; defaults to the real classifier. */
  triage?: (input: TriageInput, options: TriageOptions) => Promise<TriageOutcome>;
  version?: string;
}

class UsageError extends Error {}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf(":");
    if (idx <= 0) throw new UsageError(`--header must look like "Name: value" (got "${value}")`);
    headers[value.slice(0, idx).trim()] = value.slice(idx + 1).trim();
  }
  return headers;
}

/** Runs the CLI and returns the process exit code. Never calls process.exit itself. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        file: { type: "string", short: "f" },
        subject: { type: "string", short: "s" },
        from: { type: "string" },
        original: { type: "string", short: "o" },
        header: { type: "string", short: "H", multiple: true },
        date: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "no-fast-path": { type: "boolean" },
        compact: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }));
  } catch (err) {
    io.stderr.write(`error: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${io.version ?? "unknown"}\n`);
    return 0;
  }

  try {
    if (values.effort !== undefined && !isEffort(values.effort)) {
      throw new UsageError(`--effort must be one of ${EFFORT_LEVELS.join(", ")}`);
    }
    if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
      throw new UsageError("--date must be YYYY-MM-DD");
    }

    let reply: string;
    if (values.file !== undefined) {
      reply = await readFile(values.file, "utf8").catch((err: NodeJS.ErrnoException) => {
        throw new UsageError(`cannot read --file ${values.file}: ${err.code ?? err.message}`);
      });
    } else if (io.stdin.isTTY) {
      throw new UsageError("no input: pipe a reply on stdin or pass --file");
    } else {
      reply = await readStream(io.stdin);
    }
    if (reply.trim() === "") throw new UsageError("the reply is empty");

    const input: TriageInput = { reply };
    if (values.subject !== undefined) input.subject = values.subject;
    if (values.from !== undefined) input.from = values.from;
    if (values.date !== undefined) input.receivedAt = values.date;
    if (values.header?.length) input.headers = parseHeaders(values.header);
    if (values.original !== undefined) {
      input.originalEmail = await readFile(values.original, "utf8").catch((err: NodeJS.ErrnoException) => {
        throw new UsageError(`cannot read --original ${values.original}: ${err.code ?? err.message}`);
      });
    }

    const options: TriageOptions = {};
    if (values.model !== undefined) options.model = values.model;
    if (values.effort !== undefined && isEffort(values.effort)) options.effort = values.effort;
    if (values["no-fast-path"]) options.fastPath = false;

    const outcome = await (io.triage ?? defaultTriage)(input, options);
    io.stdout.write(`${JSON.stringify(outcome, null, values.compact ? undefined : 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr.write(`error: ${describeError(err)}\n`);
    return 1;
  }
}

function describeError(err: unknown): string {
  if (err instanceof InvalidInputError || err instanceof InvalidModelOutputError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) {
    return "authentication failed; set ANTHROPIC_API_KEY (see .env.example)";
  }
  if (err instanceof Anthropic.RateLimitError) return "rate limited by the Anthropic API; try again shortly";
  if (err instanceof Anthropic.APIError) return `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
