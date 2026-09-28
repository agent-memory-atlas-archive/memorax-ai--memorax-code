import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";
import { installNpmTimingObserver } from "./opencode-initialization-diagnostic.mjs";

function fixture() {
  let now = 0;
  const process = new EventEmitter();
  const context = vm.createContext({ process, performance: { now: () => now } });
  assert.equal(vm.runInContext(`(${installNpmTimingObserver.toString()})()`, context), true);
  return { process, context, advance: (milliseconds) => { now += milliseconds; },
    snapshot: () => JSON.parse(JSON.stringify(context.__memoraxNpmInitializationDiagnostic())) };
}

test("npm diagnostic captures real proc-log start/end signatures and active durations", () => {
  const { process, advance, snapshot } = fixture();
  process.emit("time", "start", "reify");
  advance(3);
  process.emit("time", "start", "reify:unpack");
  advance(11);
  assert.deepEqual(snapshot().phases[1], { phase: "reify:unpack", started: 1, completed: 0, active: 1,
    overlapping: false, unmatchedEnds: 0, activeDurationMs: 11, completedDurationMs: 0, lastDurationMs: null });
  process.emit("time", "end", "reify:unpack");
  advance(5);
  process.emit("time", "end", "reify");
  assert.equal(snapshot().phases[0].completedDurationMs, 19);
  assert.equal(snapshot().phases[1].lastDurationMs, 11);
  assert.equal(snapshot().phases.every((phase) => phase.active === 0), true);
});

test("npm diagnostic reports overlapping timers without claiming exact paired durations", () => {
  const { process, advance, snapshot } = fixture();
  process.emit("time", "start", "reify:unpack");
  advance(3);
  process.emit("time", "start", "reify:unpack");
  advance(4);
  process.emit("time", "end", "reify:unpack");
  assert.equal(snapshot().phases[0].active, 1);
  process.emit("time", "end", "reify:unpack");
  process.emit("time", "end", "reify:unpack");
  assert.deepEqual(snapshot().phases[0], { phase: "reify:unpack", started: 2, completed: 2, active: 0,
    overlapping: true, unmatchedEnds: 1, activeDurationMs: null, completedDurationMs: null, lastDurationMs: null });
});

test("npm diagnostic recognizes all 27 public Windows dependency package names", () => {
  const { process, advance, snapshot } = fixture();
  const packages = [
    ["@opencode-ai/plugin", "opencode-plugin"], ["@opencode-ai/sdk", "opencode-sdk"],
    ["@ai-sdk/provider", "ai-sdk-provider"], ["@standard-schema/spec", "standard-schema-spec"],
    ["@msgpackr-extract/msgpackr-extract-win32-x64", "msgpackr-extract-win32-x64"],
    ...["zod", "effect", "ini", "toml", "uuid", "yaml", "msgpackr", "msgpackr-extract", "fast-check",
      "pure-rand", "multipasta", "find-my-way-ts", "kubernetes-types", "json-schema", "cross-spawn",
      "which", "path-key", "shebang-command", "shebang-regex", "isexe", "node-gyp-build-optional-packages",
      "detect-libc"].map((name) => [name, name]),
  ];
  const canary = "PRIVATE_DEPENDENCY_PATH_CANARY";
  for (const [index, [name]] of packages.entries()) {
    const path = index % 2 ? `/tmp/${canary}/node_modules/${name}`
      : `C:\\Users\\${canary}\\node_modules\\${name.replaceAll("/", "\\")}`;
    process.emit("time", "start", `reifyNode:${path}`);
    advance(3);
    process.emit("time", "end", `reifyNode:${path}`);
  }
  const result = snapshot();
  assert.equal(result.phases.length, 27);
  assert.deepEqual(result.phases.map((phase) => phase.phase), packages.map(([, label]) => `package:${label}`));
  assert.equal(result.phases.every((phase) => phase.started === 1 && phase.completed === 1
    && phase.active === 0 && phase.lastDurationMs === 3), true);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("npm diagnostic classifies only public package names and never retains paths or log arguments", () => {
  const { process, snapshot } = fixture();
  const canary = "PRIVATE_NPM_DIAGNOSTIC_CANARY";
  for (const path of [
    `C:\\Users\\${canary}\\node_modules\\@opencode-ai\\plugin`,
    `/tmp/${canary}/node_modules/@opencode-ai/sdk`, "node_modules/zod",
  ]) process.emit("time", "start", `reifyNode:${path}`);
  for (const name of [`reifyNode:/tmp/${canary}/node_modules/private-package`,
    `reifyNode:node_modules/effect-${canary}`, `reifyNode:private-node_modules/effect`,
    `reifyNode:node_modules/@ai-sdk/provider-${canary}`, `idealTree:${canary}`, canary]) {
    process.emit("time", "start", name);
  }
  process.emit("time", "private-action", "reify");
  process.emit("log", "warn", { token: canary, path: `C:\\Users\\${canary}` }, canary);
  process.emit("log", canary, canary);
  process.emit("log", { toString() { throw new Error("Do not coerce log payloads"); } });
  const result = snapshot();
  assert.deepEqual(result.phases.map((phase) => phase.phase), ["package:opencode-plugin", "package:opencode-sdk", "package:zod"]);
  assert.equal(result.logCounts.warn, 1);
  assert.equal(Object.values(result.logCounts).reduce((total, count) => total + count, 0), 1);
  for (const forbidden of [canary, "C:\\Users", "/tmp/", "private-package", "private-action"]) {
    assert.equal(JSON.stringify(result).includes(forbidden), false);
  }
});

test("npm diagnostic reports explicit noop invocation instead of inferring it from session success", () => {
  const { context, snapshot } = fixture();
  assert.equal(snapshot().noopPluginInvoked, false);
  context.__memoraxNoopPluginInvoked = "private truthy value";
  assert.equal(snapshot().noopPluginInvoked, false);
  context.__memoraxNoopPluginInvoked = true;
  assert.equal(snapshot().noopPluginInvoked, true);
});
