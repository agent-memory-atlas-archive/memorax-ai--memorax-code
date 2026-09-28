import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNoSensitivePayload, createServerInitializationDiagnostics, describeSafeError } from "./opencode-native-support.mjs";

for (const forbidden of ["sk_fixtureOnly", "/tmp/native-fixture", "C:\\Users\\fixture\\native-root"]) {
  test(`outbound fixture checks reject ${forbidden.includes("\\") ? "Windows paths" : forbidden.startsWith("/") ? "POSIX paths" : "credentials"}`, () => {
    assert.throws(() => assertNoSensitivePayload({ metadata: { nested: [`prefix ${forbidden}/trace.jsonl`] } }, [forbidden]),
      { nativeCode: "SENSITIVE_FIXTURE_IN_MEMORY_PAYLOAD" });
    assert.throws(() => assertNoSensitivePayload({ metadata: { [forbidden]: "fixture" } }, [forbidden]),
      { nativeCode: "SENSITIVE_FIXTURE_IN_MEMORY_PAYLOAD" });
    assert.doesNotThrow(() => assertNoSensitivePayload({ messages: [{ content: "[REDACTED:API_KEY]" }],
      metadata: { workspace: "native-root" } }, [forbidden]));
  });
}

test("outbound fixture checks reject empty canaries", () => {
  assert.throws(() => assertNoSensitivePayload({}, [""]), { nativeCode: "SENSITIVE_FIXTURE_INVALID" });
});

test("safe errors preserve timeout and SDK operation without exception text", () => {
  const error = Object.assign(new Error("private request contents"), {
    name: "TimeoutError", code: 23, nativeOperation: "SDK_REQUEST",
  });
  assert.deepEqual(describeSafeError(error), { name: "TimeoutError", code: 23, operation: "SDK_REQUEST" });
});

test("safe errors preserve allowlisted transport causes and cleanup operations", () => {
  assert.deepEqual(describeSafeError(new TypeError("fetch failed", {
    cause: Object.assign(new Error("private socket path"), { code: "ECONNREFUSED" }),
  })), { name: "TypeError", causeCode: "ECONNREFUSED" });
  assert.deepEqual(describeSafeError(Object.assign(new Error("private command output"), {
    code: 128, nativeOperation: "TASKKILL", cleanupOperation: "NATIVE_SERVER_STOP",
  })), { name: "Error", code: 128, operation: "TASKKILL", cleanupOperation: "NATIVE_SERVER_STOP" });
  assert.deepEqual(describeSafeError({ code: "EADDRINUSE", nativeOperation: "NATIVE_SERVER_PORT_RELEASE",
    cleanupOperation: "NATIVE_SERVER_STOP" }), { code: "EADDRINUSE", operation: "NATIVE_SERVER_PORT_RELEASE",
    cleanupOperation: "NATIVE_SERVER_STOP" });
});

test("safe errors discard private text and unrecognized fields instead of sanitizing arbitrary strings", () => {
  const canary = "PRIVATE_DIAGNOSTIC_CANARY";
  const error = {
    name: canary, code: canary, nativeOperation: canary, cleanupOperation: canary,
    message: `Token ${canary}`, stack: `${canary} /tmp/private-fixture`, path: `C:\\private-fixture\\${canary}`,
    token: canary, headers: { authorization: `Token ${canary}` }, stdout: canary, stderr: canary,
    cause: { code: canary, message: canary, stack: canary },
    toJSON() { throw new Error("The original error must not be serialized"); },
  };
  assert.deepEqual(describeSafeError(error), {});
  assert.equal(JSON.stringify(describeSafeError(error)).includes(canary), false);
});

test("safe numeric error codes are bounded integers and unknown values are omitted", () => {
  for (const code of [0, 1, 23, 128, 255]) assert.deepEqual(describeSafeError({ code }), { code });
  for (const code of [-1, 256, 1.5, NaN, Infinity, "1", "ERR_PRIVATE_CANARY"]) {
    assert.deepEqual(describeSafeError({ code, cause: { code } }), {});
  }
  for (const value of [undefined, null, "private text"]) assert.deepEqual(describeSafeError(value), {});
});

async function diagnosticFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-opencode-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config"), stateDir = join(root, "state");
  const lock = join(stateDir, "locks", `${createHash("sha1").update(`npm-install:${configDir}`).digest("hex")}.lock`);
  return { configDir, lock, diagnostics: createServerInitializationDiagnostics({
    configDir, stateDir, pid: 12345, version: "1.18.33",
  }) };
}

