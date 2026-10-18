/**
 * ops/company-expand-proof.ts - PROOF: per-project team config (docs/PROJECT_TEAM_SPEC.md).
 *
 *   npx tsx ops/company-expand-proof.ts [--port 8801] [--company-root <dir>]
 *
 * TARGET: the ISOLATED dev instance only.
 *   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name company-expand
 * Default target is http://127.0.0.1:8801 whose COMPANY_ROOT is dev\company-expand\company.
 * The live router (:8787) and the live company\ folder are NEVER contacted: every HTTP call
 * goes to 127.0.0.1:<dev port> and every file read/written is under the dev instance's own
 * company root. The shared control-plane token comes from the dev instance's own loopback
 * bootstrap endpoint and is never printed (only its header name and length).
 *
 * WHAT IT PROVES, in this order:
 *   1  POST /company/projects with team {coders:2, models:{coder:<routine model id>}} -> raw response
 *   2  the stored project record, read raw from the dev instance's own org.json
 *   3  PATCH /company/projects/:id/team merges a second role; the spec's 400s really fire
 *   4  the REAL dispatch path - chooseWorkerModel(text, {projectId, role}), exactly the call
 *      fleet.ts pickFleetModel and pipeline.ts make - returns the overridden model with a
 *      reason containing "project override"
 *   5  a project WITHOUT an override (and a project whose team sets only ANOTHER role) still
 *      gets the global CEO cost rule - bit-identical to calling with no project at all
 *   6  the fleet's own pickFleetModel(wo) shows the same on its call path
 *   7  the `npx tsc --noEmit` exit code of the tree this ran against
 *
 * Exits 0 only when every check passes.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PORT = Number(argOf("--port") ?? process.env.PROOF_PORT ?? 8801);
const BASE = `http://127.0.0.1:${PORT}`;
const DEV_ROOT = path.resolve(argOf("--company-root") ?? path.join("dev", "company-expand", "company"));

// Must be set BEFORE any src/company module is imported: org.ts reads it at module load.
process.env.COMPANY_ROOT = DEV_ROOT;
process.env.SLACK_BRIDGE = "0";
process.env.SLACK_SOCKET_MODE = "0";

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures += 1;
}
function head(title: string): void {
  console.log(`\n=== ${title} ===`);
}
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

type ApiResult = { status: number; text: string };
let tokenHeader = "x-company-token";
let token = "";

async function req(method: string, p: string, body?: unknown, withToken = false): Promise<ApiResult> {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(withToken && token ? { [tokenHeader]: token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return { status: res.status, text: await res.text() };
}

async function main(): Promise<void> {
  head("0. TARGET (isolated dev instance)");
  console.log(`dev base url : ${BASE}`);
  console.log(`company root : ${DEV_ROOT}`);
  const stateFile = path.join(path.dirname(path.dirname(DEV_ROOT)), "dev.json");
  if (fs.existsSync(stateFile)) {
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { port?: number; pid?: number; name?: string };
    console.log(`dev.json     : name=${st.name} port=${st.port} pid=${st.pid}`);
  }
  const health = await req("GET", "/health").catch(() => ({ status: 0, text: "" }));
  check("dev instance answers /health", health.status === 200, `HTTP ${health.status} - is the dev router up? (scripts\\dev-router.ps1 -Name company-expand)`);
  if (health.status !== 200) return;

  const boot = await req("GET", "/company/auth/bootstrap");
  const bootJson = JSON.parse(boot.text) as { header?: string; token?: string; tokenConfigured?: boolean };
  tokenHeader = bootJson.header ?? tokenHeader;
  token = bootJson.token ?? "";
  console.log(`bootstrap    : HTTP ${boot.status} header=${tokenHeader} tokenConfigured=${bootJson.tokenConfigured} tokenLen=${token.length} (value never printed)`);

  const { config } = await import("../src/config.js");
  const { chooseWorkerModel } = await import("../src/company/dispatch.js");
  const fleet = await import("../src/company/fleet.js");
  const { getProject } = await import("../src/company/org.js");

  const coderDefault = config.models.standard; // the global rule's cheap default
  const overrideModel = config.models.routine; // a real, known id that is NOT the coder default

  head("1. THE TWO MODEL IDS");
  console.log(`global rule default for coder work (config.models.standard) : ${coderDefault}`);
  console.log(`fleet cost-rule default                  (ruleModel)        : ${fleet.ruleModel({ id: "wo", title: "t", role: "coder", owns: [], brief: "", done: [], state: "planned", attempts: 0 }).model}`);
  console.log(`per-project override we will set          (config.models.routine)   : ${overrideModel}`);
  check(
    "the override id is real and differs from the coder default",
    Boolean(overrideModel) && overrideModel !== coderDefault,
    `override=${overrideModel} coderDefault=${coderDefault}`,
  );

  const stamp = Date.now().toString(36);
  const overrideName = `Proof Override ${stamp}`;
  const controlName = `Proof Control ${stamp}`;
  const scopeName = `Proof RoleScope ${stamp}`;

  head("2. API: POST /company/projects  {team:{coders:2, models:{coder:<override>}}}  (raw response)");
  const createBody = {
    projectName: overrideName,
    departmentName: `Proof Dept ${stamp}`,
    description: "PROOF: per-project team config with a coder model override",
    team: { coders: 2, models: { coder: overrideModel } },
  };
  console.log(`request body: ${JSON.stringify(createBody)}`);
  const created = await req("POST", "/company/projects", createBody, true);
  console.log(`HTTP ${created.status}`);
  console.log(pretty(created.text));
  const createdJson = JSON.parse(created.text) as { ok?: boolean; project?: { id: string; team?: unknown } };
  const projectId = createdJson.project?.id ?? "";
  check("POST /company/projects -> 200 {ok:true, project}", created.status === 200 && createdJson.ok === true, `HTTP ${created.status} projectId=${projectId}`);

  head("3. STORED RECORD (raw JSON for this project, read from the dev instance's org.json)");
  const orgFile = path.join(DEV_ROOT, "org.json");
  const orgRaw = fs.readFileSync(orgFile, "utf8");
  const org = JSON.parse(orgRaw) as { projects: Array<{ id: string; team?: { coders?: number; models?: Record<string, string> }; teams?: Array<{ agents: Array<{ id: string; role: string; modelId: string }> }> }> };
  const stored = org.projects.find((p) => p.id === projectId);
  console.log(`file: ${orgFile} (${orgRaw.length} bytes)`);
  console.log(stored ? JSON.stringify(stored, null, 2) : "(project not found in org.json)");
  const storedCoders = stored?.team?.coders;
  const storedModel = stored?.team?.models?.coder;
  const coderAgents = stored?.teams?.[0]?.agents.filter((a) => a.role === "coder").map((a) => a.id) ?? [];
  check("stored record carries team.coders=2", storedCoders === 2, `team.coders=${String(storedCoders)}`);
  check("stored record carries team.models.coder=<override>", storedModel === overrideModel, `team.models.coder=${String(storedModel)}`);
  check("the project's team really has 2 coder agents", coderAgents.length === 2, `coder agents=[${coderAgents.join(", ")}]`);
  check("the dev instance's in-memory project matches the file", getProject(projectId)?.team?.models?.coder === overrideModel, `getProject(${projectId}).team.models.coder=${String(getProject(projectId)?.team?.models?.coder)}`);

  head("4. API: PATCH /company/projects/:id/team {models:{tester:...}}  (merge, raw response)");
  const patched = await req("PATCH", `/company/projects/${projectId}/team`, { models: { tester: config.models.standard } }, true);
  console.log(`HTTP ${patched.status}`);
  console.log(pretty(patched.text));
  const patchedJson = JSON.parse(patched.text) as { ok?: boolean; project?: { team?: { coders?: number; models?: Record<string, string> } } };
  check(
    "PATCH merges the new role and keeps coders/coder",
    patched.status === 200 &&
      patchedJson.project?.team?.coders === 2 &&
      patchedJson.project?.team?.models?.coder === overrideModel &&
      patchedJson.project?.team?.models?.tester === config.models.standard,
    `team=${JSON.stringify(patchedJson.project?.team)}`,
  );

  head("5. API: validation (the spec's 400s, raw responses)");
  const badCoders = await req("POST", "/company/projects", { projectName: `Proof Bad ${stamp}`, team: { coders: 9 } }, true);
  console.log(`POST /company/projects team.coders=9 -> HTTP ${badCoders.status} ${badCoders.text}`);
  check("coders=9 is rejected with 400 {error}", badCoders.status === 400 && Boolean((JSON.parse(badCoders.text) as { error?: string }).error), `HTTP ${badCoders.status} ${badCoders.text}`);
  const badRole = await req("PATCH", `/company/projects/${projectId}/team`, { models: { wizard: overrideModel } }, true);
  console.log(`PATCH .../team models.wizard -> HTTP ${badRole.status} ${badRole.text}`);
  check("unknown role is rejected with 400 {error}", badRole.status === 400 && Boolean((JSON.parse(badRole.text) as { error?: string }).error), `HTTP ${badRole.status} ${badRole.text}`);
  const badModel = await req("PATCH", `/company/projects/${projectId}/team`, { models: { coder: "" } }, true);
  console.log(`PATCH .../team models.coder="" -> HTTP ${badModel.status} ${badModel.text}`);
  check("empty model id is rejected with 400 {error}", badModel.status === 400, `HTTP ${badModel.status} ${badModel.text}`);
  check("the rejected patches did not change the stored team", getProject(projectId)?.team?.models?.coder === overrideModel && getProject(projectId)?.team?.models?.tester === config.models.standard, `team=${JSON.stringify(getProject(projectId)?.team)}`);

  head("6. CONTROL PROJECTS: one with NO team, one whose team sets a DIFFERENT role (raw responses)");
  const controlBody = { projectName: controlName, departmentName: `Proof Dept Control ${stamp}`, description: "PROOF: no team config, global rule must apply" };
  console.log(`request body: ${JSON.stringify(controlBody)}`);
  const controlCreated = await req("POST", "/company/projects", controlBody, true);
  console.log(`HTTP ${controlCreated.status}`);
  console.log(pretty(controlCreated.text));
  const controlId = (JSON.parse(controlCreated.text) as { project?: { id: string } }).project?.id ?? "";
  const reloadOrg = () => JSON.parse(fs.readFileSync(orgFile, "utf8")) as typeof org;
  const controlStored = org.projects.find((p) => p.id === controlId) ?? reloadOrg().projects.find((p) => p.id === controlId);
  console.log(`stored control record team field: ${JSON.stringify(controlStored?.team) ?? "undefined"}`);
  check("the control project has NO team config stored", controlStored?.team === undefined, `team=${JSON.stringify(controlStored?.team)}`);

  const scopeBody = {
    projectName: scopeName,
    departmentName: `Proof Dept Scope ${stamp}`,
    description: "PROOF: team config that sets a role OTHER than coder (the coder key must stay on the global rule)",
    team: { coders: 2, models: { tester: overrideModel } },
  };
  console.log(`\nrequest body: ${JSON.stringify(scopeBody)}`);
  const scopeCreated = await req("POST", "/company/projects", scopeBody, true);
  console.log(`HTTP ${scopeCreated.status}`);
  console.log(pretty(scopeCreated.text));
  const scopeId = (JSON.parse(scopeCreated.text) as { project?: { id: string } }).project?.id ?? "";
  const scopeStored = reloadOrg().projects.find((p) => p.id === scopeId);
  check(
    "the role-scope project stored ONLY the tester model",
    scopeStored?.team?.models?.coder === undefined && scopeStored?.team?.models?.tester === overrideModel,
    `team=${JSON.stringify(scopeStored?.team)}`,
  );

  head("7. DISPATCH via the REAL code path: chooseWorkerModel(text, {projectId, role})");
  const subtask = "Add a short section to README.md documenting the new export (one file, one paragraph).";
  console.log(`subtask (identical for both projects, so the project id is the only variable): ${subtask}`);
  const overridePick = await chooseWorkerModel(subtask, { projectId, role: "coder" });
  console.log(`\n[override project ${projectId}] chooseWorkerModel ->`);
  console.log(JSON.stringify(overridePick, null, 2));
  const controlPick = await chooseWorkerModel(subtask, { projectId: controlId, role: "coder" });
  console.log(`\n[control project ${controlId}] chooseWorkerModel ->`);
  console.log(JSON.stringify(controlPick, null, 2));
  const noOptsPick = await chooseWorkerModel(subtask);
  console.log(`\n[no opts at all - backward compatibility] chooseWorkerModel ->`);
  console.log(JSON.stringify(noOptsPick, null, 2));
  const scopeCoderPick = await chooseWorkerModel(subtask, { projectId: scopeId, role: "coder" });
  console.log(`\n[role-scope project ${scopeId}, role=coder (this project sets only team.models.tester)] chooseWorkerModel ->`);
  console.log(JSON.stringify(scopeCoderPick, null, 2));
  const scopeTesterPick = await chooseWorkerModel(subtask, { projectId: scopeId, role: "tester" });
  console.log(`\n[role-scope project ${scopeId}, role=tester] chooseWorkerModel ->`);
  console.log(JSON.stringify(scopeTesterPick, null, 2));

  check("override project: model is the overridden id", overridePick.modelId === overrideModel, `modelId=${overridePick.modelId} expected=${overrideModel}`);
  check("override project: reason contains 'project override'", overridePick.reason.includes("project override"), `reason=${overridePick.reason}`);
  check("control project: reason does NOT contain 'project override'", !controlPick.reason.includes("project override"), `reason=${controlPick.reason}`);
  check(
    "control project: the global rule answered EXACTLY as it does with no project at all",
    controlPick.modelId === noOptsPick.modelId && controlPick.reason === noOptsPick.reason,
    `control=${JSON.stringify(controlPick)} noProject=${JSON.stringify(noOptsPick)}`,
  );
  check("no-opts caller: reason does NOT contain 'project override'", !noOptsPick.reason.includes("project override"), `reason=${noOptsPick.reason}`);
  check(
    "role-scope project: role=coder still gets the global rule (the coder key is absent)",
    !scopeCoderPick.reason.includes("project override") && scopeCoderPick.modelId === noOptsPick.modelId && scopeCoderPick.reason === noOptsPick.reason,
    `coder pick=${JSON.stringify(scopeCoderPick)}`,
  );
  check(
    "role-scope project: role=tester DOES get the override (per-role precision)",
    scopeTesterPick.modelId === overrideModel && scopeTesterPick.reason.includes("project override"),
    `tester pick=${JSON.stringify(scopeTesterPick)}`,
  );

  head("8. DISPATCH via the FLEET path: pickFleetModel(wo) (the call src/company/fleet.ts makes)");
  // Code work with a single file: the global rule puts this on the cheap DEFAULT, so the
  // control project and the override project cannot be confused with each other.
  const fleetBrief =
    "Change src/company/org.ts so createProject rejects a coder count below 1 or above 6 and returns a clear error.";
  const wo = (projectId: string | undefined, label: string) => ({
    id: `wo-proof-${label}`,
    title: "Validate the coder count in the org store",
    role: "coder",
    projectId,
    owns: ["src/company/org.ts"],
    brief: fleetBrief,
    done: ["an out-of-range coder count is rejected with a clear error"],
    state: "planned" as const,
    attempts: 0,
  });
  console.log(`work order brief: ${fleetBrief}`);
  console.log(`CEO cost rule for this work order (ruleModel, no Laya): ${JSON.stringify(fleet.ruleModel(wo(controlId, "rule")))}`);
  const overrideFleet = await fleet.pickFleetModel(wo(projectId, "override"));
  console.log(`\n[override project ${projectId}] pickFleetModel ->`);
  console.log(JSON.stringify(overrideFleet, null, 2));
  const controlFleet = await fleet.pickFleetModel(wo(controlId, "control"));
  console.log(`\n[control project ${controlId}] pickFleetModel ->`);
  console.log(JSON.stringify(controlFleet, null, 2));
  const noProjectFleet = await fleet.pickFleetModel(wo(undefined, "no-project"));
  console.log(`\n[no project at all - the pre-existing behaviour] pickFleetModel ->`);
  console.log(JSON.stringify(noProjectFleet, null, 2));

  check("fleet: override project picked the overridden model", overrideFleet.model === overrideModel, `model=${overrideFleet.model} expected=${overrideModel}`);
  check("fleet: override project's reason contains 'project override'", overrideFleet.reason.includes("project override"), `reason=${overrideFleet.reason}`);
  check("fleet: control project's reason does NOT contain 'project override'", !controlFleet.reason.includes("project override"), `reason=${controlFleet.reason}`);
  check(
    "fleet: control project behaved EXACTLY like no project at all (global rule intact)",
    controlFleet.model === noProjectFleet.model && controlFleet.reason === noProjectFleet.reason,
    `control=${JSON.stringify(controlFleet)} noProject=${JSON.stringify(noProjectFleet)}`,
  );
  check(
    "fleet: the control project did not take the override PATH (Laya/rule, not the override)",
    !controlFleet.reason.includes("project override") && controlFleet.confidence !== 1,
    `control=${JSON.stringify(controlFleet)} (same model id can legitimately be reached by Laya: the reason and confidence=1 are the discriminator, not the id)`,
  );
  check(
    "fleet: the override path is distinguishable from the global rule on the SAME model id",
    overrideFleet.confidence === 1 && overrideFleet.reason.includes("project override") && !noProjectFleet.reason.includes("project override"),
    `override conf=${overrideFleet.confidence} vs no-project conf=${noProjectFleet.confidence}`,
  );

  head("9. npx tsc --noEmit (the tree this proof ran against)");
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { shell: true, encoding: "utf8", timeout: 600000 });
  console.log(`exit code: ${tsc.status}`);
  if (tsc.stdout) console.log(tsc.stdout.trim());
  if (tsc.stderr) console.log(tsc.stderr.trim());
  check("npx tsc --noEmit exits 0", tsc.status === 0, `exit=${tsc.status}`);

  head("SUMMARY");
  console.log(`checks failed: ${failures}`);
  console.log(`proof artifacts left in the DEV instance only: ${projectId} (${overrideName}), ${controlId} (${controlName}), ${scopeId} (${scopeName})`);
  console.log(failures === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
}

await main();
process.exit(failures === 0 ? 0 : 1);
