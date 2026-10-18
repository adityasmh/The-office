// Order F7-no-scope-creep: shared handoff text for the three prompt-building
// stages (enhancer, tester, manager). Every stage receives the raw order under
// a fixed label and is told to judge/restate ONLY against the order's own
// Files list and Proof section; the enhanced brief is context only and a
// defect outside the order never fails work. Exported as constants so the
// proof script (ops/scope-check.ts) can assert on the exact strings the built
// prompts contain.

export const ORIGINAL_ORDER_LABEL = "ORIGINAL ORDER (authoritative)";

export const ENHANCER_ORDER_RULE =
  "Restate the order faithfully: you may add clarifying detail and file paths, but you must NOT add new requirements, features, checks or acceptance criteria. The enhanced brief must contain the order's own Files list and Proof section verbatim.";

export const TESTER_ORDER_RULE =
  "Pass or fail the work ONLY against the order's own Files list and Proof section (the original request text is authoritative; the enhanced brief is context only). A defect outside the order may be mentioned as a note but never makes the verdict FAIL.";

export const MANAGER_ORDER_RULE =
  "Judge the work ONLY against the order's own Files list and Proof section (the original request text is authoritative; the enhanced brief is context only). A defect outside the order may be mentioned as a note but never makes the verdict FAIL. A verdict is PASS when every item of the order's Files list exists and its Proof command prints PASS, even if the work could be better.";
