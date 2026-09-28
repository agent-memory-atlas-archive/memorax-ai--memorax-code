import assert from "node:assert/strict";
import test from "node:test";
import { assertNoSensitivePayload, describeSafeError } from "./opencode-native-support.mjs";

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
