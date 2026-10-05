// ops/laya-control-check.ts - LAYA-CTL proof (docs/ORDER_2026-10-06_laya-ctl.md).
//
//   npx tsx ops/laya-control-check.ts
//
// Proves the five properties the order asks for, WITHOUT touching the live box:
//   1. layaPids() returns only the two Laya pids from a fake list that also contains
//      a router node process, a jcode process and an unrelated python.exe;
//   2. layaPids() returns [] when no Laya process is present;
//   3. the nvidia-smi parser handles a normal line, empty output and a "not found"
//      error (readGpu with a failing exec) without throwing;
//   4. startLaya() refuses when a fake health check says Laya already answers, and
//      never reaches the spawn seam;
//   5. a fake-health layaStatus() returns gpu: null when nvidia-smi is unavailable.
//
// Exit code 0 = all pass. Read-only: it spawns nothing and stops nothing.

import {
  layaPids, layaStatus, parseGpuQuery, readGpu, startLaya,
  type ExecFn, type ProcInput,
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

async function main(): Promise<void> {
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

  console.log("");
  if (failures > 0) {
    console.log(`LAYA-CONTROL CHECK FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("LAYA-CONTROL CHECK ALL PASS (layaPids narrow, nvidia-smi parser safe, startLaya refuses early)");
}

void main();
