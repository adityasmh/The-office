/**
 * src/adaptive/persistence.ts — restart keeps what it learned.
 *
 *   company/adaptive/outcomes.jsonl   append-only, bounded (rotated when it grows
 *                                     past ADAPTIVE_OUTCOMES_MAX_BYTES)
 *   company/adaptive/estimates.json   the estimator state (atomic tmp+rename)
 *
 * Writes are async and fire-and-forget: a slow disk must never stall a request.
 */
import fs from "node:fs";
import path from "node:path";
import type { OutcomeEvent } from "./events.js";
// estimator.ts does not import this module, so a plain static import is cycle-free.
import { Estimator } from "./estimator.js";

export function adaptiveRoot(root?: string): string {
  return path.join(root ?? process.env.COMPANY_ROOT ?? "company", "adaptive");
}

export function outcomesPath(root?: string): string {
  return path.join(adaptiveRoot(root), "outcomes.jsonl");
}

export function estimatesPath(root?: string): string {
  return path.join(adaptiveRoot(root), "estimates.json");
}

export class AdaptiveStore {
  readonly dir: string;
  readonly outcomes: string;
  readonly estimates: string;
  private appends = 0;
  private maxBytes = Number(process.env.ADAPTIVE_OUTCOMES_MAX_BYTES ?? 5_000_000);
  private keepLines = Number(process.env.ADAPTIVE_OUTCOMES_KEEP_LINES ?? 20_000);

  constructor(root?: string) {
    this.dir = adaptiveRoot(root);
    this.outcomes = outcomesPath(root);
    this.estimates = estimatesPath(root);
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* exists */
    }
  }

  /** Append one outcome. Never throws. */
  append(event: OutcomeEvent): void {
    this.ensureDir();
    const line = `${JSON.stringify(event)}\n`;
    fs.appendFile(this.outcomes, line, () => {
      /* fire-and-forget */
    });
    this.appends += 1;
    if (this.appends % 200 === 0) this.maybeRotate();
  }

  /** Keep the file bounded: when it is too big, rewrite just the last keepLines. */
  maybeRotate(): void {
    try {
      const st = fs.statSync(this.outcomes);
      if (st.size <= this.maxBytes) return;
      const text = fs.readFileSync(this.outcomes, "utf8");
      const lines = text.split("\n").filter(Boolean);
      const kept = lines.slice(-this.keepLines);
      fs.writeFileSync(this.outcomes, `${kept.join("\n")}\n`);
    } catch {
      /* missing file is fine */
    }
  }

  loadEstimator(): Estimator | null {
    try {
      const raw = fs.readFileSync(this.estimates, "utf8");
      return Estimator.fromJSON(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Atomic estimator snapshot. Never throws (a failed save must not break routing). */
  saveEstimator(est: Estimator): void {
    this.ensureDir();
    const tmp = `${this.estimates}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(est.toJSON()));
      fs.renameSync(tmp, this.estimates);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  /** How much is on disk (dashboard "persistence" row). */
  size(): { outcomesBytes: number; estimatesBytes: number; outcomesLines: number } {
    let outcomesBytes = 0;
    let estimatesBytes = 0;
    let outcomesLines = 0;
    try {
      outcomesBytes = fs.statSync(this.outcomes).size;
    } catch {
      /* absent */
    }
    try {
      estimatesBytes = fs.statSync(this.estimates).size;
    } catch {
      /* absent */
    }
    try {
      outcomesLines = fs.readFileSync(this.outcomes, "utf8").split("\n").filter(Boolean).length;
    } catch {
      /* absent */
    }
    return { outcomesBytes, estimatesBytes, outcomesLines };
  }

  /** Replay the tail of outcomes.jsonl into an estimator (restart path / replay tool). */
  readOutcomes(limit = 5000): OutcomeEvent[] {
    try {
      const lines = fs.readFileSync(this.outcomes, "utf8").split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as OutcomeEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is OutcomeEvent => !!e);
    } catch {
      return [];
    }
  }
}
