/**
 * Heuristics that reduce a reply to the text the sender actually wrote:
 * quoted history and signatures are removed before anything reaches the model.
 *
 * These are deliberately simple, line-based rules. They cover the common
 * Gmail / Apple Mail / Outlook layouts; anything they miss is still sent to the
 * model, which is told the text may contain leftovers.
 */

export interface CleanedReply {
  text: string;
  quoteRemoved: boolean;
  signatureRemoved: boolean;
}

/** A line that, on its own, starts the quoted history. */
const QUOTE_HEADER_LINE: RegExp[] = [
  /^On\b.{0,300}\bwrote:$/i, // Gmail / Apple Mail (English)
  /^-{2,}\s*Original Message\s*-{2,}$/i, // Outlook (plain text)
  /^-{2,}\s*Forwarded message\s*-{2,}$/i, // Gmail forward
  /^Begin forwarded message:$/i, // Apple Mail forward
  /^_{10,}$/, // Outlook separator line
  /^Le\b.{0,300}\ba écrit\s?:$/i, // French
  /^Am\b.{0,300}\bschrieb\b.{0,300}:$/i, // German
  /^El\b.{0,300}\bescribió:$/i, // Spanish
  /^Op\b.{0,300}\bschreef\b.{0,300}:$/i, // Dutch
];

/** Outlook-style header block: "From: ..." followed shortly by Sent/Date/To/Subject. */
const OUTLOOK_FROM = /^\*?(From|Von|De|Van):\*?\s/i;
const OUTLOOK_FOLLOWUP = /^\*?(Sent|Date|To|Subject|Gesendet|Datum|Envoyé|Verzonden):\*?\s/i;

/** "Sent from my iPhone" style footers. Everything from here down is dropped. */
const MOBILE_FOOTER = /^(Sent from my \w+|Sent from (Outlook|Mail|Yahoo Mail)\b|Get Outlook for (iOS|Android))/i;

/** RFC 3676 signature delimiter ("-- "), plus the common "--" variant. */
const SIG_DELIMITER = /^--\s?$/;

/** A sign-off line on its own ("Best,", "Thanks!", "Kind regards"). */
const SIGN_OFF =
  /^(best|best regards|best wishes|kind regards|warm regards|regards|many thanks|thanks|thanks again|thank you|thx|cheers|sincerely|all the best|talk soon|br|mvg|met vriendelijke groet|mit freundlichen grüßen|viele grüße|cordialement)[\s,.!]*$/i;

/** Lines after a sign-off that still look like a signature block. */
const MAX_SIGNATURE_LINES = 6;
const MAX_SIGNATURE_LINE_CHARS = 80;

function firstQuoteLineIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (QUOTE_HEADER_LINE.some((re) => re.test(line))) return i;

    // Gmail wraps long "On ... wrote:" attributions over two lines.
    if (/^(On|Le|Am|El|Op)\b/i.test(line)) {
      const joined = `${line} ${(lines[i + 1] ?? "").trim()}`;
      if (QUOTE_HEADER_LINE.some((re) => re.test(joined))) return i;
    }

    if (OUTLOOK_FROM.test(line)) {
      for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
        if (OUTLOOK_FOLLOWUP.test((lines[j] ?? "").trim())) return i;
      }
    }
  }
  return -1;
}

/** Remove quoted history: attribution lines and everything after them, and ">" lines. */
export function stripQuotedText(text: string): { text: string; removed: boolean } {
  let lines = normalizeNewlines(text).split("\n");
  let removed = false;

  const cut = firstQuoteLineIndex(lines);
  if (cut >= 0) {
    lines = lines.slice(0, cut);
    removed = true;
  }

  const unquoted = lines.filter((line) => !/^\s*>/.test(line));
  if (unquoted.length !== lines.length) removed = true;

  return { text: tidy(unquoted.join("\n")), removed };
}

/** Remove a trailing signature block. Never removes the only remaining content. */
export function stripSignature(text: string): { text: string; removed: boolean } {
  const lines = normalizeNewlines(text).split("\n");

  // 1. Hard cut points: "-- " delimiter or a mobile footer (after some content).
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if ((SIG_DELIMITER.test(lines[i] ?? "") || MOBILE_FOOTER.test(line)) && hasContent(lines.slice(0, i))) {
      const head = tidy(lines.slice(0, i).join("\n"));
      // A sign-off may sit right above the delimiter; strip it too.
      return { text: stripSignOff(head).text, removed: true };
    }
  }

  // 2. Soft cut: a sign-off line followed only by a short signature block.
  return stripSignOff(tidy(lines.join("\n")));
}

function stripSignOff(text: string): { text: string; removed: boolean } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!SIGN_OFF.test(line)) continue;

    const tail = lines.slice(i + 1).filter((l) => l.trim() !== "");
    const head = lines.slice(0, i);
    const looksLikeSignature =
      tail.length <= MAX_SIGNATURE_LINES &&
      tail.every((l) => l.trim().length <= MAX_SIGNATURE_LINE_CHARS) &&
      !tail.some((l) => /^\s*P\.?\s?S\b/i.test(l));

    if (looksLikeSignature && hasContent(head)) {
      return { text: tidy(head.join("\n")), removed: true };
    }
    // Only consider the last sign-off; an earlier "Thanks," is part of the body.
    break;
  }
  return { text, removed: false };
}

/**
 * Full cleaning pipeline: quoted history first, then the signature.
 * If cleaning would leave nothing (for example a bare forward), the original
 * trimmed text is returned instead so no content is silently lost.
 */
export function cleanReply(raw: string): CleanedReply {
  const quote = stripQuotedText(raw);
  const sig = stripSignature(quote.text);
  if (sig.text.trim() === "") {
    return { text: tidy(normalizeNewlines(raw)), quoteRemoved: false, signatureRemoved: false };
  }
  return { text: sig.text, quoteRemoved: quote.removed, signatureRemoved: sig.removed };
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function hasContent(lines: string[]): boolean {
  return lines.some((l) => l.trim() !== "");
}

/** Trim trailing whitespace per line, collapse 3+ blank lines, trim the whole text. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
