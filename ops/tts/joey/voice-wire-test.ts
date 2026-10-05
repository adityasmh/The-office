// JOEY-WIRE (fleet order fomun56n41 / JOEY-WIRE) unit + live test for
// speakAssistantReply, the spoken-text cleaner and the on/off voice flag.
//
// RESTORED into the shared project by the close-out order fomunj3jpb/WO1.
// The original ran from a scratch folder outside the repo
// (%TEMP%\jcode-isolated\fleet\fomun56n41\JOEY-WIRE\voice-test.ts) and its output was
// only ever written there, so from the project's point of view the test file and its
// output were missing. This copy lives in the shared tree and is runnable as-is.
//
// Part A (always): mocks global.fetch and checks the flag, the cleaner, the timing
//   budget and the dead-server path. TTS_PORT is pointed at a dead port BEFORE the
//   assistant module is loaded (dynamic import). The original set the env var at the
//   top of the file next to a static `import`, which ESM hoists - so its "dead port"
//   was really the default port 8901, which happened to be down at the time. Here the
//   dead port is genuinely dead.
// Part B (only when JOEY_LIVE_TTS_PORT is set): loads a second fresh copy of the
//   module bound to that port, calls speakAssistantReply() with the REAL fetch, and
//   proves the server saw the call and wrote a WAV.
//
// Run:  npx tsx ops/tts/joey/voice-wire-test.ts
//   live: set JOEY_LIVE_TTS_PORT=8911 first (a TTS server listening there)
import fs from "node:fs";
import path from "node:path";

const DEAD_PORT = process.env.JOEY_DEAD_TTS_PORT ?? "8999";
const LIVE_PORT = process.env.JOEY_LIVE_TTS_PORT ?? "";
process.env.TTS_PORT = DEAD_PORT; // must be set before the assistant module is loaded

