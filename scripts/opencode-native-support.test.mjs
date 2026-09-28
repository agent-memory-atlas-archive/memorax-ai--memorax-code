import assert from "node:assert/strict";
import test from "node:test";
import { assertNoSensitivePayload } from "./opencode-native-support.mjs";

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
