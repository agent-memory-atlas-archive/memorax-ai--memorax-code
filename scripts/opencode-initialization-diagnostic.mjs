import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { check, createNativeHarness, describeSafeError } from "./opencode-native-support.mjs";

// This function is evaluated inside the unmodified native client's inspector.
export function installNpmTimingObserver() {
  const allowed = new Set([
    "reify", "reify:loadTrees", "reify:diffTrees", "reify:retireShallow", "reify:createSparse",
    "reify:loadShrinkwraps", "reify:loadBundles", "reify:audit", "reify:unpack", "reify:unretire",
    "reify:build", "reify:trash", "reify:save", "reify:rollback:retireShallow", "reify:rollback:createSparse",
    "idealTree", "idealTree:init", "idealTree:userRequests", "idealTree:inflate", "idealTree:buildDeps",
    "idealTree:fixDepFlags", "build", "build:deps", "build:links", "build:queue", "build:link",
  ]);
  const packages = new Map([
    ["node_modules/@opencode-ai/plugin", "package:opencode-plugin"],
    ["node_modules/@opencode-ai/sdk", "package:opencode-sdk"],
    ["node_modules/zod", "package:zod"],
  ]);
  const phases = new Map();
  const logCounts = Object.fromEntries(["error", "notice", "warn", "info", "verbose", "http", "silly", "timing"]
    .map((level) => [level, 0]));
  process.on("time", (action, name) => {
    let phase = allowed.has(name) ? name : undefined;
    if (!phase && typeof name === "string" && name.startsWith("reifyNode:")) {
      const location = name.slice("reifyNode:".length).replaceAll("\\", "/");
      for (const [suffix, label] of packages) if (location === suffix || location.endsWith(`/${suffix}`)) phase = label;
    }
    if (!phase || (action !== "start" && action !== "end")) return;
    const state = phases.get(phase) ?? { started: 0, completed: 0, active: 0, overlapping: false,
      startedAt: 0, completedDurationMs: 0, lastDurationMs: null, unmatchedEnds: 0 };
    phases.set(phase, state);
    const now = performance.now();
    if (action === "start") {
      if (state.active) state.overlapping = true; else state.startedAt = now;
      state.started++; state.active++;
    } else if (state.active) {
      state.completed++; state.active--;
      if (!state.active) {
        state.lastDurationMs = Math.max(0, Math.round(now - state.startedAt));
        state.completedDurationMs += state.lastDurationMs;
      }
    } else state.unmatchedEnds++;
  });
  process.on("log", (level) => {
    if (typeof level === "string" && Object.hasOwn(logCounts, level)) logCounts[level]++;
  });
  globalThis.__memoraxNpmInitializationDiagnostic = () => ({
    phases: [...phases].map(([phase, state]) => ({ phase, started: state.started, completed: state.completed,
      active: state.active, overlapping: state.overlapping, unmatchedEnds: state.unmatchedEnds,
      activeDurationMs: state.active ? Math.max(0, Math.round(performance.now() - state.startedAt)) : null,
      completedDurationMs: state.overlapping ? null : state.completedDurationMs,
      lastDurationMs: state.overlapping ? null : state.lastDurationMs })),
    logCounts: { ...logCounts }, noopPluginInvoked: globalThis.__memoraxNoopPluginInvoked === true,
  });
  return true;
}

