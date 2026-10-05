# Per-project team config (coders + model override) - proof on the isolated dev instance

Date: 2026-10-01 (local). Order: FLEET-ORDER `fomupdiaz6/PROOF`.

Target: **the isolated dev instance only** - `scripts/dev-router.ps1 -Name company-expand`,
`http://127.0.0.1:8801`, pid 8652, its own data root `dev\company-expand\company`.
The live router on `:8787` (pid 9444, started 15:34:38, before this work) and the live `company\`
folder were never contacted or written. Checked while writing this: live `company\org.json` is
unchanged (mtime 2026-09-30 19:02:09, 11,830 bytes, 5 projects: LiveFinal, Executive Office,
Platform Core, QA & Verification, Applied Research - none of them the proof projects below), and
`:8787` is still the same pid 9444.

Reproduce (dev instance up, nothing else needed):

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-router.ps1 -Name company-expand
npx tsx ops/company-expand-proof.ts
```

What the run shows:

1. the API creates a project whose stored record is `team: {coders:2, models:{coder:"glm-5.3-flash"}}`
   with exactly two coder agents, and the dev instance reads that same record back;
2. `PATCH /company/projects/:id/team` merges a second role, and the spec's validation really fires
   (`coders:9`, an unknown role, an empty model id -> `400 {error}`, and the rejected payloads change
   nothing);
3. the real dispatch path `chooseWorkerModel(text, {projectId, role})` - the same call
   `src/company/fleet.ts pickFleetModel` and `src/company/pipeline.ts` make - returns the **overridden**
   model with a `reason` containing `project override` and `confidence: 1`;
4. a project with **no** `team` at all, and a project whose `team` sets only a **different** role
   (`tester`), answer **bit-identically to calling with no project at all** - the global CEO cost rule
   is intact, and the override is per role, not per project-wide blanket;
5. the fleet's own `pickFleetModel(wo)` shows the same on its call path (`source: "laya"`, reason
   `... conf=1.00 >= 0.33 - project override: ...`), while the control project's pick is identical to
   the no-project pick.

Raw output of the final run (verbatim, 551 lines):