let captured: { url?: string; body?: { text?: string } } | null = null;
const originalFetch = global.fetch;
const originalLog = console.log;
const originalWarn = console.warn;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Dynamic (not static) import so the TTS_PORT set above is in effect.
  const mod = await import("../../../src/company/assistant.js");
  const { speakAssistantReply, setAssistantVoiceEnabled, getAssistantVoiceEnabled } = mod;

  global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ms: 123, wavPath: "C:\\tmp\\joey.wav" }),
      text: async () => "",
    } as Response;
  };

  console.log("=== voice flag ===");
  console.log("default enabled:", getAssistantVoiceEnabled());
  setAssistantVoiceEnabled(false);
  console.log("after set false:", getAssistantVoiceEnabled());
  setAssistantVoiceEnabled(true);
  console.log("after set true:", getAssistantVoiceEnabled());

  console.log("\n=== cleaner sample ===");
  const dirty =
    'Here is `inline code` and a block: ```python\nprint("hello")\n```. ' +
    "Also a Windows path C:\\Users\\user\\file.txt and a URL https://example.com/page. " +
    "A relative path src/company/assistant.ts and a POSIX path /home/user/file.txt. " +
    "Markdown # header | table | row *bold* _underline_ remains.";
  captured = null;
  speakAssistantReply(dirty);
  await sleep(50);
  console.log("post url:", captured?.url ?? "(nothing)");
  console.log("captured text:", captured?.body?.text ?? "(nothing)");

  console.log("\n=== timing: voice on vs off ===");
  const text = "Done: the task is merged. Remaining: nothing. Needs you: nothing.";
  const runs = 1000;

  console.log = () => {}; // suppress the [voice] line from the tight loop
  setAssistantVoiceEnabled(true);
  captured = null;
  const t0on = performance.now();
  for (let i = 0; i < runs; i++) speakAssistantReply(text);
  const t1on = performance.now();
  await sleep(50);
  const capturedOn = captured?.body?.text ?? "";

  setAssistantVoiceEnabled(false);
  captured = null;
  const t0off = performance.now();
  for (let i = 0; i < runs; i++) speakAssistantReply(text);
  const t1off = performance.now();
  await sleep(50);
  const capturedOff = captured?.body?.text ?? "(skipped)";
  console.log = originalLog;

  console.log(`voice ON:  ${runs} calls in ${(t1on - t0on).toFixed(3)} ms (last captured body: ${capturedOn})`);
  console.log(`voice OFF: ${runs} calls in ${(t1off - t0off).toFixed(3)} ms (last captured body: ${capturedOff})`);
  const deltaMs = t1on - t0on - (t1off - t0off);
  console.log(`delta total: ${deltaMs.toFixed(3)} ms; per call: ${(deltaMs / runs).toFixed(6)} ms`);
  console.log(`under 100 ms slower: ${deltaMs < 100 ? "YES" : "NO"}`);

  console.log(`\n=== dead TTS server (port ${DEAD_PORT}) ===`);
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = () => {};
  global.fetch = originalFetch; // real fetch, so the dead port really fails
  setAssistantVoiceEnabled(true);
  captured = null;
  const before = performance.now();
  speakAssistantReply("Hello from Joey.");
  const after = performance.now();
  await sleep(5500); // the 5 s request timeout plus margin
  console.log = originalLog;
  console.warn = originalWarn;
  console.log(`reply path returned in ${(after - before).toFixed(3)} ms`);
  console.log("captured body:", captured?.body?.text ?? "(none)");
  console.log("warning count:", warnings.length);
  console.log("warning lines:", warnings);
  console.log("exactly one [voice] warning:", warnings.filter((w) => w.includes("[voice]")).length === 1 ? "YES" : "NO");

  // ---------------------------------------------------------------- Part B
  if (!LIVE_PORT) {
    console.log("\n=== live TTS check: SKIPPED (set JOEY_LIVE_TTS_PORT=<port> to run it) ===");
    global.fetch = originalFetch;
    return;
  }

  console.log(`\n=== live TTS check (port ${LIVE_PORT}) ===`);
  // A second, fresh copy of the module, because TTS_URL is built once at import time.
  process.env.TTS_PORT = LIVE_PORT;
  const live = await import(`../../../src/company/assistant.js?live=${Date.now()}`);
  const liveSpeak = live.speakAssistantReply as (t: string) => void;
  live.setAssistantVoiceEnabled(true);
  const base = `http://127.0.0.1:${LIVE_PORT}`;

  const healthBefore = (await (await fetch(`${base}/tts/health`)).json()) as {
    ok?: boolean;
    voice?: string;
    ready?: boolean;
    engine?: string;
    calls?: number;
  };
  console.log("health before:", JSON.stringify(healthBefore));

  const phrase =
    "Joey is speaking this sentence through the local text to speech server. It mentions a file path src/company/assistant.ts and some code.";
  liveSpeak(phrase);
  await sleep(2500);

  const healthAfter = (await (await fetch(`${base}/tts/health`)).json()) as {
    calls?: number;
    engine?: string;
    voice?: string;
    ready?: boolean;
  };
  console.log("health after:", JSON.stringify(healthAfter));
  const serverSawCall =
    typeof healthBefore.calls === "number" && typeof healthAfter.calls === "number"
      ? healthAfter.calls > healthBefore.calls
      : null;
  console.log(
    "server call counter increased:",
    serverSawCall === null ? "(counter unavailable)" : serverSawCall ? "YES" : "NO",
  );

  // A direct synth, so the WAV is asserted on disk rather than inferred.
  const directRes = await fetch(`${base}/tts/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "This sentence is synthesised directly to prove the wav lands on disk.", play: false }),
  });
  const direct = (await directRes.json()) as {
    ok?: boolean;
    wavPath?: string;
    bytes?: number;
    ms?: number;
    engine?: string;
    voice?: string;
  };
  console.log("direct speak:", JSON.stringify(direct));
  const wavOnDisk = direct.wavPath ? fs.existsSync(direct.wavPath) : false;
  console.log(
    "wav on disk:",
    wavOnDisk ? `YES (${fs.statSync(direct.wavPath as string).size} bytes) ${path.basename(direct.wavPath as string)}` : "NO",
  );

  // The stand-in is the Windows SAPI voice ("Microsoft David Desktop") until the CEO
  // supplies a reference clip; with the qwen3 engine up, voice is "Joey" instead.
  const voiceOk = healthAfter.voice === "Joey" || healthAfter.engine === "windows-sapi";
  console.log(
    "LIVE CHECK RESULT:",
    healthAfter.ready === true && voiceOk && serverSawCall === true && direct.ok === true && wavOnDisk ? "PASS" : "FAIL",
  );
  global.fetch = originalFetch;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