export async function connectDiagnosticInspector(url) {
  check(typeof WebSocket === "function", "INIT_DIAG_NATIVE_WEBSOCKET_UNAVAILABLE");
  const parsed = new URL(url);
  check(parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1", "INIT_DIAG_INSPECTOR_NOT_LOOPBACK");
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  const failPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CLOSED"), { nativeCode: "INIT_DIAG_INSPECTOR_CLOSED" }));
    }
    pending.clear();
  };
  socket.addEventListener("close", failPending);
  socket.addEventListener("error", failPending);
  socket.addEventListener("message", (event) => {
    let packet;
    try { packet = JSON.parse(String(event.data)); } catch { return; }
    const entry = pending.get(packet.id);
    if (!entry) return;
    pending.delete(packet.id); clearTimeout(entry.timer);
    if (packet.error || packet.result?.wasThrown) {
      entry.reject(Object.assign(new Error("INIT_DIAG_EVALUATION_FAILED"), { nativeCode: "INIT_DIAG_EVALUATION_FAILED" }));
    } else entry.resolve(packet.result?.result?.value);
  });
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CONNECT_TIMEOUT"),
        { nativeCode: "INIT_DIAG_INSPECTOR_CONNECT_TIMEOUT" })), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer);
        reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CONNECT_FAILED"), { nativeCode: "INIT_DIAG_INSPECTOR_CONNECT_FAILED" }));
      }, { once: true });
    });
  } catch (error) { socket.close(); throw error; }
  return {
    evaluate(expression) {
      return new Promise((done, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_REQUEST_TIMEOUT"), { nativeCode: "INIT_DIAG_INSPECTOR_REQUEST_TIMEOUT" }));
        }, 5000);
        pending.set(id, { resolve: done, reject, timer });
        try { socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((done, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CLOSE_TIMEOUT"),
          { nativeCode: "INIT_DIAG_INSPECTOR_CLOSE_TIMEOUT" })), 5000);
        socket.addEventListener("close", () => { clearTimeout(timer); done(); }, { once: true });
        socket.close();
      });
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function runTrial(packageRoot, openCodeCommand, kind, ordinal) {
  const result = { kind, ordinal, status: "FAIL", stage: "harness creation", sessionCreated: false };
  let harness, server, inspector;
  try {
    harness = await createNativeHarness({ packageRoot, openCodeCommand, label: `init-diag-${kind}-${ordinal}`, writeback: false });
    result.stage = "plugin setup";
    if (kind === "actual") {
      await harness.setup();
      result.openCodeVersion = harness.openCodeVersion;
    } else {
      const version = (await harness.runCommand(openCodeCommand, ["--version"])).stdout.trim();
      check(/^\d+\.\d+\.\d+$/.test(version), "INIT_DIAG_VERSION_INVALID");
      result.openCodeVersion = version;
      await mkdir(join(harness.openCodeConfigDir, "plugins"), { recursive: true });
      await writeFile(join(harness.openCodeConfigDir, "plugins", "fixture.js"),
        "export default async () => { globalThis.__memoraxNoopPluginInvoked = true; return {}; };\n", { mode: 0o600 });
    }
    result.stage = "native server startup";
    const inspectorAddress = `127.0.0.1:${await freePort()}/memorax-diag`;
    server = await harness.startOpenCodeServer({ env: { BUN_INSPECT: inspectorAddress } });
    result.stage = "inspector attachment";
    inspector = await connectDiagnosticInspector(`ws://${inspectorAddress}`);
    result.stage = "npm observer installation";
    check(await inspector.evaluate(`(${installNpmTimingObserver.toString()})()`) === true, "INIT_DIAG_OBSERVER_NOT_INSTALLED");
    result.stage = "native parent session creation";
    const started = performance.now();
    try {
      const parent = await server.request("/session", { method: "POST", body: { title: "Initialization diagnostic" } });
      check(typeof parent?.id === "string" && parent.id.length > 0, "INIT_DIAG_SESSION_ID_MISSING");
      result.sessionCreated = true;
    } finally { result.sessionRequestMs = Math.round(performance.now() - started); }
    result.status = "PASS";
  } catch (error) {
    result.error = error.nativeCode ?? "INIT_DIAG_PRIVATE_ERROR_SUPPRESSED";
    result.errorDetails = describeSafeError(error);
  } finally {
    if (inspector) {
      try {
        result.npmTiming = await inspector.evaluate("globalThis.__memoraxNpmInitializationDiagnostic?.()");
        check(result.npmTiming && Array.isArray(result.npmTiming.phases), "INIT_DIAG_SNAPSHOT_MISSING");
        if (kind === "noop" && result.sessionCreated) {
          check(result.npmTiming.noopPluginInvoked === true, "INIT_DIAG_NOOP_PLUGIN_NOT_LOADED");
        }
      } catch (error) {
        result.status = "FAIL";
        result.diagnosticError = error.nativeCode ?? "INIT_DIAG_PRIVATE_ERROR_SUPPRESSED";
        result.diagnosticErrorDetails = describeSafeError(error);
      }
    }
    if (server) {
      try { result.nativeServerInitialization = await server.diagnostics(); }
      catch (error) {
        result.status = "FAIL";
        result.stateDiagnosticError = "INIT_DIAG_STATE_SNAPSHOT_FAILED";
        result.stateDiagnosticErrorDetails = describeSafeError(error);
      }
    }
    if (harness) {
      result.modelRequests = harness.modelRequests.length;
      result.memoryRequests = harness.memoryRequests.length;
      result.receiverErrors = [...harness.serverErrors];
    }
    result.cleanup = "PASS";
    for (const [operation, resource] of [["inspector", inspector], ["harness", harness]]) {
      try { await resource?.close(); }
      catch (error) {
        result.status = "FAIL"; result.cleanup = "FAIL";
        (result.cleanupErrors ??= []).push({ operation, error: error.nativeCode ?? "INIT_DIAG_PRIVATE_CLEANUP_ERROR_SUPPRESSED",
          details: describeSafeError(error) });
      }
    }
  }
  return result;
}

async function main() {
  const report = { status: "FAIL", suite: "native_opencode_initialization_diagnostic", platform: process.platform, trials: [] };
  try {
    check(process.argv.length === 4, "INIT_DIAG_EXPECTED_PACKAGE_AND_OPENCODE_PATHS");
    check(typeof WebSocket === "function", "INIT_DIAG_NATIVE_WEBSOCKET_UNAVAILABLE");
    const packageRoot = resolve(process.argv[2]), openCodeCommand = resolve(process.argv[3]);
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      for (const kind of ["actual", "noop"]) report.trials.push(await runTrial(packageRoot, openCodeCommand, kind, ordinal));
    }
    if (report.trials.every((trial) => trial.status === "PASS")) report.status = "PASS";
  } catch (error) {
    report.error = error.nativeCode ?? "INIT_DIAG_PRIVATE_ERROR_SUPPRESSED";
    report.errorDetails = describeSafeError(error);
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