test("server diagnostics match split fixed log messages without publishing private fields", async (t) => {
  const { diagnostics } = await diagnosticFixture(t);
  const canary = "PRIVATE_NATIVE_LOG_CANARY";
  diagnostics.stderr("opencode server listening on private-address\n");
  assert.equal(diagnostics.listeningSeen, false);
  diagnostics.stdout("opencode server liste");
  diagnostics.stdout("ning on private-address\n");
  assert.equal(diagnostics.listeningSeen, true);
  for (const message of ["loading config from OPENCODE_CONFIG_DIR", "background dependency install failed", "all LSPs are disabled"]) {
    const line = `timestamp=2026-09-28T00:00:00.000Z level=DEBUG run=fixture message=${JSON.stringify(message)} path=${JSON.stringify(`C:\\Users\\${canary}`)} error=${JSON.stringify(canary)}\n`;
    for (let index = 0; index < line.length; index += 7) diagnostics.stderr(Buffer.from(line.slice(index, index + 7)));
  }
  const snapshot = await diagnostics.snapshot();
  assert.deepEqual(snapshot.milestones, { configDirectoryReached: true, dependencyInstallFailed: true, postPluginReached: true });
  assert.equal(Object.values(snapshot.dependencies).every((value) => value === false), true);
  assert.equal(JSON.stringify(snapshot).includes(canary), false);
});

test("server diagnostics reject embedded markers and discard oversized lines across chunks", async (t) => {
  const { diagnostics } = await diagnosticFixture(t);
  const prefix = "timestamp=2026-09-28T00:00:00.000Z level=INFO run=fixture ";
  diagnostics.stderr(`${prefix}message=${JSON.stringify('private message="all LSPs are disabled"')}\n`);
  diagnostics.stderr(`${prefix}message=private error=${JSON.stringify('message="background dependency install failed"')}\n`);
  diagnostics.stderr(`${prefix}message="loading config from OPENCODE_CONFIG_DIR" private=${"x".repeat(8192)}`);
  diagnostics.stderr("private-tail\n");
  diagnostics.stderr(`${prefix}message="all LSPs are disabled" private=${"\u79c1".repeat(4096)}\n`);
  assert.deepEqual((await diagnostics.snapshot()).milestones,
    { configDirectoryReached: false, dependencyInstallFailed: false, postPluginReached: false });
  diagnostics.stderr(`${prefix}message="all formatters are disabled"\n`);
  assert.equal((await diagnostics.snapshot()).milestones.postPluginReached, true);
});

test("server diagnostics expose only dependency presence, version equality, and owned npm lock", async (t) => {
  const { configDir, lock, diagnostics } = await diagnosticFixture(t);
  const pluginDir = join(configDir, "node_modules", "@opencode-ai", "plugin");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(lock, { recursive: true });
  const canary = "PRIVATE_DEPENDENCY_STATE_CANARY";
  await writeFile(join(configDir, "package.json"), JSON.stringify({ private: canary }));
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ version: "1.18.33", private: canary }));
  await writeFile(join(configDir, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/@opencode-ai/plugin": { version: "1.18.33", resolved: canary },
  } }));
  await writeFile(join(lock, "meta.json"), JSON.stringify({ pid: 12345, token: canary, hostname: canary }));
  const snapshot = await diagnostics.snapshot();
  assert.equal(Object.values(snapshot.dependencies).every((value) => value === true), true);
  assert.equal(JSON.stringify(snapshot).includes(canary), false);
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ version: canary }));
  await writeFile(join(lock, "meta.json"), JSON.stringify({ pid: 67890, token: canary }));
  const changed = await diagnostics.snapshot();
  assert.equal(changed.dependencies.pluginVersionMatches, false);
  assert.equal(changed.dependencies.npmInstallLockOwnedByServer, false);
  assert.equal(JSON.stringify(changed).includes(canary), false);
});

test("server diagnostics return unknown for unreadable or malformed state without throwing", async (t) => {
  const { configDir, lock, diagnostics } = await diagnosticFixture(t);
  await mkdir(join(configDir, "node_modules", "@opencode-ai", "plugin", "package.json"), { recursive: true });
  await mkdir(lock, { recursive: true });
  await writeFile(join(configDir, "package-lock.json"), "PRIVATE_INVALID_JSON");
  await writeFile(join(lock, "meta.json"), "PRIVATE_INVALID_JSON");
  const snapshot = await diagnostics.snapshot();
  assert.equal(snapshot.dependencies.pluginPackage, "unknown");
  assert.equal(snapshot.dependencies.pluginVersionMatches, "unknown");
  assert.equal(snapshot.dependencies.packageLock, true);
  assert.equal(snapshot.dependencies.lockPluginVersionMatches, "unknown");
  assert.equal(snapshot.dependencies.npmInstallLockOwnedByServer, "unknown");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_INVALID_JSON"), false);
});
