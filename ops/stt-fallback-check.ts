#!/usr/bin/env node
/**
 * ops/stt-fallback-check.ts — acceptance harness for the speech-to-text outage
 * fallback (work order fomunicug6/WO1: "the CEO must be able to type orders
 * whenever STT is down or unreachable, and the page must say so").
 *
 *   npx tsx ops/stt-fallback-check.ts
 *
 * It spawns TWO throwaway routers and never touches the live one:
 *   - DOWN: STT_URL points at a closed port. This is the real outage shape (the
 *     live service answers ECONNREFUSED when it is not running).
 *   - UP:   STT_URL points at a stub in this file that answers exactly like
 *     tools/stt/server.py (GET /stt/health, POST /stt/transcribe).
 * Both get their own COMPANY_ROOT under the OS temp dir, a spare PORT and
 * SLACK_BRIDGE=0, so nothing here can write to the live company/ (the rule in
 * docs/AGENT_COORDINATION.md).
 *
 * Checks:
 *   DOWN router  GET  /company/assistant/stt/health -> ok:false stt_unavailable
 *                POST /company/assistant/message    -> a normal reply (the fallback)
 *                POST /company/assistant/voice      -> 502 stt_unavailable (loud, not silent)
 *   UP router    GET  /company/assistant/stt/health -> ok:true
 *                POST /company/assistant/voice      -> ok:true + transcript + reply
 *                POST /company/assistant/message    -> a normal reply (no regression)
 *
 * The two /message calls are real assistantMessage runs (a real model call), so
 * the run takes as long as two cheap orders normally take.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_WAV = path.join(REPO_ROOT, "tools", "stt", "test", "known.wav");

const DEAD_STT_PORT = Number(process.env.WO1_DEAD_STT_PORT ?? 18998);
const STUB_STT_PORT = Number(process.env.WO1_STUB_STT_PORT ?? 18997);
const DOWN_ROUTER_PORT = Number(process.env.WO1_DOWN_ROUTER_PORT ?? 19001);
const UP_ROUTER_PORT = Number(process.env.WO1_UP_ROUTER_PORT ?? 19002);
const POST_TIMEOUT_MS = Number(process.env.WO1_POST_TIMEOUT_MS ?? 240_000);

let passed = 0;
/* The control-plane secret for mutating /company/* calls. Taken from the
 * loopback-only bootstrap endpoint of the router under test - never read from
 * the environment and never printed (the harness output is evidence, not a
 * place for COMPANY_AUTH_TOKEN). */
let authToken = "";
function authHeaders(extra: Record<string, string> = {}) {
  return authToken ? { ...extra, "x-company-token": authToken } : extra;
}

async function bootstrapToken(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/company/auth/bootstrap`, { signal: AbortSignal.timeout(5000) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  authToken = typeof json?.token === "string" ? json.token : "";
  console.log(
    `[harness] control-plane token via loopback bootstrap: ${authToken ? `acquired (${authToken.length} chars)` : "MISSING"}`,
  );
  if (!authToken) throw new Error("could not bootstrap a control-plane token from the test router");
}

function check(cond: unknown, label: string, evidence: unknown) {
  const line = JSON.stringify(evidence);
  if (cond) {
    passed++;
    console.log(`PASS ${label} :: ${line}`);
  } else {
    console.log(`FAIL ${label} :: ${line}`);
    throw new Error(`assertion failed: ${label}`);
  }
}

function tmpRoot(tag: string) {
  const dir = path.join(os.tmpdir(), `wo1-stt-fallback-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function getJson(url: string, timeoutMs = 15_000) {
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function postJson(url: string, body: unknown, timeoutMs = POST_TIMEOUT_MS) {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function postAudio(url: string, wavPath: string, timeoutMs = POST_TIMEOUT_MS) {
  const bytes = fs.readFileSync(wavPath);
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "content-type": "audio/wav" }),
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** The stub STT service: same two routes and shapes as tools/stt/server.py. */
function startStubStt(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    const send = (code: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.method === "GET" && url === "/stt/health") {
      send(200, {
        ok: true,
        model: "stub.en",
        device: "cpu",
        compute_type: "int8",
        vram: null,
        uptime_s: 1,
        warm: true,
      });
      return;
    }
    if (req.method === "POST" && url === "/stt/transcribe") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const size = Buffer.concat(chunks).length;
        if (size === 0) return send(400, { ok: false, error: "empty_audio", detail: "no bytes" });
        send(200, { ok: true, text: "Create a task to update the budget report.", ms: 3, language: "en" });
      });
      return;
    }
    send(404, { ok: false, error: "not_found", detail: url });
  });
  return new Promise((resolve) => server.listen(STUB_STT_PORT, "127.0.0.1", () => resolve(server)));
}

