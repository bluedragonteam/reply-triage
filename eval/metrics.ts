import { CATEGORIES, type Category } from "../src/types.js";

/** A prediction can also be an error (the call failed or output never validated). */
export type Prediction = Category | "error";

export interface EvalRow {
  id: string;
  expected: Category;
  predicted: Prediction;
}

export interface CategoryMetrics {
  category: Category;
  /** Number of rows whose expected label is this category. */
  support: number;
  /** Number of rows predicted as this category. */
  predicted: number;
  truePositives: number;
  /** null when nothing was predicted as this category. */
  precision: number | null;
  /** null when no row expects this category. */
  recall: number | null;
  f1: number | null;
}

export interface Metrics {
  total: number;
  correct: number;
  errors: number;
  accuracy: number;
  macroF1: number | null;
  perCategory: CategoryMetrics[];
  /** Column labels of the confusion matrix: every category plus "error". */
  columns: Prediction[];
  /** confusion[i][j] = rows expected CATEGORIES[i] and predicted columns[j]. */
  confusion: number[][];
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function computeMetrics(rows: EvalRow[]): Metrics {
  const columns: Prediction[] = [...CATEGORIES, "error"];
  const confusion = CATEGORIES.map(() => columns.map(() => 0));

  for (const row of rows) {
    const i = CATEGORIES.indexOf(row.expected);
    const j = columns.indexOf(row.predicted);
    if (i < 0 || j < 0) throw new Error(`unknown label in row ${row.id}`);
    confusion[i]![j]! += 1;
  }

  const perCategory = CATEGORIES.map((category, i): CategoryMetrics => {
    const truePositives = confusion[i]![i]!;
    const support = confusion[i]!.reduce((a, b) => a + b, 0);
    const predicted = confusion.reduce((sum, r) => sum + r[i]!, 0);
    const precision = ratio(truePositives, predicted);
    const recall = ratio(truePositives, support);
    const f1 =
      precision === null || recall === null
        ? null
        : precision + recall === 0
          ? 0
          : (2 * precision * recall) / (precision + recall);
    return { category, support, predicted, truePositives, precision, recall, f1 };
  });

  const correct = perCategory.reduce((sum, c) => sum + c.truePositives, 0);
  const f1s = perCategory.filter((c) => c.support > 0).map((c) => c.f1 ?? 0);

  return {
    total: rows.length,
    correct,
    errors: rows.filter((r) => r.predicted === "error").length,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    macroF1: f1s.length === 0 ? null : f1s.reduce((a, b) => a + b, 0) / f1s.length,
    perCategory,
    columns,
    confusion,
  };
}

const pct = (v: number | null): string => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);

/** Short column headers so the confusion matrix fits in a terminal. */
const ABBREV: Record<Prediction, string> = {
  interested: "int",
  question: "q",
  meeting_request: "mtg",
  not_now: "now",
  not_interested: "no",
  unsubscribe: "unsub",
  referral: "ref",
  auto_reply: "auto",
  bounce: "bnc",
  other: "oth",
  error: "err",
};

export function formatConsole(m: Metrics): string {
  const lines: string[] = [];
  lines.push(`Accuracy: ${pct(m.accuracy)} (${m.correct}/${m.total})   macro-F1: ${pct(m.macroF1)}   errors: ${m.errors}`);
  lines.push("");
  lines.push(`${"category".padEnd(16)}${"support".padStart(8)}${"precision".padStart(11)}${"recall".padStart(9)}${"f1".padStart(9)}`);
  for (const c of m.perCategory) {
    lines.push(
      `${c.category.padEnd(16)}${String(c.support).padStart(8)}${pct(c.precision).padStart(11)}${pct(c.recall).padStart(9)}${pct(c.f1).padStart(9)}`,
    );
  }
  lines.push("");
  lines.push("Confusion matrix (rows = expected, columns = predicted):");
  lines.push(`${"".padEnd(16)}${m.columns.map((c) => ABBREV[c].padStart(6)).join("")}`);
  CATEGORIES.forEach((cat, i) => {
    lines.push(`${cat.padEnd(16)}${m.confusion[i]!.map((n) => (n === 0 ? "." : String(n)).padStart(6)).join("")}`);
  });
  return lines.join("\n");
}

export function formatMarkdownTables(m: Metrics): string {
  const out: string[] = [];
  out.push(`| | |\n|---|---|\n| Accuracy | ${pct(m.accuracy)} (${m.correct}/${m.total}) |\n| Macro-F1 | ${pct(m.macroF1)} |\n| Errors | ${m.errors} |`);
  out.push("");
  out.push("### Per category\n");
  out.push("| Category | Support | Predicted | Precision | Recall | F1 |");
  out.push("|---|---:|---:|---:|---:|---:|");
  for (const c of m.perCategory) {
    out.push(`| \`${c.category}\` | ${c.support} | ${c.predicted} | ${pct(c.precision)} | ${pct(c.recall)} | ${pct(c.f1)} |`);
  }
  out.push("");
  out.push("### Confusion matrix\n");
  out.push("Rows are the expected category, columns the predicted one.\n");
  out.push(`| expected \\ predicted | ${m.columns.map((c) => ABBREV[c]).join(" | ")} |`);
  out.push(`|---|${m.columns.map(() => "---:").join("|")}|`);
  CATEGORIES.forEach((cat, i) => {
    out.push(`| \`${cat}\` | ${m.confusion[i]!.map((n) => (n === 0 ? "·" : String(n))).join(" | ")} |`);
  });
  out.push("");
  out.push(`Column key: ${m.columns.map((c) => `${ABBREV[c]} = ${c}`).join(", ")}.`);
  return out.join("\n");
}
