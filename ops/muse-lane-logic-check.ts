/**
 * ops/muse-lane-logic-check.ts - offline proof of the free-model lane policy in src/museLane.ts (no network, no processes).
 *   node_modules\.bin\tsx.cmd ops\muse-lane-logic-check.ts
 */
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_EMPTY_COOLDOWN_MS,
  DEFAULT_FREE_MODELS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_HUNG_COOLDOWN_MS,
  DEFAULT_MIN_GAP_MS,
  FREE_MODEL_PROFILES,
  ModelCooldowns,
  Pacer,
  chainFor,
  classifyFailure,
  freeModels,
  roleForModelId,
  rotateTopTwo,
} from "../src/museLane.js";

let fails = 0;
const say = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) fails++;
};

// classification of the client's error text (taken from the real 2026-10-13 output)
say(classifyFailure('AI_APICallError: Rate limit exceeded. Please try again later.') === "rate-limit", "rate limit text is recognised");
say(classifyFailure('{"message":"Upstream request failed: This Go model trains on request data. Allow paid endpoints that train on request data in your workspace\'s Privacy settings to use it."}') === "privacy-gate", "privacy gate text is recognised");
say(classifyFailure("muse lane timed out after 100s on opencode/x") === "hung", "timeout text is recognised as hung");
say(classifyFailure("opencode/step-5-preview-free returned no text") === "empty", "a model that returns no text is classified as empty");
say(classifyFailure("something else broke") === "other", "unknown text is other");
say(classifyFailure("") === "other", "empty text is other");

// cooldowns with a fake clock
let clock = 1_000_000;
const cd = new ModelCooldowns(() => clock);
const chain = ["a", "b", "c"];
say(cd.available(chain).join() === "a,b,c", "nothing cooling at the start");
cd.mark("a", "rate-limit");
say(cd.available(chain).join() === "b,c", "a rate limited model is skipped, order kept");
say(cd.soonestMs(chain) === DEFAULT_COOLDOWN_MS, "soonest wake-up equals the cooldown");
clock += DEFAULT_COOLDOWN_MS - 1;
say(cd.isCooling("a"), "still cooling one millisecond before the end");
clock += 2;
say(!cd.isCooling("a") && cd.available(chain).join() === "a,b,c", "usable again after the cooldown");
cd.mark("b", "hung");
say(cd.soonestMs(chain) === DEFAULT_HUNG_COOLDOWN_MS, "a hung model rests for the shorter time");
cd.clear();
cd.mark("b", "empty");
say(cd.soonestMs(chain) === DEFAULT_EMPTY_COOLDOWN_MS && DEFAULT_EMPTY_COOLDOWN_MS < DEFAULT_HUNG_COOLDOWN_MS, "an empty answer rests for a shorter time than a hang");
cd.clear();
cd.mark("a", "rate-limit");
cd.mark("b", "rate-limit");
cd.mark("c", "rate-limit");
say(cd.available(chain).length === 0 && cd.soonestMs(chain) > 0 && DEFAULT_MAX_WAIT_MS > 0 && DEFAULT_MAX_WAIT_MS < DEFAULT_COOLDOWN_MS, "with every model resting, the wait is bounded below the cooldown");
cd.clear();
cd.mark("c", "other");
say(!cd.isCooling("c"), "an unknown failure does not start a cooldown");
cd.clear();
say(cd.available(chain).length === 3, "clear() resets everything");

// pacing
let t = 5000;
const pacer = new Pacer(DEFAULT_MIN_GAP_MS, () => t);
const w1 = pacer.reserve();
const w2 = pacer.reserve();
const w3 = pacer.reserve();
say(w1 === 0, "first launch does not wait");
say(w2 === DEFAULT_MIN_GAP_MS && w3 === 2 * DEFAULT_MIN_GAP_MS, "back-to-back launches are spaced by the gap");
t += 10 * DEFAULT_MIN_GAP_MS;
say(pacer.reserve() === 0, "after a quiet period the next launch does not wait");

