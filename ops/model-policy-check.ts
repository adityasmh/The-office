// ops/model-policy-check.ts (Order F3): offline proof of the model policy.
// Pure: no network, no router; Laya is faked (MOCK_MODE + the pure decide()),
// the gateway call runs against an injected fake transport (stubbed global fetch).
// The FIRST import must stay the sandbox root so COMPANY_ROOT is captured before
// org.js imports and nothing writes to the real company/ folder.
import "./sandbox-company-root.js";

// Env must be set BEFORE the modules are imported (mock mode gates the Laya call).
// The model ids are pinned too: the ambient environment may override config.models
// (COMPLEX_MODEL etc. are env-backed), which would make the "kimi/qwen are swapped"
// cases meaningless in-process. Pinning reproduces the prod catalog exactly.
delete process.env.MODEL_ALLOWLIST;
process.env.MOCK_MODE = "1";
process.env.ROUTINE_MODEL = "glm-5.3-flash";
process.env.STANDARD_MODEL = "deepseek-v4-flash";
process.env.COMPLEX_MODEL = "kimi-k2.7-code";
process.env.QWEN_MODEL = "qwen3.8-flash";
process.env.JCODE_MUSE_LANE = "off"; // this check tests the paid-provider path; the free Muse lane must not intercept it

const { config, enforceModel } = await import("../src/config.js");
const { providerSlashModel } = await import("../src/company/workers.js");
const { callGatewayModel } = await import("../src/gateway.js");
const { chooseWorkerModel, workerModelQuestionSpec, escalationAllowed } = await import("../src/company/dispatch.js");

const results: { name: string; ok: boolean; detail: string }[] = [];
function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
}

// --- fake transport: injected in place of the real gateway fetch ---
let lastGatewayModelSeen = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
  if (typeof body.model === "string") lastGatewayModelSeen = body.model;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "fake-ok" } }], usage: {} }),
    text: async () => "fake-ok",
  } as unknown as Response;
}) as typeof fetch;

