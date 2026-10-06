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
//   ORDER U1 (new):
//    11. `lastAction` is null before any action, a successful switch records its device and an
//        ISO time, a failed switch records its reason, and `layaStatus()` returns the record;
//    12. the GPU-bar wording helper says "other programs" for CPU, "Laya uses X of Y" for a
//        known GPU share, and "not reported by Windows" when the share is null.
//   ORDER U2 (new):
//    13. the counter parser turns fake Get-Counter rows into entries and drops anything at or
//        below 20 MB (both the one-line and the two-line form);
//    14. label mapping: laya -> "Laya", tts -> "Voice, text to speech", stt -> "Voice, speech to
//        text", anything else the process name;
//    15. a command line never appears in the result, only the plain label;
//    16. an unavailable counter returns an empty list with a reason, never an error;
//    17. sorting: biggest first, newest process first on a tie;
//    18. the panel sentence appears only when Laya is on the CPU and a non-Laya user keeps more
//        than 1 GB, and the per-user line reads as specified.
//
// Exit code 0 = all pass. Read-only: it spawns nothing and stops nothing.

import {
  cpuFallbackNotice, getLastActionForTests, gpuBarLabel, gpuHeadroomWarning, gpuUserLabel, gpuUserLine,
  gpuUsers, gpuUsersNotice, lastActionText, layaPids, layaStatus, logTail, parseGpuCounter, parseGpuQuery,
  readGpu, setLastActionForTests, setPendingStartForTests, startLaya, switchLaya,
  type ExecFn, type GpuInfo, type GpuUser, type HealthResult, type ProcInput,
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

  /* ------------------------------------------------------ ORDER U1 (clarity) */

  // 11. `lastAction` is null before any action has happened.
  setLastActionForTests(null);
  const freshStatus = await layaStatus({
    health: downHealth,
    processes: async () => [],
    exec: notFoundExec,
  });
  check(
    "lastAction: null before any action (status and helper both say null)",
    freshStatus.lastAction === null && getLastActionForTests() === null,
    `status.lastAction=${JSON.stringify(freshStatus.lastAction)} helper=${JSON.stringify(getLastActionForTests())}`,
  );

  // 12. a successful switch records the device it switched to, and a parseable time.
  setLastActionForTests(null);
  let okAfterStop: HealthResult = await upGpuHealth();
  const switchedOk = await switchLaya({
    health: async () => okAfterStop,
    stop: async () => { okAfterStop = { ok: false, detail: "down" }; return { stopped: [7001], freedMiB: 4096 }; },
    start: async () => ({ started: true, pid: 7002 }),
    waitMs: 0,
  });
  const okAction = getLastActionForTests();
  const okActionStatus = await layaStatus({
    health: downHealth,
    processes: async () => [],
    exec: notFoundExec,
  });
  const okWords = lastActionText(okAction, { hm: () => "15:02" });
  check(
    "lastAction: records a successful switch with device and time, and layaStatus returns it",
    switchedOk.switched === true && okAction !== null && okAction.kind === "switch" &&
      okAction.device === "cpu" && okAction.ok === true && !isNaN(new Date(okAction.at).getTime()) &&
      okActionStatus.lastAction !== null && okActionStatus.lastAction.kind === "switch" &&
      okActionStatus.lastAction.device === "cpu" && okActionStatus.lastAction.ok === true &&
      /^Switched to CPU at 15:02 \(Laya is now answering on CPU\)$/.test(String(okWords)),
    `result=${JSON.stringify(switchedOk)} action=${JSON.stringify(okAction)} status=${JSON.stringify(okActionStatus.lastAction)} words=${JSON.stringify(okWords)}`,
  );

  // 13. a failed switch records its reason, and the status returns the failure.
  setLastActionForTests(null);
  const switchedFail = await switchLaya({
    health: upGpuHealth,
    stop: async () => { throw new Error("access denied"); },
    start: async () => ({ started: true, pid: 1 }),
    waitMs: 0,
  });
  const failAction = getLastActionForTests();
  const failActionStatus = await layaStatus({
    health: downHealth,
    processes: async () => [],
    exec: notFoundExec,
  });
  const failWords = lastActionText(failAction, { hm: () => "15:02" });
  check(
    "lastAction: records a failed switch with a reason, and layaStatus returns it",
    switchedFail.switched === false && switchedFail.failedAt === "stop" &&
      failAction !== null && failAction.kind === "switch" && failAction.ok === false &&
      failAction.device === "cpu" && /access denied/.test(String(failAction.note)) &&
      failActionStatus.lastAction !== null && failActionStatus.lastAction.ok === false &&
      /^Switch to CPU failed at 15:02: .*access denied/.test(String(failWords)),
    `result=${JSON.stringify(switchedFail)} action=${JSON.stringify(failAction)} status=${JSON.stringify(failActionStatus.lastAction)} words=${JSON.stringify(failWords)}`,
  );

  // 14. the GPU-bar wording helper: other programs on CPU, "Laya uses X of Y" on GPU with a
  //     known share, "not reported by Windows" when the share is null.
  const barCpu = gpuBarLabel({ device: "cpu", layaGpuMiB: 1234, totalMiB: 6144 });
  const barGpu = gpuBarLabel({ device: "cuda:0", layaGpuMiB: 1234, totalMiB: 6144 });
  const barUnknown = gpuBarLabel({ device: "cuda:0", layaGpuMiB: null, totalMiB: 6144 });
  check(
    "gpu bar wording: other-programs for CPU, Laya uses X of Y for a known GPU share, not-reported for a null share",
    /other programs/.test(barCpu) && /none of this is Laya/.test(barCpu) &&
      /^Laya uses 1\.2 GB of 6\.0 GB$/.test(barGpu) &&
      /not reported by Windows/.test(barUnknown),
    `cpu=${JSON.stringify(barCpu)} gpu=${JSON.stringify(barGpu)} unknown=${JSON.stringify(barUnknown)}`,
  );

  setLastActionForTests(null);

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
  const TOKEN = "sk" + "-live-abcdefghijklmnop1234567890";
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

  /* ---------------------------------------------------------- ORDER U2 (GPU users) */

  // 13. the counter parser turns fake rows into entries and drops anything at or below 20 MB.
  const counterOut = [
    "pid_6668_luid_0x00000_0x0000C1CC_phys_0 3103784960",
    '"pid_7001_luid_0x00000_0x0000C1CC_phys_0","52428800"',
    "pid_9999_luid_0x00000_0x0000C1CC_phys_0 8388608",
  ].join("\n");
  const parsed = parseGpuCounter(counterOut);
  check(
    "gpuUsers parsing: fake counter rows become entries and anything at or below 20 MB is dropped",
    parsed.length === 2 && parsed[0].pid === 6668 && parsed[0].mb === 2960 &&
      parsed[1].pid === 7001 && parsed[1].mb === 50 && !parsed.some((e) => e.pid === 9999),
    `parsed=${JSON.stringify(parsed)}`,
  );

  // 13b. the pretty Get-Counter form: instance name on one line, the byte value on the next.
  const prettyOut = [
    "\\\\PC\\gpu process memory(pid_6668_luid_0x0_phys_0)\\dedicated usage :",
    "                          3103784960",
  ].join("\n");
  const pretty = parseGpuCounter(prettyOut);
  check(
    "gpuUsers parsing: the two-line Get-Counter form is read too",
    pretty.length === 1 && pretty[0].pid === 6668 && pretty[0].mb === 2960,
    `pretty=${JSON.stringify(pretty)}`,
  );

  // 14. label mapping: laya, tts, stt, an unknown python and a non-python process.
  const labelLaya = gpuUserLabel("python.exe", '"python.exe" -c "import laya.serve"');
  const labelTts = gpuUserLabel("python.exe", '"python.exe" "C:\\tools\\tts_server.py"');
  const labelStt = gpuUserLabel("python.exe", '"python.exe" "C:\\tools\\stt_server.py"');
  const labelPlain = gpuUserLabel("python.exe", '"python.exe" -m http.server 9000');
  const labelNode = gpuUserLabel("node.exe", "node src/server.ts");
  check(
    "gpuUsers labels: laya, tts and stt map to plain phrases, anything else uses the process name",
    labelLaya === "Laya" && labelTts === "Voice, text to speech" && labelStt === "Voice, speech to text" &&
      labelPlain === "python.exe" && labelNode === "node.exe",
    `laya=${JSON.stringify(labelLaya)} tts=${JSON.stringify(labelTts)} stt=${JSON.stringify(labelStt)} plain=${JSON.stringify(labelPlain)} node=${JSON.stringify(labelNode)}`,
  );

  // 15. a command line never appears in the result, only the plain label.
  const CMD_MARK = "SECRET-cmdline-marker-9f3a";
  const fakeProcs: ProcInput[] = [
    { pid: 6668, name: "python.exe", commandLine: `"python.exe" "C:\\tools\\tts_server.py" ${CMD_MARK}`, created: "2026-10-06T08:00:00.000Z" },
    { pid: 7001, name: "python.exe", commandLine: '"python.exe" -c "import laya.serve"', created: "2026-10-06T09:00:00.000Z" },
  ];
  const counterExec: ExecFn = async () => ({ ok: true, stdout: counterOut, stderr: "" });
  const usersResult = await gpuUsers(counterExec, fakeProcs);
  const usersJson = JSON.stringify(usersResult);
  check(
    "gpuUsers result carries a plain label and never the command line",
    usersResult.users.length === 2 && usersResult.reason === null &&
      usersResult.users[0].label === "Voice, text to speech" && usersResult.users[1].label === "Laya" &&
      !usersJson.includes(CMD_MARK) && !usersJson.includes("tts_server.py") && !usersJson.includes("laya.serve"),
    `users=${JSON.stringify(usersResult.users)} leaked=${usersJson.includes(CMD_MARK)}`,
  );

  // 16. an unavailable counter returns an empty list with a reason, never an error.
  let usersThrew = false;
  let unavailable: Awaited<ReturnType<typeof gpuUsers>> = { users: [], reason: null };
  try {
    unavailable = await gpuUsers(notFoundExec, fakeProcs);
  } catch {
    usersThrew = true;
  }
  check(
    "gpuUsers: an unavailable counter returns an empty list with a reason, never an error",
    !usersThrew && unavailable.users.length === 0 &&
      typeof unavailable.reason === "string" && unavailable.reason.length > 0,
    `threw=${usersThrew} result=${JSON.stringify(unavailable)}`,
  );

  // 17. sorting: biggest first, and newest process first when two sizes tie.
  const tieProcs: ProcInput[] = [
    { pid: 100, name: "python.exe", commandLine: "python tts_old.py", created: "2026-10-06T07:00:00.000Z" },
    { pid: 200, name: "python.exe", commandLine: "python tts_new.py", created: "2026-10-06T09:00:00.000Z" },
    { pid: 300, name: "python.exe", commandLine: "python big.py", created: "2026-10-06T06:00:00.000Z" },
  ];
  const tieOut = [
    "pid_100_phys_0 104857600",
    "pid_200_phys_0 104857600",
    "pid_300_phys_0 2097152000",
  ].join("\n");
  const sorted = await gpuUsers(async () => ({ ok: true, stdout: tieOut, stderr: "" }), tieProcs);
  check(
    "gpuUsers sorting: biggest first, and the newest process first when two sizes tie",
    sorted.users.map((u) => u.pid).join(",") === "300,200,100",
    `order=[${sorted.users.map((u) => u.pid + ":" + u.mb + "mb").join(", ")}]`,
  );

  // 18. the panel sentence and the per-user line: the sentence only when Laya is on the CPU and
  //     a non-Laya user keeps more than 1 GB; one line per user as specified.
  const ttsUser: GpuUser = { pid: 6668, name: "python.exe", label: "Voice, text to speech", mb: 2960 };
  const layaUser: GpuUser = { pid: 7001, name: "python.exe", label: "Laya", mb: 4096 };
  const smallUser: GpuUser = { pid: 8000, name: "node.exe", label: "node.exe", mb: 900 };
  const noticeCpu = gpuUsersNotice("cpu", [ttsUser]);
  const noticeGpu = gpuUsersNotice("cuda:0", [ttsUser]);
  const noticeLayaOnly = gpuUsersNotice("cpu", [layaUser]);
  const noticeSmall = gpuUsersNotice("cpu", [smallUser]);
  const userLine = gpuUserLine(ttsUser);
  check(
    "gpuUsers panel wording: the sentence appears only for Laya-on-CPU with a non-Laya user over 1 GB",
    noticeCpu === "To give Laya the GPU, this program has to stop or restart first" &&
      noticeGpu === null && noticeLayaOnly === null && noticeSmall === null &&
      userLine === "Voice, text to speech (python, pid 6668): 2.9 GB",
    `cpu=${JSON.stringify(noticeCpu)} gpu=${JSON.stringify(noticeGpu)} layaOnly=${JSON.stringify(noticeLayaOnly)} small=${JSON.stringify(noticeSmall)} line=${JSON.stringify(userLine)}`,
  );

  console.log("");
  if (failures > 0) {
    console.log(`LAYA-CONTROL CHECK FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("LAYA-CONTROL CHECK ALL PASS (layaPids narrow, nvidia-smi parser safe, startLaya refuses early, starting/lastStartError derived, switch stops before it starts, headroom + fallback + redacted log tail, GPU users named by plain label)");
}

void main();
