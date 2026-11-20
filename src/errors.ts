/** Base class for errors raised by reply-triage itself (not by the Anthropic SDK). */
export class ReplyTriageError extends Error {
  override name = "ReplyTriageError";
}

/** The caller passed input we refuse to process (bad shape, too long). */
export class InvalidInputError extends ReplyTriageError {
  override name = "InvalidInputError";
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** The model returned output that failed validation twice in a row. */
export class InvalidModelOutputError extends ReplyTriageError {
  override name = "InvalidModelOutputError";
  constructor(
    message: string,
    /** One validation error message per attempt. */
    readonly attemptErrors: string[],
  ) {
    super(message);
  }
}