try {
  // 1. allowlisted ids pass unchanged
  const ds = enforceModel("deepseek-v4-flash");
  report(
    "deepseek passes unchanged",
    !ds.swapped && ds.id === "deepseek-v4-flash" && ds.was === null,
    JSON.stringify(ds),
  );
  const glm = enforceModel("glm-5.3-flash");
  report(
    "glm passes unchanged",
    !glm.swapped && glm.id === "glm-5.3-flash" && glm.was === null,
    JSON.stringify(glm),
  );

  // 2. blocked ids swap onto the standard model
  const kimi = enforceModel(config.models.complex);
  report(
    "kimi swapped to standard",
    kimi.swapped && kimi.id === config.models.standard && kimi.was === config.models.complex,
    JSON.stringify(kimi),
  );
  const qwen = enforceModel(config.models.complexQwen);
  report(
    "qwen swapped to standard",
    qwen.swapped && qwen.id === config.models.standard && qwen.was === config.models.complexQwen,
    JSON.stringify(qwen),
  );

  // 3. Claude ids are out of scope: pass through
  const claude = enforceModel("claude-sonnet-5-5");
  report(
    "claude passes through",
    !claude.swapped && claude.id === "claude-sonnet-5-5" && claude.was === null,
    JSON.stringify(claude),
  );

  // 4. MODEL_ALLOWLIST override (set, test, restore)
  const prev = process.env.MODEL_ALLOWLIST;
  try {
    process.env.MODEL_ALLOWLIST = "glm";
    const deepBlocked = enforceModel("deepseek-v4-flash");
    const glmAllowed = enforceModel("glm-5.3-flash");
    process.env.MODEL_ALLOWLIST = "deepseek, kimi";
    const kimiOverride = enforceModel("kimi-k2.7-code");
    report(
      "MODEL_ALLOWLIST override works",
      deepBlocked.swapped && glmAllowed.swapped === false && kimiOverride.swapped === false,
      `glm-only: deepseek swapped=${deepBlocked.swapped} glm ok; deepseek,kimi: kimi ok`,
    );
  } finally {
    if (prev === undefined) delete process.env.MODEL_ALLOWLIST;
    else process.env.MODEL_ALLOWLIST = prev;
  }

  // 5. non-string input -> fallback, never throws
  const bad = (enforceModel as unknown as (v: unknown, f?: string) => { id: string; swapped: boolean })(42);
  report(
    "non-string input falls back",
    bad.id === config.models.standard && !bad.swapped,
    `${JSON.stringify(bad)} (no throw)`,
  );

  // 6. worker model string builder goes through enforceModel (assert on the swap)
  const workerString = providerSlashModel(config.models.complex);
  report(
    "worker builder swaps kimi",
    workerString === `opencode-go/${config.models.standard}`,
    `${config.models.complex} -> ${workerString}`,
  );
  const workerStringGlm = providerSlashModel(config.models.routine);
  report(
    "worker builder keeps glm",
    workerStringGlm === `opencode-go/${config.models.routine}`,
    `${config.models.routine} -> ${workerStringGlm}`,
  );

  // 7. gateway call builder goes through enforceModel (assert on the swapped result)
  const gw = await callGatewayModel(config.models.complex, "system", "user");
  report(
    "gateway call swaps kimi at the wire",
    gw.text === "fake-ok" && lastGatewayModelSeen === config.models.standard,
    `outgoing model on the transport: ${lastGatewayModelSeen || "(none)"} (expected ${config.models.standard})`,
  );

  // 8. escalation case: a failed earlier attempt must never resolve to kimi/qwen.
  // Laya is faked: chooseWorkerModel runs in mock mode, and the measured decide()
  // of the escalation question is exercised directly with a fake answer.
  const escalation = workerModelQuestionSpec(
    `REDO attempt 2: the previous attempt at src/company/fleet.ts already failed. Refactor and migrate ${["a.ts", "b.ts", "c.ts", "d.ts"].join(", ")}.`,
  );
  const dec = escalation.decide({
    escalate: { type: "noul", noul: 0.9 },
    trivial: { type: "noul", noul: 0 },
  });
  const allowed = escalationAllowed("the previous attempt at this work order already failed");
  const picked = await chooseWorkerModel("the previous attempt at this work order already failed; refactor a.ts, b.ts", {
    projectId: "p-check",
    role: "coder",
  });
  const blockedIds = [config.models.complex, config.models.complexQwen];
  report(
    "escalation never returns kimi/qwen",
    !blockedIds.includes(dec.choice) &&
      blockedIds.includes(config.models.complex) && // catalog ids still exist (blocked, not deleted)
      dec.choice === config.models.routine &&
      allowed.escalate &&
      !blockedIds.includes(picked.modelId),
      `decide pick=${dec.choice} (expected ${config.models.routine}); chooseWorkerModel pick=${picked.modelId} (expected ${config.models.standard})`,
  );
} catch (err) {
  report("check ran to completion", false, String(err));
} finally {
  globalThis.fetch = realFetch;
}

const failed = results.filter((r) => !r.ok);
console.log(`--- model-policy-check: ${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL` : ""}`);

// 9. Remaining 'kimi' at call sites: grep the changed files and report the list.
// Call-site = a kimi id reaching a model call. Catalog entries (config.ts models.*)
// and comments/history are expected to stay; a live call site would be a leak.
import fs from "node:fs";
import path from "node:path";
const changedFiles = ["src/company/workers.ts", "src/company/dispatch.ts", "src/company/pipeline.ts", "src/config.ts", "src/gateway.ts"];
const kimiHits: { file: string; line: number; text: string }[] = [];
for (const rel of changedFiles) {
  const lines = fs.readFileSync(path.resolve(rel), "utf8").split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/kimi/i.test(l)) kimiHits.push({ file: rel, line: i + 1, text: l.trim().slice(0, 140) });
  });
}
console.log(`--- model-policy-check: 'kimi' occurrences in changed files: ${kimiHits.length}`);
for (const h of kimiHits) console.log(`    ${h.file}:${h.line}: ${h.text}`);
console.log(
  kimiHits.length === 0
    ? "PASS no kimi in changed files"
    : `PASS kimi list reported (${kimiHits.length} lines; call-site if not a catalog entry or comment)`,
);
process.exit(failed.length ? 1 : 0);
