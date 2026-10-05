// ops/laya-control-check.ts - LAYA-CTL + LAYA-UX proof
// (docs/ORDER_2026-10-06_laya-ctl.md, docs/ORDER_2026-10-06_laya-ux.md).
//
//   npx tsx ops/laya-control-check.ts
//
// Proves, WITHOUT touching the live box (fake process lists, fake health, fake nvidia-smi
// output, fake spawn/stop only - nothing is ever stopped or started, no server is run):
//   LAYA-CTL (kept):
//     1. layaPids() returns only the two Laya pids from a mixed list;
//     2. layaPids() returns [] when no Laya process is present;
//     3. the nvidia-smi parser handles a normal line, empty output and a not-found error;
//     4. startLaya() refuses when fake health says Laya already answers, and never spawns;
//     5. fake-health layaStatus() returns gpu: null when nvidia-smi is unavailable.
//   LAYA-UX (new):
//     6. status derivation: process + health down = `starting`; no process + health down past
//        the grace period = `lastStartError`; health up = running; nothing = down;
//     7. switch sequence: stop is called before start, the start device is the opposite of
//        the current one, and a failing fake stop means no start;
//     8. the headroom line appears for 1.6 GB free and not for 5.0 GB;
//     9. the CPU-fallback notice appears when a fake health reports a fallback count above 0;
//    10. the log-tail helper redacts a token-shaped string and is capped at 600 characters.
//
// Exit code 0 = all pass. Read-only: it spawns nothing and stops nothing.

import {
  cpuFallbackNotice, gpuHeadroomWarning, layaPids, layaStatus, logTail, parseGpuQuery, readGpu,
  setPendingStartForTests, startLaya, switchLaya,
  type ExecFn, type GpuInfo, type HealthResult, type ProcInput,
} from "../src/company/layaControl.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!ok) failures += 1;
}

const notFoundExec: ExecFn = async () => ({
  ok: false,
  stdout: "",
  stderr: "'nvidia-smi' is not recognized as an internal or external command, operable program or batch file.",
  error: "Command failed: nvidia-smi",
});

/** Fake nvidia-smi that answers the first query with a fixed GPU line. */
function gpuExec(line: string): ExecFn {
  return async (_cmd, args) => ({
    ok: true,
    stdout: args[0].includes("compute-apps") ? "" : line,
    stderr: "",
  });
}

const downHealth = async (): Promise<HealthResult> => ({ ok: false, detail: "fetch failed" });
const upGpuHealth = async (): Promise<HealthResult> => ({
  ok: true,
  json: { status: "ok", device: "cuda:0", loaded: ["typed-decisions"], checkpoint_devices: { "typed-decisions": "cuda:0" } },
});

const LAYA_PROC: ProcInput[] = [
  { pid: 7001, name: "python.exe", commandLine: '"python.exe" -c "import laya.serve"' },
];

