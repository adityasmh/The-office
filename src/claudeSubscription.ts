import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { callGatewayModel } from "./gateway.js";
// BRAIN ROUTING (manager grant, 01:xx order): Laya picks the tier for a call that
// names a `purpose`, and the cheap tier goes over the Go gateway instead of the
// Claude subscription. Imported here so every Claude caller is covered by ONE
// hook; see src/company/brainRouter.ts. No cycle: brainRouter imports config,
// decision, org and budgetGuard only.
import { pickBrain, resolveBrainModel, noteCheapFailure, cheapFailures, clearCheapFailures, type BrainPurpose } from "./company/brainRouter.js";
// AIR-GAP (PERF item 7): non-loopback fetches and the claude -p child must not run with AIR_GAPPED=1.
import { airgappedBlock } from "./company/airGap.js";

// Subscription-only Claude access. Reads tokens created by `claude login`
// (Claude Code CLI). No ANTHROPIC_API_KEY is used anywhere.
// Fragile by design: Anthropic removed official third-party OAuth support
// (opencode PR #18186). If refresh or headers change, re-run `claude login`
// and update CLIENT_ID / URLs below.

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

type StoredCreds = {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // ms epoch
  };
};

function loadCreds(): StoredCreds {
  if (!fs.existsSync(CRED_PATH)) {
    throw new Error(`Claude credentials not found at ${CRED_PATH}. Run: claude login`);
  }
  return JSON.parse(fs.readFileSync(CRED_PATH, "utf8")) as StoredCreds;
}