function startRouter(tag: string, port: number, sttUrl: string): ChildProcess {
  const companyRoot = tmpRoot(tag);
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      COMPANY_ROOT: companyRoot,
      SLACK_BRIDGE: "0",
      STT_URL: sttUrl,
    },
  });
  const log = (line: string) => console.log(`[router:${tag}] ${line}`);
  child.stdout?.on("data", (b: Buffer) => log(String(b).trimEnd()));
  child.stderr?.on("data", (b: Buffer) => log(String(b).trimEnd()));
  console.log(`[harness] router:${tag} pid=${child.pid} port=${port} companyRoot=${companyRoot} stt=${sttUrl}`);
  return child;
}

function stopChild(child: ChildProcess | null) {
  if (!child || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function waitForHealth(port: number, ms = 90_000) {
  const deadline = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`router on :${port} never became healthy (${lastErr})`);
}

async function main() {
  const stub = await startStubStt();
  console.log(`[harness] stub STT on http://127.0.0.1:${STUB_STT_PORT} (health + transcribe)`);
  const downRouter = startRouter("down", DOWN_ROUTER_PORT, `http://127.0.0.1:${DEAD_STT_PORT}/stt/transcribe`);
  const upRouter = startRouter("up", UP_ROUTER_PORT, `http://127.0.0.1:${STUB_STT_PORT}/stt/transcribe`);
  try {
    await waitForHealth(DOWN_ROUTER_PORT);
    await waitForHealth(UP_ROUTER_PORT);
    await bootstrapToken(DOWN_ROUTER_PORT);

    /* ── STT DOWN ───────────────────────────────────────────────────────── */
    const downHealth = await getJson(`http://127.0.0.1:${DOWN_ROUTER_PORT}/company/assistant/stt/health`);
    check(
      downHealth.status === 200 && downHealth.json?.ok === false && downHealth.json?.error === "stt_unavailable",
      "STT down: health probe says ok:false / stt_unavailable",
      downHealth,
    );

    const downTyped = await postJson(`http://127.0.0.1:${DOWN_ROUTER_PORT}/company/assistant/message`, {
      text: "Typed order while speech-to-text is down: what is the company status?",
      autoRun: false,
    });
    check(
      downTyped.status === 200 && typeof downTyped.json?.reply === "string" && String(downTyped.json.reply).length > 0,
      "STT down: a TYPED order still returns a Joey reply",
      { status: downTyped.status, reply: downTyped.json?.reply, dispatched: downTyped.json?.dispatched },
    );

    const downVoice = await postAudio(
      `http://127.0.0.1:${DOWN_ROUTER_PORT}/company/assistant/voice?autoRun=false`,
      KNOWN_WAV,
    );
    check(
      downVoice.status === 502 && downVoice.json?.error === "stt_unavailable" && typeof downVoice.json?.message === "string",
      "STT down: the voice route fails LOUDLY with a message (nothing silent)",
      downVoice,
    );

    /* ── STT UP ─────────────────────────────────────────────────────────── */
    const upHealth = await getJson(`http://127.0.0.1:${UP_ROUTER_PORT}/company/assistant/stt/health`);
    check(
      upHealth.status === 200 && upHealth.json?.ok === true && upHealth.json?.model === "stub.en",
      "STT up: health probe says ok:true with the service's own fields",
      upHealth,
    );

    const upVoice = await postAudio(`http://127.0.0.1:${UP_ROUTER_PORT}/company/assistant/voice?autoRun=false`, KNOWN_WAV);
    check(
      upVoice.status === 200 && upVoice.json?.ok === true && upVoice.json?.spoken === true &&
        typeof upVoice.json?.transcript === "string" && typeof upVoice.json?.reply === "string",
      "STT up: the spoken route still transcribes and replies (no regression)",
      { status: upVoice.status, transcript: upVoice.json?.transcript, reply: upVoice.json?.reply, sttMs: upVoice.json?.sttMs },
    );

    const upTyped = await postJson(`http://127.0.0.1:${UP_ROUTER_PORT}/company/assistant/message`, {
      text: "Typed order while speech-to-text is up: what is the company status?",
      autoRun: false,
    });
    check(
      upTyped.status === 200 && typeof upTyped.json?.reply === "string" && String(upTyped.json.reply).length > 0,
      "STT up: a TYPED order still returns a Joey reply (typed path unchanged either way)",
      { status: upTyped.status, reply: upTyped.json?.reply },
    );

    console.log(`[stt-fallback-check] ALL ${passed} CHECKS PASS`);
  } finally {
    stopChild(downRouter);
    stopChild(upRouter);
    stub.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
