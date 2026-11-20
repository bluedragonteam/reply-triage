import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cleanReply } from "../src/clean.js";
import { fastPathClassify } from "../src/fastPath.js";
import { CATEGORIES } from "../src/types.js";
import { loadDataset, parseDataset } from "../eval/dataset.js";
import { computeMetrics, formatConsole, formatMarkdownTables } from "../eval/metrics.js";

const datasetUrl = new URL("../eval/dataset.jsonl", import.meta.url);

describe("computeMetrics", () => {
  it("computes accuracy, precision, recall and the confusion matrix", () => {
    const m = computeMetrics([
      { id: "1", expected: "interested", predicted: "interested" },
      { id: "2", expected: "interested", predicted: "question" },
      { id: "3", expected: "question", predicted: "question" },
      { id: "4", expected: "unsubscribe", predicted: "error" },
    ]);
    expect(m.total).toBe(4);
    expect(m.correct).toBe(2);
    expect(m.errors).toBe(1);
    expect(m.accuracy).toBe(0.5);

    const by = Object.fromEntries(m.perCategory.map((c) => [c.category, c]));
    expect(by.interested).toMatchObject({ support: 2, predicted: 1, precision: 1, recall: 0.5 });
    expect(by.interested!.f1).toBeCloseTo(2 / 3);
    expect(by.question).toMatchObject({ support: 1, predicted: 2, precision: 0.5, recall: 1 });
    expect(by.unsubscribe).toMatchObject({ support: 1, predicted: 0, precision: null, recall: 0 });
    expect(by.bounce).toMatchObject({ support: 0, precision: null, recall: null, f1: null });

    const row = CATEGORIES.indexOf("interested");
    expect(m.confusion[row]![m.columns.indexOf("question")]).toBe(1);
    expect(m.confusion[CATEGORIES.indexOf("unsubscribe")]![m.columns.indexOf("error")]).toBe(1);
    // Macro-F1 averages only categories present in the dataset.
    expect(m.macroF1).toBeCloseTo((2 / 3 + 2 / 3 + 0) / 3);
  });

  it("renders console and markdown output", () => {
    const m = computeMetrics([{ id: "1", expected: "bounce", predicted: "bounce" }]);
    expect(formatConsole(m)).toContain("Accuracy: 100.0% (1/1)");
    const md = formatMarkdownTables(m);
    expect(md).toContain("| `bounce` | 1 | 1 | 100.0% | 100.0% | 100.0% |");
    expect(md).toContain("Confusion matrix");
  });
});

describe("eval dataset", () => {
  it("parses, has unique ids and covers every category", async () => {
    const rows = await loadDataset(datasetUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const covered = new Set(rows.map((r) => r.expected));
    for (const category of CATEGORIES) expect(covered).toContain(category);
  });

  it("uses only reserved example domains", async () => {
    const text = await readFile(datasetUrl, "utf8");
    const domains = [...text.matchAll(/@([a-z0-9.-]+\.[a-z]+)/gi)].map((m) => m[1]!.toLowerCase());
    for (const domain of domains) expect(domain).toMatch(/(^|\.)example\.(com|org|net)$/);
  });

  it("agrees with the fast path on the rows the fast path handles", async () => {
    const rows = parseDataset(await readFile(datasetUrl, "utf8"));
    for (const row of rows) {
      const match = fastPathClassify({
        reply: row.reply,
        ...(row.subject !== undefined ? { subject: row.subject } : {}),
        ...(row.from !== undefined ? { from: row.from } : {}),
        ...(row.headers !== undefined ? { headers: row.headers } : {}),
      });
      if (match) expect(match.result.category, row.id).toBe(row.expected);
    }
  });

  it("never strips a dataset reply down to nothing", async () => {
    const rows = parseDataset(await readFile(datasetUrl, "utf8"));
    for (const row of rows) expect(cleanReply(row.reply).text.length, row.id).toBeGreaterThan(0);
  });

  it("rejects malformed rows", () => {
    expect(() => parseDataset('{"id":"a","expected":"nope","reply":"x"}')).toThrow(/line 1/);
    expect(() => parseDataset('{"id":"a","expected":"other","reply":"x"}\n{"id":"a","expected":"other","reply":"y"}')).toThrow(/duplicate/);
  });
});