```

=== 0. TARGET (isolated dev instance) ===
dev base url : http://127.0.0.1:8801
company root : C:\Users\user\Desktop\Default Project\dev\company-expand\company
PASS  dev instance answers /health
        HTTP 200 - is the dev router up? (scripts\dev-router.ps1 -Name company-expand)
bootstrap    : HTTP 200 header=x-company-token tokenConfigured=true tokenLen=64 (value never printed)

=== 1. THE TWO MODEL IDS ===
global rule default for coder work (config.models.standard) : deepseek-v4-flash
fleet cost-rule default                  (ruleModel)        : deepseek-v4.1-flash
per-project override we will set          (config.models.routine)   : glm-5.3-flash
PASS  the override id is real and differs from the coder default
        override=glm-5.3-flash coderDefault=deepseek-v4-flash

=== 2. API: POST /company/projects  {team:{coders:2, models:{coder:<override>}}}  (raw response) ===
request body: {"projectName":"Proof Override mupe4jqa","departmentName":"Proof Dept mupe4jqa","description":"PROOF: per-project team config with a coder model override","team":{"coders":2,"models":{"coder":"glm-5.3-flash"}}}
HTTP 200
{
  "ok": true,
  "project": {
    "id": "pmupe4jqf",
    "name": "Proof Override mupe4jqa",
    "description": "PROOF: per-project team config with a coder model override",
    "departmentId": "dmupe4jqf",
    "rootDir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo",
    "teams": [
      {
        "id": "tmupe4jqf",
        "name": "Default Team",
        "projectId": "pmupe4jqf",
        "agents": [
          {
            "id": "manager",
            "role": "manager",
            "name": "Manager",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "enhancer",
            "role": "prompt-enhancer",
            "name": "Prompt Enhancer",
            "modelId": "glm-5.3-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "summarizer",
            "role": "summarizer",
            "name": "Summarizer",
            "modelId": "qwen3.8-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "opposer",
            "role": "opposer",
            "name": "Opposer",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "tester",
            "role": "tester",
            "name": "Tester",
            "modelId": "deepseek-v4-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "coder-1",
            "role": "coder",
            "name": "Coder 1",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo\\agents\\coder-1"
          },
          {
            "id": "coder-2",
            "role": "coder",
            "name": "Coder 2",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo\\agents\\coder-2"
          }
        ]
      }
    ],
    "status": "active",
    "team": {
      "coders": 2,
      "models": {
        "coder": "glm-5.3-flash"
      }
    }
  },
  "department": {
    "id": "dmupe4jqf",
    "name": "Proof Dept mupe4jqa",
    "projectIds": [
      "pmupe4jqf"
    ]
  }
}
PASS  POST /company/projects -> 200 {ok:true, project}
        HTTP 200 projectId=pmupe4jqf

=== 3. STORED RECORD (raw JSON for this project, read from the dev instance's org.json) ===
file: C:\Users\user\Desktop\Default Project\dev\company-expand\company\org.json (28038 bytes)
{
  "id": "pmupe4jqf",
  "name": "Proof Override mupe4jqa",
  "description": "PROOF: per-project team config with a coder model override",
  "departmentId": "dmupe4jqf",
  "rootDir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo",
  "teams": [
    {
      "id": "tmupe4jqf",
      "name": "Default Team",
      "projectId": "pmupe4jqf",
      "agents": [
        {
          "id": "manager",
          "role": "manager",
          "name": "Manager",
          "modelId": "claude-sonnet-5-5",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
        },
        {
          "id": "enhancer",
          "role": "prompt-enhancer",
          "name": "Prompt Enhancer",
          "modelId": "glm-5.3-flash",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
        },
        {
          "id": "summarizer",
          "role": "summarizer",
          "name": "Summarizer",
          "modelId": "qwen3.8-flash",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
        },
        {
          "id": "opposer",
          "role": "opposer",
          "name": "Opposer",
          "modelId": "claude-sonnet-5-5",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
        },
        {
          "id": "tester",
          "role": "tester",
          "name": "Tester",
          "modelId": "deepseek-v4-flash",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
        },
        {
          "id": "coder-1",
          "role": "coder",
          "name": "Coder 1",
          "modelId": "kimi-k2.7-code",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo\\agents\\coder-1"
        },
        {
          "id": "coder-2",
          "role": "coder",
          "name": "Coder 2",
          "modelId": "kimi-k2.7-code",
          "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo\\agents\\coder-2"
        }
      ]
    }
  ],
  "status": "active",
  "team": {
    "coders": 2,
    "models": {
      "coder": "glm-5.3-flash"
    }
  }
}
PASS  stored record carries team.coders=2
        team.coders=2
PASS  stored record carries team.models.coder=<override>
        team.models.coder=glm-5.3-flash
PASS  the project's team really has 2 coder agents
        coder agents=[coder-1, coder-2]
PASS  the dev instance's in-memory project matches the file
        getProject(pmupe4jqf).team.models.coder=glm-5.3-flash

=== 4. API: PATCH /company/projects/:id/team {models:{tester:...}}  (merge, raw response) ===
HTTP 200
{
  "ok": true,
  "project": {
    "id": "pmupe4jqf",
    "name": "Proof Override mupe4jqa",
    "description": "PROOF: per-project team config with a coder model override",
    "departmentId": "dmupe4jqf",
    "rootDir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo",
    "teams": [
      {
        "id": "tmupe4jqf",
        "name": "Default Team",
        "projectId": "pmupe4jqf",
        "agents": [
          {
            "id": "manager",
            "role": "manager",
            "name": "Manager",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "enhancer",
            "role": "prompt-enhancer",
            "name": "Prompt Enhancer",
            "modelId": "glm-5.3-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "summarizer",
            "role": "summarizer",
            "name": "Summarizer",
            "modelId": "qwen3.8-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "opposer",
            "role": "opposer",
            "name": "Opposer",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "tester",
            "role": "tester",
            "name": "Tester",
            "modelId": "deepseek-v4-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo"
          },
          {
            "id": "coder-1",
            "role": "coder",
            "name": "Coder 1",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo\\agents\\coder-1"
          },
          {
            "id": "coder-2",
            "role": "coder",
            "name": "Coder 2",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jqf\\repo\\agents\\coder-2"
          }
        ]
      }
    ],
    "status": "active",
    "team": {
      "coders": 2,
      "models": {
        "coder": "glm-5.3-flash",
        "tester": "deepseek-v4-flash"
      }
    }
  }
}
PASS  PATCH merges the new role and keeps coders/coder
        team={"coders":2,"models":{"coder":"glm-5.3-flash","tester":"deepseek-v4-flash"}}

=== 5. API: validation (the spec's 400s, raw responses) ===
POST /company/projects team.coders=9 -> HTTP 400 {"error":"team.coders must be an integer 1..6"}
PASS  coders=9 is rejected with 400 {error}
        HTTP 400 {"error":"team.coders must be an integer 1..6"}
PATCH .../team models.wizard -> HTTP 400 {"error":"unknown team role: wizard (expected one of manager, coder, tester, opposer)"}
PASS  unknown role is rejected with 400 {error}
        HTTP 400 {"error":"unknown team role: wizard (expected one of manager, coder, tester, opposer)"}
PATCH .../team models.coder="" -> HTTP 400 {"error":"team.models.coder must be a non-empty model id"}
PASS  empty model id is rejected with 400 {error}
        HTTP 400 {"error":"team.models.coder must be a non-empty model id"}
PASS  the rejected patches did not change the stored team
        team={"coders":2,"models":{"coder":"glm-5.3-flash","tester":"deepseek-v4-flash"}}

=== 6. CONTROL PROJECTS: one with NO team, one whose team sets a DIFFERENT role (raw responses) ===
request body: {"projectName":"Proof Control mupe4jqa","departmentName":"Proof Dept Control mupe4jqa","description":"PROOF: no team config, global rule must apply"}
HTTP 200
{
  "ok": true,
  "project": {
    "id": "pmupe4jrj",
    "name": "Proof Control mupe4jqa",
    "description": "PROOF: no team config, global rule must apply",
    "departmentId": "dmupe4jrj",
    "rootDir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo",
    "teams": [
      {
        "id": "tmupe4jrj",
        "name": "Default Team",
        "projectId": "pmupe4jrj",
        "agents": [
          {
            "id": "manager",
            "role": "manager",
            "name": "Manager",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo"
          },
          {
            "id": "enhancer",
            "role": "prompt-enhancer",
            "name": "Prompt Enhancer",
            "modelId": "glm-5.3-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo"
          },
          {
            "id": "summarizer",
            "role": "summarizer",
            "name": "Summarizer",
            "modelId": "qwen3.8-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo"
          },
          {
            "id": "opposer",
            "role": "opposer",
            "name": "Opposer",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo"
          },
          {
            "id": "tester",
            "role": "tester",
            "name": "Tester",
            "modelId": "deepseek-v4-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo"
          },
          {
            "id": "coder-1",
            "role": "coder",
            "name": "Coder 1",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo\\agents\\coder-1"
          },
          {
            "id": "coder-2",
            "role": "coder",
            "name": "Coder 2",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrj\\repo\\agents\\coder-2"
          }
        ]
      }
    ],
    "status": "active"
  },
  "department": {
    "id": "dmupe4jrj",
    "name": "Proof Dept Control mupe4jqa",
    "projectIds": [
      "pmupe4jrj"
    ]
  }
}
stored control record team field: undefined
PASS  the control project has NO team config stored
        team=undefined

request body: {"projectName":"Proof RoleScope mupe4jqa","departmentName":"Proof Dept Scope mupe4jqa","description":"PROOF: team config that sets a role OTHER than coder (the coder key must stay on the global rule)","team":{"coders":2,"models":{"tester":"glm-5.3-flash"}}}
HTTP 200
{
  "ok": true,
  "project": {
    "id": "pmupe4jrw",
    "name": "Proof RoleScope mupe4jqa",
    "description": "PROOF: team config that sets a role OTHER than coder (the coder key must stay on the global rule)",
    "departmentId": "dmupe4jrw",
    "rootDir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo",
    "teams": [
      {
        "id": "tmupe4jrx",
        "name": "Default Team",
        "projectId": "pmupe4jrw",
        "agents": [
          {
            "id": "manager",
            "role": "manager",
            "name": "Manager",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo"
          },
          {
            "id": "enhancer",
            "role": "prompt-enhancer",
            "name": "Prompt Enhancer",
            "modelId": "glm-5.3-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo"
          },
          {
            "id": "summarizer",
            "role": "summarizer",
            "name": "Summarizer",
            "modelId": "qwen3.8-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo"
          },
          {
            "id": "opposer",
            "role": "opposer",
            "name": "Opposer",
            "modelId": "claude-sonnet-5-5",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo"
          },
          {
            "id": "tester",
            "role": "tester",
            "name": "Tester",
            "modelId": "deepseek-v4-flash",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo"
          },
          {
            "id": "coder-1",
            "role": "coder",
            "name": "Coder 1",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo\\agents\\coder-1"
          },
          {
            "id": "coder-2",
            "role": "coder",
            "name": "Coder 2",
            "modelId": "kimi-k2.7-code",
            "workdir": "C:\\Users\\user\\Desktop\\Default Project\\dev\\company-expand\\company\\projects\\pmupe4jrw\\repo\\agents\\coder-2"
          }
        ]
      }
    ],
    "status": "active",
    "team": {
      "coders": 2,
      "models": {
        "tester": "glm-5.3-flash"
      }
    }
  },
  "department": {
    "id": "dmupe4jrw",
    "name": "Proof Dept Scope mupe4jqa",
    "projectIds": [
      "pmupe4jrw"
    ]
  }
}
PASS  the role-scope project stored ONLY the tester model
        team={"coders":2,"models":{"tester":"glm-5.3-flash"}}

=== 7. DISPATCH via the REAL code path: chooseWorkerModel(text, {projectId, role}) ===
subtask (identical for both projects, so the project id is the only variable): Add a short section to README.md documenting the new export (one file, one paragraph).

[override project pmupe4jqf] chooseWorkerModel ->
{
  "modelId": "glm-5.3-flash",
  "confidence": 1,
  "reason": "project override: pmupe4jqf team.models.coder=glm-5.3-flash beats the global rule"
}

[control project pmupe4jrj] chooseWorkerModel ->
{
  "modelId": "deepseek-v4-flash",
  "confidence": 0.2532,
  "reason": "Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green"
}

[no opts at all - backward compatibility] chooseWorkerModel ->
{
  "modelId": "deepseek-v4-flash",
  "confidence": 0.2532,
  "reason": "Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green"
}

[role-scope project pmupe4jrw, role=coder (this project sets only team.models.tester)] chooseWorkerModel ->
{
  "modelId": "deepseek-v4-flash",
  "confidence": 0.2532,
  "reason": "Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green"
}

[role-scope project pmupe4jrw, role=tester] chooseWorkerModel ->
{
  "modelId": "glm-5.3-flash",
  "confidence": 1,
  "reason": "project override: pmupe4jrw team.models.tester=glm-5.3-flash beats the global rule"
}
PASS  override project: model is the overridden id
        modelId=glm-5.3-flash expected=glm-5.3-flash
PASS  override project: reason contains 'project override'
        reason=project override: pmupe4jqf team.models.coder=glm-5.3-flash beats the global rule
PASS  control project: reason does NOT contain 'project override'
        reason=Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green
PASS  control project: the global rule answered EXACTLY as it does with no project at all
        control={"modelId":"deepseek-v4-flash","confidence":0.2532,"reason":"Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green"} noProject={"modelId":"deepseek-v4-flash","confidence":0.2532,"reason":"Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green"}
PASS  no-opts caller: reason does NOT contain 'project override'
        reason=Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green
PASS  role-scope project: role=coder still gets the global rule (the coder key is absent)
        coder pick={"modelId":"deepseek-v4-flash","confidence":0.2532,"reason":"Laya best_worker=deepseek-v4-flash noul escalate=0.18 trivial=0.25 (>= 0.35 / 0.37) | budget go=amber claude=green"}
PASS  role-scope project: role=tester DOES get the override (per-role precision)
        tester pick={"modelId":"glm-5.3-flash","confidence":1,"reason":"project override: pmupe4jrw team.models.tester=glm-5.3-flash beats the global rule"}

=== 8. DISPATCH via the FLEET path: pickFleetModel(wo) (the call src/company/fleet.ts makes) ===
work order brief: Change src/company/org.ts so createProject rejects a coder count below 1 or above 6 and returns a clear error.
CEO cost rule for this work order (ruleModel, no Laya): {"model":"deepseek-v4.1-flash","reason":"rule: default for code work -> deepseek-v4.1-flash"}

[override project pmupe4jqf] pickFleetModel ->
{
  "model": "glm-5.3-flash",
  "source": "laya",
  "confidence": 1,
  "reason": "Laya glm-5.3-flash conf=1.00 >= 0.33 - project override: pmupe4jqf team.models.coder=glm-5.3-flash beats the global rule"
}

[control project pmupe4jrj] pickFleetModel ->
{
  "model": "glm-5.3-flash",
  "source": "laya",
  "confidence": 0.5148,
  "reason": "Laya glm-5.3-flash conf=0.51 >= 0.33 - Laya best_worker=glm-5.3-flash noul escalate=0.29 trivial=0.51 (>= 0.35 / 0.37) | budget go=amber claude=green"
}

[no project at all - the pre-existing behaviour] pickFleetModel ->
{
  "model": "glm-5.3-flash",
  "source": "laya",
  "confidence": 0.5148,
  "reason": "Laya glm-5.3-flash conf=0.51 >= 0.33 - Laya best_worker=glm-5.3-flash noul escalate=0.29 trivial=0.51 (>= 0.35 / 0.37) | budget go=amber claude=green"
}
PASS  fleet: override project picked the overridden model
        model=glm-5.3-flash expected=glm-5.3-flash
PASS  fleet: override project's reason contains 'project override'
        reason=Laya glm-5.3-flash conf=1.00 >= 0.33 - project override: pmupe4jqf team.models.coder=glm-5.3-flash beats the global rule
PASS  fleet: control project's reason does NOT contain 'project override'
        reason=Laya glm-5.3-flash conf=0.51 >= 0.33 - Laya best_worker=glm-5.3-flash noul escalate=0.29 trivial=0.51 (>= 0.35 / 0.37) | budget go=amber claude=green
PASS  fleet: control project behaved EXACTLY like no project at all (global rule intact)
        control={"model":"glm-5.3-flash","source":"laya","confidence":0.5148,"reason":"Laya glm-5.3-flash conf=0.51 >= 0.33 - Laya best_worker=glm-5.3-flash noul escalate=0.29 trivial=0.51 (>= 0.35 / 0.37) | budget go=amber claude=green"} noProject={"model":"glm-5.3-flash","source":"laya","confidence":0.5148,"reason":"Laya glm-5.3-flash conf=0.51 >= 0.33 - Laya best_worker=glm-5.3-flash noul escalate=0.29 trivial=0.51 (>= 0.35 / 0.37) | budget go=amber claude=green"}
PASS  fleet: the control project did not take the override PATH (Laya/rule, not the override)
        control={"model":"glm-5.3-flash","source":"laya","confidence":0.5148,"reason":"Laya glm-5.3-flash conf=0.51 >= 0.33 - Laya best_worker=glm-5.3-flash noul escalate=0.29 trivial=0.51 (>= 0.35 / 0.37) | budget go=amber claude=green"} (same model id can legitimately be reached by Laya: the reason and confidence=1 are the discriminator, not the id)
PASS  fleet: the override path is distinguishable from the global rule on the SAME model id
        override conf=1 vs no-project conf=0.5148

=== 9. npx tsc --noEmit (the tree this proof ran against) ===
exit code: 0
PASS  npx tsc --noEmit exits 0
        exit=0

=== SUMMARY ===
checks failed: 0
proof artifacts left in the DEV instance only: pmupe4jqf (Proof Override mupe4jqa), pmupe4jrj (Proof Control mupe4jqa), pmupe4jrw (Proof RoleScope mupe4jqa)
ALL CHECKS PASSED
```

## `npx tsc --noEmit`

- inside the run above (step 9, spawned by the proof itself): `exit code: 0`
- re-run standalone in the repo root right after the proof: `TSC_EXIT=0` (no output)

## Notes and honest limits

- The proof runs the WORKING TREE through the dev instance, so it proves the change on dev. The live
  router on `:8787` was not restarted and does not serve this code yet.
- `ops/*.ts` are outside `tsconfig.json` (`"include": ["src"]`), so `npx tsc --noEmit` covers `src`;
  the proof script itself is run by tsx.
- Model ids: the global rule's coder default is `config.models.standard` = `deepseek-v4-flash` (the
  fleet cost rule default is `deepseek-v4.1-flash`); the override used is `config.models.routine` =
  `glm-5.3-flash`, a real id from the same catalog and different from the coder default.
- The same model id can legitimately be reached by Laya on the global path, so the discriminator the
  proof asserts is the `reason` string (and `confidence: 1`), not the model id alone.
- The proof projects stay in the DEV instance only: they are listed in the `SUMMARY` block of the raw
  output above (`dev\company-expand\company\org.json`).