function saveCreds(c: StoredCreds) {
  fs.writeFileSync(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

async function refreshAccessToken(refreshToken: string) {
  // Must use global fetch with JSON body; some versions reject form-encoded here.
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Claude OAuth refresh ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? refreshToken, expiresInSec: j.expires_in };
}

export async function getSubscriptionAccessToken(): Promise<string> {
  const creds = loadCreds();
  const oauth = creds.claudeAiOauth;
  if (!oauth) throw new Error("No claudeAiOauth block in credentials. Re-run `claude login`.");
  // Refresh 5 min early, deduplicated by file mtime in single-process use.
  if (oauth.expiresAt - Date.now() > 5 * 60 * 1000) return oauth.accessToken;
  const r = await refreshAccessToken(oauth.refreshToken);
  creds.claudeAiOauth = {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: Date.now() + r.expiresInSec * 1000,
  };
  saveCreds(creds);
  return r.accessToken;
}

export function hasClaudeCreds(): boolean {
  try {
    const c = loadCreds();
    return !!c.claudeAiOauth?.refreshToken;
  } catch {
    return false;
  }
}

// Claude Code as the brain: run the official CLI headless (`claude -p`) on the
// same subscription. Unlike the raw OAuth call below it can read the project
// (Read/Glob/Grep only, scoped to `cwd`), so managers plan from real files
// instead of guessing. CLAUDE_BACKEND=oauth restores the old direct call.
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

export async function callClaudeCode(opts: {
  model: string;
  system?: string;
  user: string;
  cwd?: string;
  addDirs?: string[]; // extra read-only roots (e.g. the company folder for cross-project audits)
  timeoutMs?: number;
}): Promise<{ text: string; model: string; usage?: unknown; costUsd?: number }> {
  const { spawn } = await import("node:child_process");
  // AIR-GAP (PERF item 7): the claude -p child process is an outbound call and a child
  // cannot be caught by this process's fetch guard, so it is refused HERE. The thrown
  // error is the same shape callers already handle for 429s; the orchestrator's fallback
  // then routes the work to the held-air-gapped queue instead of failing it.
  if (airgappedBlock("claude-cli", `claude -p model=${opts.model} cwd=${opts.cwd ?? process.cwd()}`)) {
    throw new Error("air-gap: claude -p refused (AIR_GAPPED=1 makes ZERO outbound calls; work queued locally)");
  }
  // System prompt via file: assistant prompts carry the whole company context and
  // can exceed the Windows command-line limit.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-brain-"));
  const sysFile = path.join(tmpDir, "system.txt");
  fs.writeFileSync(sysFile, opts.system ?? "");
  const args = [
    "-p",
    "--model", opts.model,
    "--output-format", "json",
    "--system-prompt-file", sysFile,
    "--tools", "Read,Glob,Grep",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  const extra = (opts.addDirs ?? []).filter((d) => fs.existsSync(d));
  if (extra.length) args.push("--add-dir", ...extra);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription only
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CLAUDE_CLI_TIMEOUT_SECONDS ?? 300) * 1000;

  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        reject(new Error(`claude -p timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stdout.trim()) resolve(stdout);
        else reject(new Error(`claude -p exit ${code}: ${stderr.slice(-400)}`));
      });
      // Prompt on stdin, then close it (an open, unwritten stdin would block).
      child.stdin.end(opts.user);
    });
    const j = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "{}") as {
      result?: string; is_error?: boolean; api_error_status?: number | null; total_cost_usd?: number; usage?: unknown;
    };
    if (j.is_error || j.api_error_status) {
      const status = j.api_error_status ?? "error";
      if (status === 429 || /rate|limit/i.test(j.result ?? "")) {
        throw new Error(`Claude subscription rate-limited (429) via claude -p: ${(j.result ?? "").slice(0, 200)}`);
      }
      throw new Error(`claude -p ${status}: ${(j.result ?? "").slice(0, 300)}`);
    }
    return { text: j.result ?? "", model: opts.model, usage: j.usage, costUsd: j.total_cost_usd };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export async function callClaudeSubscription(opts: {
  model: string;
  system?: string;
  user: string;
  maxTokens?: number;
  cwd?: string;
  addDirs?: string[];
  /**
   * BRAIN ROUTING: name what this call is for and the brain router asks Laya which tier it
   * needs, then applies the budget guard. `model` becomes the MAX tier (so
   * ASSISTANT_MODEL/FLEET_PLANNER_MODEL mean "never above this", not "always this").
   * CHEAP BY DEFAULT (Job 1, leak closed): an OMITTED purpose no longer skips the gate - it is
   * treated as `generate`, which can never take Claude (only the CEO naming Claude in the text
   * can raise it). There is no path through this function that avoids the gate.
   */
  purpose?: BrainPurpose | string;
  /** what Laya classifies; defaults to the user prompt. */
  brainText?: string;
  /** a fact the caller noticed that may justify the top tier. */
  hardRule?: "redo2" | "failed" | "stuck";
  /**
   * SAFETY NET: the key the cheap-failure counter is kept under. Omit it and the gate derives
   * one from the purpose + a hash of the classified text, so the SAME request retried climbs
   * and a different request does not inherit the count. Pass it explicitly when the caller
   * knows the unit of work (e.g. `${purpose}:${taskId}`) - that is what makes "two cheap
   * failures on THIS task -> one Sonnet attempt" exact.
   */
  failureKey?: string;
}) {
  // Brain routing first: it may route this call to the cheap Go tier, in which
  // case the Claude subscription is never touched.
  let routedModel = opts.model;
  let brain: { tier: string; model: string; reason: string; reasonKind: string; top?: number; lead?: number; ms?: number } | undefined;
  // LEAK CLOSED: a caller that names no purpose used to skip the gate and always reach
  // Claude. Now every call goes through it; an unnamed purpose is treated as "generate"
  // (never Claude-eligible: cheap tier unless the CEO named Claude in the text).
  {
    opts = { ...opts, purpose: opts.purpose || "generate" };
    const brainText = opts.brainText ?? opts.user;
    // SAFETY NET WIRED (2026-09-30, BUDGET/otter's finding 1): `pickBrain` has always accepted
    // `cheapFailures`, but NOTHING recorded a cheap-tier failure - so a small task whose cheap
    // model 429'd (the Go key is at 0% right now) failed instead of climbing. The gate is the
    // chokepoint, so the counter lives here: read it, hand it to pickBrain, and book the outcome
    // around the cheap call. `noteCheapFailure`/`clearCheapFailures` are exported for this.
    const failureKey = opts.failureKey ?? `${opts.purpose}:${crypto.createHash("sha1").update(brainText).digest("hex").slice(0, 12)}`;
    const priorCheapFailures = cheapFailures(failureKey);
    const pick = await pickBrain({
      purpose: opts.purpose!,
      text: brainText,
      hint: opts.system,
      // A call that passes a cwd/addDirs reads files: the pick flags it if the tier
      // cannot read (the gate no longer hides that - see brainRouter's header).
      needsFiles: !!(opts.cwd || (opts.addDirs && opts.addDirs.length > 0)),
      hardRule: opts.hardRule,
      cheapFailures: priorCheapFailures,
    });
    const resolved = resolveBrainModel(pick, opts.model, String(opts.purpose));
    routedModel = resolved.model;
    brain = {
      tier: resolved.tier,
      model: resolved.model,
      reason: resolved.reason,
      reasonKind: pick.reasonKind,
      top: pick.laya.top,
      lead: pick.laya.lead,
      ms: pick.laya.ms,
    };
    console.log(`[brain] ${opts.purpose}: tier=${resolved.tier} model=${resolved.model} (${resolved.reason})`);
    if (resolved.tier === "none") {
      // The cheap tier is a Go model on the gateway: no Claude quota is spent (and no
      // file reading is possible - the gate flags that as `fileBlind`).
      // A purpose that can NEVER climb (e.g. `generate`, not Claude-eligible) must not accumulate
      // a counter forever: at 2 we forget it, since it can never be spent on an escalation.
      if (priorCheapFailures >= 2) clearCheapFailures(failureKey);
      try {
        // OUTPUT BUDGET (docs/perf/REVIEW_NO_VERDICT_2026-10-01.md): the gateway default is
        // 4096, and these cheap models bill `reasoning_content` INSIDE max_tokens, so a review
        // reply got truncated / came back as reasoning with no JSON verdict. Budget like the
        // fleet's own fallback (8192) unless the caller set one.
        const r = await callGatewayModel(resolved.model, opts.system, opts.user, { maxTokens: opts.maxTokens ?? 8192 });
        // The cheap tier worked: forget its failures so a later, unrelated one starts at 0.
        clearCheapFailures(failureKey);
        return { text: r.text ?? "", model: resolved.model, usage: r.usage, brain };
      } catch (cheapErr) {
        // Book it. The NEXT attempt at this same work reads `priorCheapFailures + 1` and, at 2,
        // pickBrain climbs to ONE Sonnet attempt (reason recorded, `climbed: true`). We rethrow
        // so the caller still sees the real cheap-tier error (e.g. GoUsageLimitError).
        const n = noteCheapFailure(failureKey);
        console.warn(`[brain] cheap tier ${resolved.model} failed (${n}/2) for ${failureKey}: ${String(cheapErr).slice(0, 160)}`);
        throw cheapErr;
      }
    }
    // A Claude tier is being used: this is either normal routing or the climb. Either way the
    // cheap-failure count for this work is done with.
    clearCheapFailures(failureKey);
  }
  const withBrain = <T extends object>(r: T): T & { brain?: typeof brain } => (brain ? { ...r, brain } : r);
  if ((process.env.CLAUDE_BACKEND ?? "cli") !== "oauth") return withBrain(await callClaudeCode({ ...opts, model: routedModel }));
  opts = { ...opts, model: routedModel };
  const accessToken = await getSubscriptionAccessToken();
  const res = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      // Required for subscription Bearer path:
      "anthropic-beta": [
        "oauth-2025-04-20",
        "claude-code-20250219",
        "interleaved-thinking-2025-05-14",
        "fine-grained-tool-streaming-2025-05-14",
      ].join(","),
      // Anthropic gates subscription traffic on CLI user-agent:
      "user-agent": "claude-cli/1.0.57 (external, cli)",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Claude subscription rejected (${res.status}). Re-run 'claude login'. Body: ${await res.text()}`);
  }
  if (res.status === 429) throw new Error(`Claude subscription rate-limited (429). Back off and retry, or fall back to the gateway model in CLAUDE_FALLBACK_MODEL.`);
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { content: Array<{ type: string; text?: string }>; model: string; usage?: unknown };
  const text = j.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return withBrain({ text, model: j.model, usage: j.usage });
}
