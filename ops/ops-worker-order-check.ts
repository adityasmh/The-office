// ops-worker-order-check.ts — the Proof for order OPSF3B-ops-worker-order.
//
// Offline: a fake process table, fake sessions and injected deps only. No
// router, no server, no real company/ folder (the FIRST import points
// COMPANY_ROOT at a temp dir; docs/PITFALLS.md item 1).
//
//   node_modules/.bin/tsx ops/ops-worker-order-check.ts
//
// PASS or FAIL for:
//   4101  cmd with no order text -> order read from the session's task
//         (ZZ9-sample-order)
//   4102  an order named on the command line wins over the session
//         (QQ1-from-cmd)
//   4103  a worker with no session reports no order (undefined)
//   4104  a session without a taskId reports no order (undefined)
//   4105  a task that cannot be found reports no order (undefined)
//   4106  a task lookup that throws reports no order and does not throw
//   src   source contains the rowFor fallback
//         parseOrderId(p.cmd) ?? orderFromSession(session, d)

import "./sandbox-company-root.js";

import { readFileSync } from "node:fs";
import path from "node:path";

import type { TaskRec } from "../src/company/gates.js";
import type { SessionRec } from "../src/company/sessions.js";
import { classifyWorkers, type OpsDeps, type ProcessRow } from "../src/company/opsView.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const min = (n: number) => new Date(NOW - n * 60_000).toISOString();

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
}

function end(): never {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail === 0) console.log("ALL PASS");
  process.exit(fail === 0 ? 0 : 1);
}

const proc = (pid: number, cmd: string): ProcessRow => ({
  pid,
  name: "opencode.exe",
  cmd,
  started: min(20),
  memMB: 300,
  hwnd: 0,
});

const session = (over: Partial<SessionRec> & Pick<SessionRec, "id" | "projectId" | "pid">): SessionRec => ({
  agentId: "coder-1",
  agentName: "coder-1",
  role: "coder",
  departmentId: "d",
  departmentName: "Eng",
  projectName: "Alpha",
  taskId: null,
  taskTitle: "",
  model: "m",
  status: "running",
  startedAt: min(5),
  ...over,
});

const task = (over: Partial<TaskRec> & Pick<TaskRec, "id" | "projectId">): TaskRec => ({
  rawRequest: "",
  status: "coding",
  gates: { intake: false, code: false, merge: false },
  createdAt: min(60),
  updatedAt: min(60),
  loopCount: 0,
  ...over,
});

const deps: OpsDeps = {
  getSessionTail: () => undefined,
  listSessions: () => [
    session({ id: "s4101", projectId: "p1", pid: 4101, taskId: "t4101", startedAt: min(25) }),
    session({ id: "s4102", projectId: "p1", pid: 4102, taskId: "t4102", startedAt: min(35) }),
    session({ id: "s4103", projectId: "p1", pid: 9999, taskId: "t4103", startedAt: min(15) }),
    session({ id: "s4104", projectId: "p1", pid: 4104, taskId: null, startedAt: min(15) }),
    session({ id: "s4105", projectId: "p1", pid: 4105, taskId: "t4105", startedAt: min(15) }),
    session({ id: "s4106", projectId: "p1", pid: 4106, taskId: "t4106", startedAt: min(15) }),
  ],
  getTaskFn: (_projectId: string, taskId: string): TaskRec | undefined => {
    if (taskId === "t4101")
      return task({ id: "t4101", projectId: "p1", rawRequest: "# Order ZZ9-sample-order: x", updatedAt: min(3) });
    if (taskId === "t4102")
      return task({ id: "t4102", projectId: "p1", rawRequest: "# Order WW9-from-session: z", updatedAt: min(4) });
    if (taskId === "t4105") return undefined; // the task is gone / not found
    if (taskId === "t4106") throw new Error("the task store is unavailable");
    return task({ id: taskId, projectId: "p1", rawRequest: "# Order NN9-never-reached: q" });
  },
};

const table = {
  processes: [
    proc(4101, "opencode.exe --run 'coding' --auto"),
    proc(4102, "opencode.exe run '# Order QQ1-from-cmd: y' --auto"),
    proc(4103, "opencode.exe --run 'coding' --auto"),
    proc(4104, "opencode.exe --run 'coding' --auto"),
    proc(4105, "opencode.exe --run 'coding' --auto"),
    proc(4106, "opencode.exe --run 'coding' --auto"),
  ],
};

let rows: ReturnType<typeof classifyWorkers> = [];
let escaped: unknown;
try {
  rows = classifyWorkers(table, NOW, deps);
} catch (e) {
  escaped = e;
}
const orderOf = (pid: number): string | undefined => rows.find((w) => w.pid === pid)?.orderId;

check(
  "4101 a cmd with no order text takes the order from its session's task (ZZ9-sample-order)",
  orderOf(4101) === "ZZ9-sample-order",
);
check(
  "4102 the order named on the command line wins over the session (QQ1-from-cmd)",
  orderOf(4102) === "QQ1-from-cmd",
);
check("4103 a worker with no session reports no order", orderOf(4103) === undefined);
check("4104 a session without a taskId reports no order", orderOf(4104) === undefined);
check("4105 a task that cannot be found reports no order", orderOf(4105) === undefined);
check(
  "4106 a task lookup that throws reports no order and does not throw",
  escaped === undefined && orderOf(4106) === undefined,
);

let source = "";
try {
  source = readFileSync(path.join(process.cwd(), "src", "company", "opsView.ts"), "utf8");
} catch (e) {
  console.log(`cannot read src/company/opsView.ts from ${process.cwd()}: ${String(e)}`);
}
check(
  "src rowFor falls back via parseOrderId(p.cmd) ?? orderFromSession(session, d)",
  /parseOrderId\(p\.cmd\)\s*\?\?\s*orderFromSession\(session,\s*d\)/.test(source),
);

end();
