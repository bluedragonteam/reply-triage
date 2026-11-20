import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createTriager } from "./classifier.js";
import { InvalidInputError, InvalidModelOutputError } from "./errors.js";
import { TriageInputSchema, type TriageInput, type TriageOutcome } from "./types.js";

export interface TriageServerOptions {
  /** The triage function to call. Defaults to a shared-client triager. */
  triage?: (input: TriageInput) => Promise<TriageOutcome>;
  /** Maximum request body size in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** Called for unexpected errors. Default: console.error. */
  onError?: (err: unknown) => void;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, `request body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        // Stop buffering; the 413 response closes the connection.
        req.pause();
        reject(new HttpError(413, `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/**
 * A minimal HTTP wrapper: `POST /triage` with a JSON body matching TriageInput,
 * and `GET /healthz`. It has no authentication of its own; run it on a private
 * network or behind your gateway.
 */
export function createTriageServer(options: TriageServerOptions = {}): Server {
  const triage = options.triage ?? createTriager();
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const onError = options.onError ?? ((err: unknown) => console.error(err));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname !== "/triage") throw new HttpError(404, "not found");
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "method not allowed");
      }
      const contentType = req.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(contentType)) {
        throw new HttpError(415, "content-type must be application/json");
      }

      const raw = await readBody(req, limit);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "body is not valid JSON");
      }

      const parsed = TriageInputSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid request body",
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        );
      }
      if (parsed.data.reply.trim() === "") throw new HttpError(400, "reply must not be empty");

      const outcome = await triage(parsed.data);
      sendJson(res, 200, outcome);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("connection", "close");
        sendJson(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
      } else if (err instanceof InvalidInputError) {
        sendJson(res, 400, { error: err.message });
      } else if (err instanceof InvalidModelOutputError) {
        onError(err);
        sendJson(res, 502, { error: "model output failed validation" });
      } else if (err instanceof Anthropic.RateLimitError) {
        sendJson(res, 503, { error: "upstream rate limited, retry later" });
      } else if (err instanceof Anthropic.APIError) {
        onError(err);
        sendJson(res, 502, { error: "upstream model API error" });
      } else {
        onError(err);
        sendJson(res, 500, { error: "internal error" });
      }
    }
  });
}
