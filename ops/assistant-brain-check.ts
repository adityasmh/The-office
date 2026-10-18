/**
 * ops/assistant-brain-check.ts - isolated verification for ASSISTANT-BRAIN
 * (src/company/assistant.ts, docs/REPORTING_SPEC.md section 3).
 *
 *   node_modules/.bin/tsx ops/assistant-brain-check.ts <scenario> [--keep]
 *   node_modules/.bin/tsx --env-file=.env ops/assistant-brain-check.ts turn
 *
 * Scenarios:
 *   loader    - the soft module loader: real sibling modules load, missing ones degrade
 *   track     - the Laya track choice (pipeline | fleet | answer) on real Laya + guard
 *   fleet     - the fleet track when src/company/fleet.ts does not exist yet
 *   briefing  - RUN REPORT context: empty, briefing.json, runs/*.json, runs.jsonl
 *   history   - conversation history from company/assistant.jsonl
 *   turn      - full assistantMessage turn (needs a gateway key; autoRun off)
 *   fleetturn - a turn whose plan takes the FLEET track (planner forced to a bogus model so no
 *               Claude spend; proves the assistant->fleet.ts wiring and temp-root isolation)
 *
 * SAFETY: this sets COMPANY_ROOT to a throwaway temp directory BEFORE importing the
 * assistant, so nothing it does can touch the live company/ folder. It never starts a
 * server, never touches Slack, and creates no tasks in any real project.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const scenario = argv[0] ?? "loader";
const keep = argv.includes("--keep");

const liveRoot = process.env.COMPANY_ROOT ?? path.join(process.cwd(), "company");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-brain-"));
process.env.COMPANY_ROOT = tempRoot; // must be set before src/company/org.ts is imported
process.env.SLACK_BRIDGE = "0";
// Free model only, and the fallback chain is pointed at the same free model, so this
// probe can never spend money. Set before config.ts is imported below.
process.env.ASSISTANT_MODEL = process.env.PROBE_ASSISTANT_MODEL ?? "space-bunny-free";
process.env.ROUTINE_MODEL = process.env.PROBE_ASSISTANT_MODEL ?? "space-bunny-free";
process.env.STANDARD_MODEL = process.env.PROBE_ASSISTANT_MODEL ?? "space-bunny-free";

console.log(`[probe] scenario=${scenario}`);
console.log(`[probe] live company root (untouched): ${liveRoot}`);
console.log(`[probe] temp company root: ${tempRoot}`);

const A = await import("../src/company/assistant.js");
const { createProject } = await import("../src/company/org.js");

function head(title: string) {
  console.log(`\n=== ${title} ===`);
}

try {
  if (scenario === "loader") {
    head("softImport: a module that exists");
    const dispatch = await A.__testSoftImport("dispatch");
    console.log(`dispatch loaded: ${!!dispatch}`);
    console.log(`dispatch.chooseTeam is a function: ${typeof dispatch?.chooseTeam === "function"}`);

    head("softImport: modules that do not exist yet (graceful degradation)");
    for (const name of ["not-a-real-module", "also-not-a-module"]) {
      const mod = await A.__testSoftImport(name);
      console.log(`${name}: ${mod === undefined ? "undefined (handled)" : "LOADED (unexpected)"}`);
    }
    // briefing.ts / fleet.ts are written by other workers and may or may not exist yet.
    // Report which are on disk; do NOT call into them here (createFleetOrder spends a
    // real Claude planning call, see the fleet scenario).
    for (const name of ["briefing", "fleet"]) {
      const mod = await A.__testSoftImport(name);
      const surface = mod ? Object.keys(mod).filter((k) => typeof mod[k] === "function").slice(0, 12).join(", ") : "";
      console.log(`${name}: ${mod ? `loaded (functions: ${surface})` : "not on disk yet -> undefined (handled)"}`);
    }

    head("briefing context with nothing on disk");
    console.log(await A.__testBriefingContext());
  }

  if (scenario === "track") {
    const samples = [
      ["Add a dark mode toggle to the settings page of the billing app", "expected pipeline"],
      [
        "Add a new Team section to our own platform dashboard and a /company/team API endpoint",
        "expected fleet",
      ],
      ["What is done and what is left on the dashboard work?", "expected answer"],
    ];
    const guard = Number(process.env.LAYA_TRACK_MIN_CONF ?? 0.2);
    for (const [title, note] of samples) {
      const pick = await A.__testChooseTrack(title, title);
      console.log(
        pick
          ? `track=${pick.track} confidence=${pick.confidence.toFixed(4)} accepted_by_guard(${guard})=${
              pick.confidence >= guard
            } reason="${pick.reason}"  [${note}]`
          : `Laya returned nothing (offline/unknown option) -> caller keeps the planned track  [${note}]`
      );
      console.log(`  order: ${title}`);
    }
  }

  if (scenario === "fleet") {
    head("fleet.ts export surface, read through the same loader the assistant uses");
    const fleet = await A.__testSoftImport("fleet");
    if (!fleet) {
      head("fleet.ts is not on disk -> the assistant degrades");
      const missing = await A.__testSoftImport("fleet-not-here");
      console.log(`loader returns ${missing === undefined ? "undefined" : "a module"} for a missing fleet module`);
      console.log("startFleetOrder would return {ok:false, detail:\"src/company/fleet.ts is not on disk yet ...\"},");
      console.log("assistantMessage would keep the task on the pipeline track and say so in the reply.");
    } else {
      const names = ["createFleetOrder", "createFleetOrderFromText", "createOrder"];
      for (const n of names) console.log(`fleet.ts ${n}: ${typeof fleet[n]}`);
      console.log(
        `assistant's primary target "createFleetOrder" present: ${typeof fleet.createFleetOrder === "function"}`
      );
      console.log("NOT called here on purpose: createFleetOrder runs a real Claude planning call.");
      console.log("Evidence that the call shape works is recorded in docs/AGENT_COORDINATION.md: two manual runs");
      console.log("returned order ids fomumofwxu / fomumog7wp with status 'planning', which then became 'failed'");
      console.log("('the planner produced no usable work orders', because the order text was a probe string).");
    }
  }

  if (scenario === "briefing") {
    head("1. empty root");
    console.log(await A.__testBriefingContext());

    head("2. company/reports/briefing.json only");
    fs.mkdirSync(path.join(tempRoot, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "reports", "briefing.json"),
      JSON.stringify(
        {
          generatedAt: "2026-09-29T12:00:00.000Z",
          model: "claude-sonnet-5-5",
          summary: "Three runs are going and one needs a decision about the new logo.",
          needsYou: [{ text: "Approve the new pricing page copy", runId: "tm1" }],
          done: [{ text: "The login bug is fixed and merged", runId: "tm2", at: "2026-09-29T11:40:00Z" }],
          inProgress: [
            {
              text: "The dashboard rebuild",
              runId: "tm3",
              owner: "UI team: Flow page",
              remaining: ["Connect the filter buttons", "Add the empty state"],
            },
          ],
          problems: [{ text: "The nightly backup keeps failing", runId: "tm4" }],
          counts: { running: 2, done: 1, failed: 1, stuck: 0 },
        },
        null,
        2
      )
    );
    console.log(await A.__testBriefingContext());

    head("3. company/reports/runs/<runId>.json (run cards, no briefing.json)");
    fs.rmSync(path.join(tempRoot, "reports", "briefing.json"));
    fs.mkdirSync(path.join(tempRoot, "reports", "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "reports", "runs", "jcode-rose.json"),
      JSON.stringify({
        runId: "jcode-rose",
        kind: "jcode",
        title: "Slack report-back",
        owner: "jcode rose",
        state: "done",
        headline: "Finished the Slack report-back for finished work.",
        done: ["Post the result into the CEO's Slack thread"],
        remaining: [],
        model: "claude-sonnet-5-5",
        modelReason: "Laya offline",
        checkedAt: "2026-09-29T11:55:00.000Z",
      })
    );
    console.log(await A.__testBriefingContext());

    head("4. company/reports/runs.jsonl only (history fallback, last line per runId)");
    fs.rmSync(path.join(tempRoot, "reports", "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "reports", "runs.jsonl"),
      [
        JSON.stringify({ runId: "tj1", kind: "task", title: "first check", state: "working", headline: "old line" }),
        JSON.stringify({
          runId: "tj1",
          kind: "task",
          title: "first check",
          state: "stuck",
          headline: "No activity for 15 minutes.",
          remaining: ["Find out why the coder stopped"],
          checkedAt: "2026-09-29T11:58:00.000Z",
        }),
      ].join("\n") + "\n"
    );
    console.log(await A.__testBriefingContext());
  }

  if (scenario === "history") {
    fs.writeFileSync(
      path.join(tempRoot, "assistant.jsonl"),
      [
        { ts: "2026-09-29T10:00:00.000Z", role: "ceo", text: "Add a dark mode toggle to the billing app." },
        { ts: "2026-09-29T10:00:05.000Z", role: "assistant", text: "Planned 1 task and dispatched it.", tasks: ["tm1"] },
        { ts: "2026-09-29T10:10:00.000Z", role: "ceo", text: "What about the second one?" },
      ]
        .map((rec) => JSON.stringify(rec))
        .join("\n") + "\n"
    );
    head("history, last 12 turns (oldest first)");
    console.log(JSON.stringify(A.__testConversationHistory(12)));
    head("history, last 2 turns");
    console.log(JSON.stringify(A.__testConversationHistory(2)));
    head("history, 0 turns (and a bad value)");
    console.log(JSON.stringify(A.__testConversationHistory(0)));
    console.log(JSON.stringify(A.__testConversationHistory(Number("abc"))));
    head("file the module actually reads");
    const { getCompanyRoot } = await import("../src/company/org.js");
    const expected = path.join(tempRoot, "assistant.jsonl");
    console.log(`getCompanyRoot(): ${getCompanyRoot()}`);
    console.log(`thread file: ${path.join(getCompanyRoot(), "assistant.jsonl")}`);
    console.log(`same path as the probe wrote: ${path.join(getCompanyRoot(), "assistant.jsonl") === expected}`);
    console.log(`exists: ${fs.existsSync(expected)} bytes: ${fs.existsSync(expected) ? fs.statSync(expected).size : -1}`);
    console.log(`assistantThread(12) raw entries: ${A.assistantThread(12).length}`);
  }

  if (scenario === "turn") {
    createProject({
      companyName: "Probe Co",
      departmentName: "Engineering",
      projectName: "Probe Project",
      description: "Temp project for the assistant probe.",
    });

    // No model overrides here: the env set at the top of this file already points the
    // assistant and its whole fallback chain at the free model.
    head("first turn (history empty)");
    const first = await A.assistantMessage("Say hello and tell me which model you are.", { autoRun: false });
    console.log(`reply: ${JSON.stringify(first.reply)}`);
    console.log(`plan: ${JSON.stringify(first.plan)}`);
    console.log(`dispatched: ${JSON.stringify(first.dispatched)}`);
    console.log(`fleet: ${JSON.stringify(first.fleet ?? [])}`);
    console.log(`error: ${first.error ?? "(none)"}`);
    console.log("decisions:");
    for (const d of first.decisions) console.log(`  - ${d}`);

    head("second turn (must carry the first turn's history)");
    const second = await A.assistantMessage("What did I just ask you?", { autoRun: false });
    console.log(`reply: ${JSON.stringify(second.reply)}`);
    console.log("decisions:");
    for (const d of second.decisions) console.log(`  - ${d}`);

    head("assistant.jsonl as written by the two turns");
    console.log(fs.readFileSync(path.join(tempRoot, "assistant.jsonl"), "utf8").trim());

    head("history the second turn was given");
    console.log(A.__testConversationHistory(12));

    head("third turn: a real work order (autoRun off, so no pipeline runs)");
    const third = await A.assistantMessage("Add a small About page to the Probe Project.", { autoRun: false });
    console.log(`reply: ${JSON.stringify(third.reply)}`);
    console.log(`plan: ${JSON.stringify(third.plan)}`);
    console.log(`dispatched: ${JSON.stringify(third.dispatched)}`);
    console.log(`fleet: ${JSON.stringify(third.fleet ?? [])}`);
    console.log("decisions:");
    for (const d of third.decisions) console.log(`  - ${d}`);

    head("trace hops written for the dispatched task (temp root)");
    const projectsDir = path.join(tempRoot, "projects");
    const projectIds = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [];
    let hops = 0;
    for (const pid of projectIds) {
      const tasksFile = path.join(projectsDir, pid, "tasks.json");
      if (!fs.existsSync(tasksFile)) continue;
      const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8")) as Array<{
        id: string;
        status: string;
        trace?: Array<{ from: string; to: string; what: string }>;
      }>;
      for (const t of tasks) {
        console.log(`task ${t.id} (${pid}) status=${t.status}`);
        for (const step of t.trace ?? []) {
          hops++;
          console.log(`  ${step.from} -> ${step.to}: ${step.what}`);
        }
      }
    }
    console.log(`total trace hops: ${hops}`);
  }
  if (scenario === "fleetturn") {
    createProject({
      companyName: "Probe Co",
      departmentName: "Engineering",
      projectName: "Probe Project",
      description: "Temp project for the assistant probe.",
    });
    // A bogus planner model makes the fleet planner fail immediately, so this probe can
    // never spend an Opus call. What we are testing is the ASSISTANT's side: does a
    // fleet-track item reach fleet.ts, get recorded, and skip the company pipeline?
    process.env.FLEET_PLANNER_MODEL = "probe-bogus-model";
    process.env.CLAUDE_CLI_TIMEOUT_SECONDS = "15";

    head("a turn whose order belongs on the fleet track");
    const res = await A.assistantMessage(
      "Route this to the fleet track, not a project pipeline: our own platform dashboard needs a new Team page and a /company/team API endpoint.",
      { autoRun: false }
    );
    console.log(`reply: ${JSON.stringify(res.reply)}`);
    console.log(`plan: ${JSON.stringify(res.plan)}`);
    console.log(`dispatched (company tasks): ${JSON.stringify(res.dispatched)}`);
    console.log(`fleet: ${JSON.stringify(res.fleet ?? [])}`);
    console.log("decisions:");
    for (const d of res.decisions) console.log(`  - ${d}`);

    head("fleet state written under the TEMP root (isolation proof)");
    const ordersFile = path.join(tempRoot, "fleet", "orders.json");
    console.log(`temp orders.json exists: ${fs.existsSync(ordersFile)}`);
    const liveOrders = path.join(liveRoot, "fleet", "orders.json");
    const liveHas = fs.existsSync(liveOrders) ? fs.readFileSync(liveOrders, "utf8") : "";
    for (const f of res.fleet ?? []) {
      if (!f.orderId) continue;
      console.log(`live company/fleet/orders.json contains ${f.orderId}: ${liveHas.includes(f.orderId)}`);
      if (fs.existsSync(ordersFile)) {
        const orders = JSON.parse(fs.readFileSync(ordersFile, "utf8")) as Array<{ id: string; status: string; error?: string }>;
        const mine = orders.find((o) => o.id === f.orderId);
        console.log(`temp order: ${JSON.stringify(mine)}`);
      }
    }
  }

} catch (e) {
  console.log(`\n[probe] EXCEPTION: ${String(e)}`);
  process.exitCode = 1;
} finally {
  if (keep) {
    console.log(`\n[probe] kept temp root: ${tempRoot}`);
  } else {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log(`\n[probe] temp root removed`);
  }
}
