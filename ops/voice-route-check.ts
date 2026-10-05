#!/usr/bin/env node
/**
 * ops/voice-route-check.ts
 *
 * Acceptance harness for POST /company/assistant/voice.
 *
 *   npx tsx ops/voice-route-check.ts
 *
 * Requires the router on the port from src/config.ts and the STT server on
 * http://127.0.0.1:8902. Uses autoRun=false so no pipeline is launched.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const ROUTER_PORT = config.port;
const ROUTER_BASE = `http://127.0.0.1:${ROUTER_PORT}`;
const AUTH_TOKEN = process.env.COMPANY_AUTH_TOKEN ?? "";

const KNOWN_WAV = path.join(REPO_ROOT, "tools", "stt", "test", "known.wav");
const ONEWORD_WAV = path.join(REPO_ROOT, "tools", "stt", "test", "oneword.wav");

interface VoiceOk {
  ok: true;
  transcript: string;
  spoken: true;
  sttMs: number;
  reply: string;
  tasks: string[];
  plan: unknown[];
  dispatched: unknown[];
  decisions: string[];
}

interface VoiceNoCatch {
  ok: false;
  error: "didnt_catch";
  message: string;
  transcript: string;
}

interface ThreadEntry {
  ts: string;
  role: "ceo" | "assistant";
  text: string;
  spoken?: true;
}

function ensureWav(outPath: string, text: string) {
  if (fs.existsSync(outPath)) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const result = spawnSync(
    process.execPath,
    ["tools/tts/speak.mjs", text, "--no-play", "--out", outPath],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to generate ${outPath}: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`speak.mjs did not produce ${outPath}`);
  }
}

async function postVoice(wavPath: string, autoRun = false) {
  const url = `${ROUTER_BASE}/company/assistant/voice?autoRun=${autoRun}`;
  const body = fs.readFileSync(wavPath);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      "x-company-token": AUTH_TOKEN,
    },
    body,
  });
  const ms = Date.now() - t0;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ms, json };
}

async function getThread(limit = 5) {
  const url = `${ROUTER_BASE}/company/assistant/thread?limit=${limit}`;
  const res = await fetch(url, { headers: { "x-company-token": AUTH_TOKEN } });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function postTyped(text: string) {
  const url = `${ROUTER_BASE}/company/assistant/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-company-token": AUTH_TOKEN,
    },
    body: JSON.stringify({ text, autoRun: false }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  console.log(`[voice-route-check] router=${ROUTER_BASE} auth=${AUTH_TOKEN ? "set" : "MISSING"}`);

  // 1. Generate test audio if the STT worker has not produced known.wav yet.
  ensureWav(KNOWN_WAV, "Create a task to update the budget report.");
  ensureWav(ONEWORD_WAV, "Hello");

  // 2. Multi-word voice order.
  const { status: voiceStatus, ms: voiceMs, json: voiceJson } = await postVoice(KNOWN_WAV, false);
  console.log(`[voice-route-check] POST /company/assistant/voice -> ${voiceStatus} in ${voiceMs} ms`);
  console.log(JSON.stringify(voiceJson, null, 2));
  assert(voiceStatus === 200 && voiceJson.ok === true, "voice order should succeed");
  assert(voiceJson.spoken === true, "success response must have spoken:true");
  const transcript = String(voiceJson.transcript || "");
  assert(transcript.split(/\s+/).filter(Boolean).length >= 2, "transcript must have at least 2 words");

  // 3. The latest CEO thread entry must be spoken and contain the transcript.
  const { status: threadStatus, json: threadJson } = await getThread(5);
  assert(threadStatus === 200, "thread read should succeed");
  const messages = Array.isArray(threadJson.messages) ? (threadJson.messages as ThreadEntry[]) : [];
  const latestCeo = [...messages].reverse().find((m) => m.role === "ceo");
  assert(latestCeo, "thread should have a CEO entry");
  assert(latestCeo.spoken === true, "latest CEO entry should have spoken:true");
  assert(latestCeo.text === transcript, `CEO text should equal transcript: got ${latestCeo.text}, expected ${transcript}`);
  console.log(`[voice-route-check] latest CEO entry is spoken and text matches transcript`);

  // 4. One-word voice order returns didnt_catch and creates no thread entry.
  if (process.env.SKIP_ONE_WORD_TEST) {
    console.log(`[voice-route-check] SKIP_ONE_WORD_TEST set - skipping one-word test`);
  } else {
    const beforeCount = messages.length;
    const { status: oneStatus, json: oneJson } = await postVoice(ONEWORD_WAV, false);
    console.log(`[voice-route-check] one-word POST /company/assistant/voice -> ${oneStatus}`);
    console.log(JSON.stringify(oneJson, null, 2));
    assert(oneStatus === 200 && oneJson.ok === false && oneJson.error === "didnt_catch", "one-word should return didnt_catch");
    assert(oneJson.message === "Didn't catch that", "didnt_catch message must match spec");
    const { json: threadAfterJson } = await getThread(5);
    const afterCount = Array.isArray(threadAfterJson.messages) ? threadAfterJson.messages.length : 0;
    assert(afterCount === beforeCount, `one-word order should not create a thread entry (${beforeCount} -> ${afterCount})`);
    console.log(`[voice-route-check] one-word order correctly created no thread entry`);
  }

  // 5. Typed route still works.
  const { status: typedStatus, json: typedJson } = await postTyped("Hello assistant, this is a typed test.");
  assert(typedStatus === 200 && typedJson.reply, "typed route should return a normal reply");
  console.log(`[voice-route-check] typed route OK: ${JSON.stringify({ status: typedStatus, reply: typedJson.reply }).slice(0, 200)}`);

  console.log(`[voice-route-check] ALL PASS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
