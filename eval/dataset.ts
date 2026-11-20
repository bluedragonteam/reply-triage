import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CATEGORIES } from "../src/types.js";

export const DatasetRowSchema = z
  .object({
    id: z.string().min(1),
    expected: z.enum(CATEGORIES),
    reply: z.string().min(1),
    subject: z.string().optional(),
    from: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Overrides the shared outbound email in eval/outbound.txt. */
    original: z.string().optional(),
    /** Date the reply was received. Defaults to DEFAULT_RECEIVED_AT so runs are reproducible. */
    received_at: z.iso.date().optional(),
    notes: z.string().optional(),
    /** Field-level checks (optional). */
    expect_follow_up: z.boolean().optional(),
    expect_follow_up_date: z.iso.date().optional(),
    expect_referral_email: z.email().optional(),
  })
  .strict();

export type DatasetRow = z.infer<typeof DatasetRowSchema>;

/** Fixed "today" for every row without its own date. */
export const DEFAULT_RECEIVED_AT = "2026-11-02";

export function parseDataset(text: string): DatasetRow[] {
  const rows: DatasetRow[] = [];
  const ids = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`dataset line ${index + 1}: invalid JSON`);
    }
    const parsed = DatasetRowSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`dataset line ${index + 1}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (ids.has(parsed.data.id)) throw new Error(`dataset line ${index + 1}: duplicate id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    rows.push(parsed.data);
  });
  return rows;
}

export async function loadDataset(path: string): Promise<DatasetRow[]> {
  return parseDataset(await readFile(path, "utf8"));
}
