import { assistantMessage } from "./assistant.js";
import type { AssistantDispatch, AssistantPlanItem } from "./assistant.js";

// ---------------------------------------------------------------------------
// Batch runner: fire N plain CEO instructions through the SAME code path the
// dashboard's assistant console uses (`assistantMessage`), with a bounded
// concurrency and per-item error capture.
//
// Why: the CEO wants the whole company working in parallel, not one assistant
// turn at a time. This is the loop that turns "5 instructions" into 5 live
// pipelines without writing a second, divergent dispatch path.
//
// Contract:
//   - never throws for a single item (per-item errors land in BatchResult.error)
//   - results come back in INPUT ORDER; onProgress fires in COMPLETION order
//   - no npm dependencies, no HTTP: it calls assistantMessage in-process, so it
//     works inside the server process and in a standalone tsx script alike
// ---------------------------------------------------------------------------

export type BatchItem = {
  id: string;
  text: string;
  departmentName?: string;
  label?: string;
};

export type BatchResult = {
  id: string;
  label?: string;
  departmentName?: string;
  reply?: string;
  plan?: AssistantPlanItem[];
  /** Routing/budget notes the assistant produced for this instruction. */
  decisions?: string[];
  dispatched: AssistantDispatch[];
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type BatchRun = {
  results: BatchResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type BatchOptions = {
  /** Max instructions in flight at once. Default 3. Clamped to 1..32. */
  concurrency?: number;
  /** Passed through to assistantMessage: false only creates tasks, no pipeline. */
  autoRun?: boolean;
  /** Called as each item lands (completion order). Throw-safe. */
  onProgress?: (result: BatchResult) => void;
};

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 32;
const MAX_ERROR_CHARS = 600;

function nowIso(): string {
  return new Date().toISOString();
}

function shortError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

function normalizeConcurrency(requested: number | undefined, itemCount: number): number {
  const raw = typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_CONCURRENCY;
  const wanted = Math.max(1, Math.min(MAX_CONCURRENCY, raw));
  return Math.max(1, Math.min(wanted, Math.max(1, itemCount)));
}

type NormalizedItem = BatchItem & { id: string; text: string };

function normalizeItems(items: BatchItem[]): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  const list = Array.isArray(items) ? items : [];
  list.forEach((raw, i) => {
    const item = (raw ?? {}) as Partial<BatchItem>;
    out.push({
      ...(item as BatchItem),
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `item-${i + 1}`,
      text: typeof item.text === "string" ? item.text : String(item.text ?? ""),
    });
  });
  return out;
}

export async function runBatch(items: BatchItem[], opts: BatchOptions = {}): Promise<BatchRun> {
  const list = normalizeItems(items);
  const concurrency = normalizeConcurrency(opts.concurrency, list.length);
  const autoRun = opts.autoRun;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const results: BatchResult[] = new Array(list.length);

  async function runOne(item: NormalizedItem, index: number): Promise<void> {
    const itemStartedAt = nowIso();
    const itemStartedMs = Date.now();
    let result: BatchResult;

    try {
      const res = await assistantMessage(item.text, autoRun === undefined ? {} : { autoRun });
      const plan = Array.isArray(res?.plan) ? res.plan : [];
      const dispatched: AssistantDispatch[] = Array.isArray(res?.dispatched) ? res.dispatched : [];
      // Department is what the caller asked for; if the caller did not say, trust
      // the plan, then the sessions the assistant reported back.
      const planDept = plan.find((p) => p && typeof p.departmentName === "string" && p.departmentName.trim())?.departmentName;
      const sessionDept = (res?.sessions ?? []).find((s) => s && typeof s.departmentName === "string" && s.departmentName.trim())
        ?.departmentName;
      const departmentName = item.departmentName ?? planDept ?? sessionDept;
      result = {
        id: item.id,
        dispatched,
        reply: typeof res?.reply === "string" ? res.reply : "",
        plan,
        decisions: Array.isArray(res?.decisions) ? res.decisions : [],
        startedAt: itemStartedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - itemStartedMs,
        ...(item.label ? { label: item.label } : {}),
        ...(departmentName ? { departmentName } : {}),
        ...(res?.error ? { error: String(res.error) } : {}),
      };
    } catch (err) {
      // One bad instruction must never take the batch down.
      result = {
        id: item.id,
        dispatched: [],
        decisions: [],
        error: shortError(err),
        startedAt: itemStartedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - itemStartedMs,
        ...(item.label ? { label: item.label } : {}),
        ...(item.departmentName ? { departmentName: item.departmentName } : {}),
      };
    }

    results[index] = result;
    try {
      opts.onProgress?.(result);
    } catch (err) {
      // A noisy progress printer must not fail the run.
      console.error(`[batch] onProgress threw for ${result.id}: ${shortError(err)}`);
    }
  }

  // Bounded worker pool: `next` is only mutated between awaits, so it is safe.
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, Math.max(1, list.length)); w++) {
    workers.push(
      (async () => {
        while (true) {
          const index = next++;
          if (index >= list.length) return;
          await runOne(list[index], index);
        }
      })(),
    );
  }
  await Promise.all(workers);

  const finishedAt = nowIso();
  return {
    results: list.map((item, i) => {
      const r = results[i];
      if (r) return r;
      // Defensive: a worker pool bug must not produce a sparse array.
      return {
        id: item.id,
        dispatched: [],
        decisions: [],
        error: "batch item never ran",
        startedAt,
        finishedAt,
        durationMs: 0,
        ...(item.label ? { label: item.label } : {}),
        ...(item.departmentName ? { departmentName: item.departmentName } : {}),
      };
    }),
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
  };
}

export function batchDispatches(run: BatchRun | BatchResult[]): AssistantDispatch[] {
  const results = Array.isArray(run) ? run : run.results;
  return results.flatMap((r) => (Array.isArray(r?.dispatched) ? r.dispatched : []));
}