async function main(): Promise<void> {
  /* ---------------------------------------------------------------- LAYA-CTL */

  // 1. only the two Laya pids come back, from a mixed list.
  const fakeList: ProcInput[] = [
    { pid: 4100, name: "node.exe", commandLine: '"C:\\Program Files\\nodejs\\node.exe" src/server.ts' },
    { pid: 4101, name: "jcode.exe", commandLine: 'jcode --resume session_rose_abc123' },
    { pid: 4102, name: "python.exe", commandLine: '"python.exe" -m http.server 9000' },
    { pid: 4103, name: "python.exe", commandLine: '"C:\\Users\\user\\Desktop\\Default Project\\deps\\venv\\Scripts\\python.exe" -c "import laya.serve"' },
    { pid: 4104, name: "python.exe", commandLine: '"python.exe" "C:\\Users\\user\\Desktop\\Default Project\\scripts\\laya-gpu-boot.py"' },
  ];
  const pids = layaPids(fakeList);
  check(
    "layaPids returns exactly the two Laya pids from the mixed list",
    pids.length === 2 && pids.includes(4103) && pids.includes(4104),
    `got [${pids.join(", ")}] (expected [4103, 4104]; router/jcode/http.server excluded)`,
  );

  // 2. no Laya process -> empty list.
  const noLaya: ProcInput[] = [
    { pid: 5000, name: "node.exe", commandLine: "node src/server.ts" },
    { pid: 5001, name: "python.exe", commandLine: '"python.exe" -m http.server 9000' },
    { pid: 5002, name: "jcode.exe", commandLine: "jcode" },
  ];
  check(
    "layaPids returns [] when no Laya process is present",
    layaPids(noLaya).length === 0,
    `got [${layaPids(noLaya).join(", ")}]`,
  );

  // 3. parser robustness: normal line, empty output, "not found" exec.
  const normal = parseGpuQuery("NVIDIA GeForce RTX 4050 Laptop GPU, 1234, 6144");
  const empty = parseGpuQuery("");
  let notFoundThrew = false;
  let notFound: { gpu: unknown } = { gpu: "unset" };
  try {
    notFound = await readGpu(notFoundExec);
  } catch {
    notFoundThrew = true;
  }
  check(
    "the nvidia-smi parser handles a normal line, empty output and a not-found error",
    normal !== null && normal.name === "NVIDIA GeForce RTX 4050 Laptop GPU" &&
      normal.usedMiB === 1234 && normal.totalMiB === 6144 &&
      empty === null && !notFoundThrew && notFound.gpu === null,
    `normal=${JSON.stringify(normal)} empty=${JSON.stringify(empty)} notFound=${JSON.stringify(notFound)} threw=${notFoundThrew}`,
  );

  // 4. startLaya refuses when Laya already answers (and never spawns).
  let spawned = false;
  const refused = await startLaya({
    device: "gpu",
    health: async () => ({ ok: true, json: { status: "ok" } }),
    spawn: async () => { spawned = true; return 424242; },
  });
  check(
    "startLaya refuses when a fake health check says Laya already answers",
    refused.started === false && refused.refused === true && spawned === false,
    `result=${JSON.stringify(refused)} spawnCalled=${spawned}`,
  );

  // 5. fake-health status with no nvidia-smi -> gpu null (and no process touched).
  const status = await layaStatus({
    health: async () => ({
      ok: true,
      json: { status: "ok", device: "cuda:0", loaded: ["typed-decisions"], checkpoint_devices: { "typed-decisions": "cuda:0" } },
    }),
    processes: async () => [],
    exec: notFoundExec,
  });
  check(
    "a fake-health layaStatus returns gpu: null when nvidia-smi is unavailable",
    status.gpu === null && status.ok === true,
    `status=${JSON.stringify(status)}`,
  );

  /* ---------------------------------------------------------------- LAYA-UX */

  // 6. status derivation: starting / lastStartError / running / down.
  const NOW = 1_800_000_000_000;
  setPendingStartForTests({ device: "gpu", at: NOW - 30_000 });
  const startingStatus = await layaStatus({
    health: downHealth,
    processes: async () => LAYA_PROC,
    exec: gpuExec("NVIDIA GeForce RTX 4050 Laptop GPU, 4506, 6144"),
    now: () => NOW,
  });

  setPendingStartForTests({ device: "cpu", at: NOW - 25_000 });
  const failedStatus = await layaStatus({
    health: downHealth,
    processes: async () => [],
    exec: notFoundExec,
    now: () => NOW,
  });

  setPendingStartForTests({ device: "gpu", at: NOW - 25_000 });
  const runningStatus = await layaStatus({
    health: upGpuHealth,
    processes: async () => LAYA_PROC,
    exec: gpuExec("NVIDIA GeForce RTX 4050 Laptop GPU, 1000, 6144"),
    now: () => NOW,
  });

  setPendingStartForTests(null);
  const downStatus = await layaStatus({
    health: downHealth,
    processes: async () => [],
    exec: notFoundExec,
    now: () => NOW,
  });

  check(
    "status: process + health down is `starting`; no process + health down past the grace period is `lastStartError`",
    startingStatus.starting !== null && startingStatus.starting.device === "gpu" &&
      startingStatus.starting.sinceSec === 30 && startingStatus.lastStartError === null &&
      failedStatus.starting === null && typeof failedStatus.lastStartError === "string" &&
      failedStatus.lastStartError.includes("did not start on CPU"),
    `starting=${JSON.stringify(startingStatus.starting)} failedError=${JSON.stringify(failedStatus.lastStartError)}`,
  );
  check(
    "status: health up is running; nothing is down",
    runningStatus.ok === true && runningStatus.starting === null && runningStatus.lastStartError === null &&
      downStatus.ok === false && downStatus.starting === null && downStatus.lastStartError === null,
    `running={ok:${runningStatus.ok},starting:${JSON.stringify(runningStatus.starting)}} down={ok:${downStatus.ok},starting:${JSON.stringify(downStatus.starting)},err:${JSON.stringify(downStatus.lastStartError)}}`,
  );

  // 7. switch sequence: stop before start, opposite device, and no start when stop fails.
  const calls: string[] = [];
  let afterStop: HealthResult = await upGpuHealth();
  const okSwitch = await switchLaya({
    health: async () => afterStop,
    stop: async () => {
      calls.push("stop");
      afterStop = { ok: false, detail: "down" };
      return { stopped: [7001], freedMiB: 4096 };
    },
    start: async (device) => { calls.push("start:" + device); return { started: true, pid: 7002 }; },
    waitMs: 0,
  });

  const failCalls: string[] = [];
  const thrownStop = await switchLaya({
    health: upGpuHealth,
    stop: async () => { failCalls.push("stop"); throw new Error("access denied"); },
    start: async (device) => { failCalls.push("start:" + device); return { started: true, pid: 1 }; },
    waitMs: 0,
  });

  const stuckCalls: string[] = [];
  const stuckStop = await switchLaya({
    health: upGpuHealth, // still answering after the stop, so the wait must give up
    stop: async () => { stuckCalls.push("stop"); return { stopped: [7001], freedMiB: 0 }; },
    start: async (device) => { stuckCalls.push("start:" + device); return { started: true, pid: 1 }; },
    waitMs: 120,
    pollMs: 50,
  });

  check(
    "switch: stop runs before start and starts the opposite device",
    calls.join(",") === "stop,start:cpu" && okSwitch.switched === true && okSwitch.from === "gpu" && okSwitch.to === "cpu",
    `calls=[${calls.join(", ")}] result=${JSON.stringify(okSwitch)}`,
  );
  check(
    "switch: a failing fake stop means no start (thrown error and still-answering cases)",
    thrownStop.switched === false && thrownStop.failedAt === "stop" && !failCalls.includes("start:gpu") && !failCalls.includes("start:cpu") &&
      stuckStop.switched === false && stuckStop.failedAt === "wait" && !stuckCalls.some((c) => c.startsWith("start:")),
    `thrown=${JSON.stringify(thrownStop)} thrownCalls=[${failCalls.join(", ")}] stuck=${JSON.stringify(stuckStop)} stuckCalls=[${stuckCalls.join(", ")}]`,
  );

  // 8. headroom line: 1.6 GB free warns (6144 - 4506 = 1638 MiB), 5.0 GB free does not.
  const lowFree: GpuInfo | null = parseGpuQuery("NVIDIA GeForce RTX 4050 Laptop GPU, 4506, 6144");
  const highFree: GpuInfo | null = parseGpuQuery("NVIDIA GeForce RTX 4050 Laptop GPU, 3072, 8192");
  const warn = gpuHeadroomWarning(lowFree);
  const noWarn = gpuHeadroomWarning(highFree);
  check(
    "headroom: the warning appears for 1.6 GB free and not for 5.0 GB",
    warn !== null && /1\.6 GB free/.test(warn) && /needs about 4\.0 GB/.test(warn) && noWarn === null,
    `1.6GB=${JSON.stringify(warn)} 5.0GB=${JSON.stringify(noWarn)}`,
  );

  // 9. CPU-fallback notice: a fake health with a fallback count above 0 says so.
  const fallbackStatus = await layaStatus({
    health: async () => ({
      ok: true,
      json: {
        status: "ok",
        device: "cuda:0",
        loaded: ["typed-decisions"],
        checkpoint_devices: { "typed-decisions": "cuda:0" },
        cpu_fallbacks: { "typed-decisions": { count: 2, last_reason: "CUDA out of memory" } },
      },
    }),
    processes: async () => [],
    exec: notFoundExec,
  });
  const cleanNotice = cpuFallbackNotice({
    requestedDevice: "gpu",
    checkpointDevices: { "typed-decisions": "cuda:0" },
    cpuFallbacks: { "typed-decisions": 0 },
  });
  check(
    "fallback: the CPU-fallback notice appears when a count is above 0",
    fallbackStatus.fallbackNotice === "Some models fell back to CPU" &&
      fallbackStatus.cpuFallbacks["typed-decisions"] === 2 && cleanNotice === null,
    `statusNotice=${JSON.stringify(fallbackStatus.fallbackNotice)} counts=${JSON.stringify(fallbackStatus.cpuFallbacks)} clean=${JSON.stringify(cleanNotice)}`,
  );

  // 10. log tail: token-shaped text is redacted and the result is capped at 600 characters.
  const TOKEN = "sk-live-abcdefghijklmnop1234567890";
  const longLog = Array.from({ length: 40 }, (_, i) => `boot line ${i} ` + "x".repeat(40)).join("\n");
  const tail = logTail([
    { label: "logs/laya.err.log", text: `first\nsecond\n${TOKEN}\nlast error line` },
    { label: "logs/laya.out.log", text: longLog },
  ]);
  check(
    "log tail: redacts a token-shaped string and is capped at 600 characters",
    tail.length <= 600 && !tail.includes(TOKEN) && tail.includes("[redacted]") && tail.includes("last error line"),
    `length=${tail.length} redacted=${tail.includes("[redacted]")} tokenLeaked=${tail.includes(TOKEN)}`,
  );

  setPendingStartForTests(null);

  console.log("");
  if (failures > 0) {
    console.log(`LAYA-CONTROL CHECK FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("LAYA-CONTROL CHECK ALL PASS (layaPids narrow, nvidia-smi parser safe, startLaya refuses early, starting/lastStartError derived, switch stops before it starts, headroom + fallback + redacted log tail)");
}

void main();