// model chain
say(freeModels({}).join() === DEFAULT_FREE_MODELS.join(), "default chain is used without the env var");
say(DEFAULT_FREE_MODELS[0] === "opencode/muse-spark-1.3-contributor-free" && DEFAULT_FREE_MODELS.length >= 4, "Muse first, at least three fallbacks");
say(freeModels({ JCODE_MUSE_MODELS: " x/one , x/two ,," }).join() === "x/one,x/two", "env chain is parsed and trimmed");
say(freeModels({ JCODE_MUSE_MODELS: " , " }).join() === DEFAULT_FREE_MODELS.join(), "an empty env chain falls back to the default");
say(new Set(DEFAULT_FREE_MODELS).size === DEFAULT_FREE_MODELS.length, "no duplicate models in the default chain");

// role profiles and load rotation
say(roleForModelId("glm-5.3-flash") === "routine" && roleForModelId("GLM-5.3-FLASH") === "routine", "glm ids (enhancer, summarizer) use the routine chain");
say(roleForModelId("deepseek-v4-flash") === "standard" && roleForModelId("deepseek-flash") === "standard", "deepseek ids (planner, tester, coder) use the standard chain");
say(roleForModelId("claude-sonnet-5-5") === "default" && roleForModelId("space-bunny-free") === "default" && roleForModelId("") === "default", "anything else uses the default chain");
say(FREE_MODEL_PROFILES.routine[0].includes("longcat") && FREE_MODEL_PROFILES.standard[0].includes("muse") && FREE_MODEL_PROFILES.default[0].includes("muse"), "each profile starts with its best measured model");
for (const role of ["routine", "standard", "default"] as const) {
  const list = FREE_MODEL_PROFILES[role];
  say(new Set(list).size === list.length && list.length >= 5, `the ${role} chain has no duplicates and at least five models`);
  say(new Set(list).size === new Set(FREE_MODEL_PROFILES.default).size && list.every((m) => FREE_MODEL_PROFILES.default.includes(m)), `the ${role} chain uses the same set of models as the default chain`);
}
const rot0 = rotateTopTwo(["a", "b", "c"], 0);
const rot1 = rotateTopTwo(["a", "b", "c"], 1);
say(rot0.join() === "a,b,c" && rot1.join() === "b,a,c", "rotation alternates the top two and keeps the rest in order");
say(rotateTopTwo(["a"], 1).join() === "a" && rotateTopTwo([], 1).length === 0, "rotation is safe on short lists");
const inputs = ["x", "y", "z"];
rotateTopTwo(inputs, 1);
say(inputs.join() === "x,y,z", "rotation does not change its input");
say(chainFor("routine", 0, {}).join() === FREE_MODEL_PROFILES.routine.join() && chainFor("routine", 1, {})[0] === FREE_MODEL_PROFILES.routine[1], "chainFor applies the profile and the rotation");
say(chainFor("routine", 1, { JCODE_MUSE_MODELS: "q/one,q/two" }).join() === "q/one,q/two", "an explicit env list overrides every profile and is not rotated");

// the cooling snapshot the coders read
let snapClock = 10_000;
const snapCd = new ModelCooldowns(() => snapClock);
snapCd.mark("m1", "rate-limit");
snapCd.mark("m2", "hung");
const snap = snapCd.snapshot();
say(snap["m1"] === 10_000 + DEFAULT_COOLDOWN_MS && snap["m2"] === 10_000 + DEFAULT_HUNG_COOLDOWN_MS && Object.keys(snap).length === 2, "snapshot lists each resting model with its wake-up time");
snapClock += DEFAULT_HUNG_COOLDOWN_MS + 1;
say(Object.keys(snapCd.snapshot()).join() === "m1", "snapshot drops a model once it has rested long enough");

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
