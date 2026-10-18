// routingPolicy.ts - the routing policy file. Decides WHICH provider gateway and WHICH model ids the
// office uses for each kind of work, without editing code.
//
// Lookup order for every value (first one wins):
//   1. the environment variable that always existed (GATEWAY_BASE_URL, STANDARD_MODEL, MODEL_ALLOWLIST ...)
//   2. routing.policy.json at the repo root (or the file named by ROUTING_POLICY_FILE)
//   3. the built-in defaults below (an OpenAI-compatible gateway; see routing/*.example.json for other setups)
//
// Shape (every field optional; unknown keys are ignored):
//   {
//     "gateway": { "baseUrl": "https://...", "keyEnv": "NAME_OF_THE_ENV_VAR_HOLDING_THE_KEY" },
//     "tiers":   { "routine": "model-id", "standard": "model-id", "complex": "model-id", "complexAlt": "model-id" },
//     "allowedFamilies": ["prefix", "prefix"],      // model ids must start with one of these (claude* is always allowed)
//     "direct":  { "provider": "id", "model": "model-id", "peakUtcBlocks": [[1,4],[6,10]], "peakWeekdaysOnly": true,
//                  "offPeakMultiplier": 0.5, "boundaryBufferMinutes": 45 }
//   }
//
// Node built-ins only. Never throws: a missing file is normal; a malformed file warns once and the defaults apply.
import fs from "node:fs";
import path from "node:path";

export type PeakBlock = readonly [number, number];

export type RoutingPolicy = {
  gateway: { baseUrl: string; keyEnv: string };
  tiers: { routine: string; standard: string; complex: string; complexAlt: string };
  allowedFamilies: string[];
  direct: {
    provider: string;
    model: string;
    peakUtcBlocks: PeakBlock[];
    peakWeekdaysOnly: boolean;
    offPeakMultiplier: number;
    boundaryBufferMinutes: number;
  };
};

/** Built-in defaults. These are the values the office shipped with; change them in routing.policy.json, not here. */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  gateway: { baseUrl: "https://opencode.ai/zen/go/v1", keyEnv: "OPENCODE_API_KEY" },
  tiers: {
    routine: "glm-5.3-flash",
    standard: "deepseek-v4-flash",
    complex: "kimi-k2.7-code",
    complexAlt: "qwen3.8-flash",
  },
  allowedFamilies: ["deepseek", "glm"],
  direct: {
    provider: "deepseek",
    model: "deepseek-flash",
    peakUtcBlocks: [[1, 4], [6, 10]],
    peakWeekdaysOnly: true,
    offPeakMultiplier: 0.5,
    boundaryBufferMinutes: 45,
  },
};

export const ROUTING_POLICY_FILE = "routing.policy.json";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v.trim() : fallback);

function blocks(v: unknown, fallback: PeakBlock[]): PeakBlock[] {
  if (!Array.isArray(v)) return fallback;
  const out: PeakBlock[] = [];
  for (const b of v) {
    if (!Array.isArray(b) || b.length !== 2) throw new Error("peakUtcBlocks must be [[fromHour,toHour], ...]");
    const [from, to] = b as unknown[];
    if (typeof from !== "number" || typeof to !== "number" || from < 0 || to > 24 || from >= to) {
      throw new Error("peakUtcBlocks entries need 0 <= from < to <= 24");
    }
    out.push([from, to]);
  }
  return out;
}

/** Merge a parsed JSON object over the defaults. Throws a plain Error on a wrong shape. */
export function parseRoutingPolicy(input: unknown): RoutingPolicy {
  if (!isObj(input)) throw new Error("routing policy must be a JSON object");
  const d = DEFAULT_ROUTING_POLICY;
  const gw = isObj(input.gateway) ? input.gateway : {};
  const tiers = isObj(input.tiers) ? input.tiers : {};
  const direct = isObj(input.direct) ? input.direct : {};
  let families = d.allowedFamilies;
  if (input.allowedFamilies !== undefined) {
    if (!Array.isArray(input.allowedFamilies) || input.allowedFamilies.some((f) => typeof f !== "string")) {
      throw new Error("allowedFamilies must be an array of strings");
    }
    families = (input.allowedFamilies as string[]).map((f) => f.trim().toLowerCase()).filter(Boolean);
  }
  return {
    gateway: { baseUrl: str(gw.baseUrl, d.gateway.baseUrl), keyEnv: str(gw.keyEnv, d.gateway.keyEnv) },
    tiers: {
      routine: str(tiers.routine, d.tiers.routine),
      standard: str(tiers.standard, d.tiers.standard),
      complex: str(tiers.complex, d.tiers.complex),
      complexAlt: str(tiers.complexAlt, d.tiers.complexAlt),
    },
    allowedFamilies: families,
    direct: {
      provider: str(direct.provider, d.direct.provider),
      model: str(direct.model, d.direct.model),
      peakUtcBlocks: blocks(direct.peakUtcBlocks, d.direct.peakUtcBlocks),
      peakWeekdaysOnly: typeof direct.peakWeekdaysOnly === "boolean" ? direct.peakWeekdaysOnly : d.direct.peakWeekdaysOnly,
      offPeakMultiplier: typeof direct.offPeakMultiplier === "number" && direct.offPeakMultiplier > 0 ? direct.offPeakMultiplier : d.direct.offPeakMultiplier,
      boundaryBufferMinutes:
        typeof direct.boundaryBufferMinutes === "number" && direct.boundaryBufferMinutes >= 0 ? direct.boundaryBufferMinutes : d.direct.boundaryBufferMinutes,
    },
  };
}

/** Where the policy file is looked up: ROUTING_POLICY_FILE, else routing.policy.json in `dir`. */
export function routingPolicyPath(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.ROUTING_POLICY_FILE ?? "").trim();
  return override ? path.resolve(dir, override) : path.join(dir, ROUTING_POLICY_FILE);
}

/** Load the policy: the file merged over the defaults. A missing file is normal; a bad file warns once. Never throws. */
export function loadRoutingPolicy(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): RoutingPolicy {
  const file = routingPolicyPath(dir, env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return DEFAULT_ROUTING_POLICY;
  }
  try {
    return parseRoutingPolicy(JSON.parse(raw));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[routing-policy] ${path.basename(file)} is malformed (${why.slice(0, 160)}): using the built-in defaults`);
    return DEFAULT_ROUTING_POLICY;
  }
}

/** The policy for this process (read once at start-up; restart to pick up edits). */
export const routingPolicy: RoutingPolicy = loadRoutingPolicy();
