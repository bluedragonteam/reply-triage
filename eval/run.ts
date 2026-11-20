/**
 * Runs the classifier over eval/dataset.jsonl and reports accuracy,
 * per-category precision/recall and a confusion matrix.
 *
 *   npm run eval -- [--limit N] [--concurrency N] [--model ID] [--effort LEVEL] [--no-fast-path]
 *
 * Calls the real Claude API (except for fast-path rows), so it needs
 * ANTHROPIC_API_KEY and costs a small amount of money per run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { createTriager, type TriageOptions } from "../src/classifier.js";
import { isEffort, resolveConfig } from "../src/config.js";
import type { TriageOutcome } from "../src/types.js";
import { DEFAULT_RECEIVED_AT, loadDataset, type DatasetRow } from "./dataset.js";
import { computeMetrics, formatConsole, formatMarkdownTables, type Prediction } from "./metrics.js";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    dataset: { type: "string", default: join(here, "dataset.jsonl") },
    outbound: { type: "string", default: join(here, "outbound.txt") },
    "out-dir": { type: "string", default: join(here, "results") },
    concurrency: { type: "string", default: "4" },
    limit: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    "no-fast-path": { type: "boolean", default: false },
  },
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. The eval calls the real Claude API; copy .env.example to .env and run:");
  console.error("  node --env-file=.env --import tsx eval/run.ts   (or export the variable and run `npm run eval`)");
  process.exit(2);
}

if (values.effort !== undefined && !isEffort(values.effort)) {
  console.error(`--effort must be low, medium, high, xhigh or max`);
  process.exit(2);
}

interface RowResult {
  row: DatasetRow;
  predicted: Prediction;
  outcome: TriageOutcome | null;
  error: string | null;
  ms: number;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function fieldChecks(results: RowResult[]): { name: string; passed: number; total: number; failures: string[] }[] {
  const checks = [
    {
      name: "follow_up_date present when the reply names a time",
      applies: (r: RowResult) => r.row.expect_follow_up === true,
      ok: (r: RowResult) => r.outcome?.follow_up_date != null,
    },
    {
      name: "follow_up_date exact match",
      applies: (r: RowResult) => r.row.expect_follow_up_date !== undefined,
      ok: (r: RowResult) => r.outcome?.follow_up_date === r.row.expect_follow_up_date,
    },
    {
      name: "referral email extracted",
      applies: (r: RowResult) => r.row.expect_referral_email !== undefined,
      ok: (r: RowResult) => r.outcome?.referral?.email?.toLowerCase() === r.row.expect_referral_email?.toLowerCase(),
    },
    {
      name: "no suggested_reply for unsubscribe / auto_reply / bounce",
      applies: (r: RowResult) => ["unsubscribe", "auto_reply", "bounce"].includes(r.predicted),
      ok: (r: RowResult) => r.outcome?.suggested_reply === null,
    },
    {
      name: "unsubscribe never needs_human",
      applies: (r: RowResult) => r.predicted === "unsubscribe",
      ok: (r: RowResult) => r.outcome?.needs_human === false,
    },
  ];
  return checks.map((c) => {
    const applicable = results.filter((r) => r.outcome && c.applies(r));
    const failures = applicable.filter((r) => !c.ok(r)).map((r) => r.row.id);
    return { name: c.name, passed: applicable.length - failures.length, total: applicable.length, failures };
  });
}

async function main(): Promise<void> {
  let rows = await loadDataset(values.dataset);
  if (values.limit) rows = rows.slice(0, Number(values.limit));
  const outbound = await readFile(values.outbound, "utf8");

  const config = resolveConfig();
  const options: TriageOptions = { client: new Anthropic() };
  if (values.model) options.model = values.model;
  if (values.effort && isEffort(values.effort)) options.effort = values.effort;
  if (values["no-fast-path"]) options.fastPath = false;
  const model = options.model ?? config.model;
  const effort = options.effort ?? config.effort;
  const triage = createTriager(options);

  console.log(`Evaluating ${rows.length} replies with ${model} (effort ${effort}, fast path ${options.fastPath === false ? "off" : "on"})...\n`);
  const started = Date.now();

  const results = await mapWithConcurrency(rows, Math.max(1, Number(values.concurrency)), async (row): Promise<RowResult> => {
    const t0 = Date.now();
    try {
      const outcome = await triage({
        reply: row.reply,
        originalEmail: row.original ?? outbound,
        receivedAt: row.received_at ?? DEFAULT_RECEIVED_AT,
        ...(row.subject !== undefined ? { subject: row.subject } : {}),
        ...(row.from !== undefined ? { from: row.from } : {}),
        ...(row.headers !== undefined ? { headers: row.headers } : {}),
      });
      const mark = outcome.category === row.expected ? "ok  " : "MISS";
      console.log(`${mark} ${row.id.padEnd(8)} expected ${row.expected.padEnd(16)} got ${outcome.category} (${outcome.meta.source})`);
      return { row, predicted: outcome.category, outcome, error: null, ms: Date.now() - t0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`ERR  ${row.id.padEnd(8)} ${message}`);
      return { row, predicted: "error", outcome: null, error: message, ms: Date.now() - t0 };
    }
  });

  const metrics = computeMetrics(results.map((r) => ({ id: r.row.id, expected: r.row.expected, predicted: r.predicted })));
  const checks = fieldChecks(results);
  const usage = results.reduce(
    (acc, r) => {
      const u = r.outcome?.meta.usage;
      if (u) {
        acc.input += u.input_tokens;
        acc.output += u.output_tokens;
        acc.cacheRead += u.cache_read_input_tokens;
        acc.cacheWrite += u.cache_creation_input_tokens;
      }
      if (r.outcome?.meta.source === "fast_path") acc.fastPath += 1;
      acc.guardrails += r.outcome?.meta.guardrails.length ? 1 : 0;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fastPath: 0, guardrails: 0 },
  );

  console.log(`\n${formatConsole(metrics)}\n`);
  for (const c of checks) {
    console.log(`${c.name}: ${c.passed}/${c.total}${c.failures.length ? `  (failed: ${c.failures.join(", ")})` : ""}`);
  }
  console.log(
    `\nFast path: ${usage.fastPath}/${rows.length} rows. Tokens: ${usage.input} input, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write, ${usage.output} output.`,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir(values["out-dir"], { recursive: true });
  const reportPath = join(values["out-dir"], `report-${stamp}.md`);
  const rowsPath = join(values["out-dir"], `results-${stamp}.jsonl`);

  const misses = results.filter((r) => r.predicted !== r.row.expected);
  const report = [
    `# reply-triage evaluation`,
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Model: \`${model}\`, effort \`${effort}\`, fast path ${options.fastPath === false ? "off" : "on"}`,
    `- Dataset: \`${relative(process.cwd(), values.dataset)}\` (${rows.length} rows, synthetic)`,
    `- Wall time: ${((Date.now() - started) / 1000).toFixed(1)} s`,
    `- Tokens: ${usage.input} input, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write, ${usage.output} output`,
    `- Fast-path rows (no API call): ${usage.fastPath}; rows where a guardrail changed the output: ${usage.guardrails}`,
    "",
    "## Classification",
    "",
    formatMarkdownTables(metrics),
    "",
    "## Field checks",
    "",
    "| Check | Passed |",
    "|---|---:|",
    ...checks.map((c) => `| ${c.name} | ${c.passed}/${c.total}${c.failures.length ? ` (failed: ${c.failures.join(", ")})` : ""} |`),
    "",
    "## Misclassified rows",
    "",
    misses.length === 0
      ? "None."
      : [
          "| id | expected | predicted | confidence | summary |",
          "|---|---|---|---:|---|",
          ...misses.map(
            (r) =>
              `| ${r.row.id} | ${r.row.expected} | ${r.predicted} | ${r.outcome ? r.outcome.confidence.toFixed(2) : "–"} | ${(r.outcome?.summary ?? r.error ?? "").replace(/\|/g, "\\|")} |`,
          ),
        ].join("\n"),
    "",
  ].join("\n");

  await writeFile(reportPath, report, "utf8");
  await writeFile(
    rowsPath,
    results.map((r) => JSON.stringify({ id: r.row.id, expected: r.row.expected, predicted: r.predicted, ms: r.ms, error: r.error, outcome: r.outcome })).join("\n") + "\n",
    "utf8",
  );
  console.log(`\nWrote ${relative(process.cwd(), reportPath)} and ${relative(process.cwd(), rowsPath)}`);
}

await main();
