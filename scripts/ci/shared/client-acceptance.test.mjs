import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHANNELS, MANIFEST, npmMatrix, readAcceptance, runCli, verifyNpm } from "./client-acceptance.mjs";

const SCRIPT = fileURLToPath(new URL("./client-acceptance.mjs", import.meta.url));
const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const workflow = (await readFile(new URL("../../../.github/workflows/macos-codex-install.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const NPM = ["codex", "opencode", "claude", "codebuddy"];
const PLATFORMS = ["ubuntu-24.04", "macos-15", "windows-2025"];

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "client-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A stand-in for `npm view` that answers from dist.json beside it and logs each call; no test reaches the registry.
async function fakeNpm(root, dist) {
  const script = join(root, "npm.mjs");
  await writeFile(script, `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(new URL("./calls.jsonl", import.meta.url), JSON.stringify(args) + "\\n");
const answer = JSON.parse(readFileSync(new URL("./dist.json", import.meta.url), "utf8"))[args[1]];
if (answer === undefined) process.exit(1);
process.stdout.write(typeof answer === "string" ? answer : JSON.stringify(answer));
`);
  await writeFile(join(root, "dist.json"), JSON.stringify(dist));
  return { npm: [process.execPath, script], calls: async () => (await readFile(join(root, "calls.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line)) };
}

const recorded = (section) => Object.fromEntries(CHANNELS.map((channel) => [`${section.package}@${section[channel].version}`,
  { "dist.integrity": section[channel].integrity, "dist.shasum": section[channel].shasum }]));

test("the manifest pins a baseline and an accepted release of every native client, each cited by a run that passed it", () => {
  for (const client of [...NPM, "cursor", "workbuddy"]) {
    const section = readAcceptance(client);
    assert.ok(Object.isFrozen(section) && CHANNELS.every((channel) => Object.isFrozen(section[channel])), client);
  }
  assert.deepEqual(Object.keys(manifest.clients).sort(), [...NPM, "cursor", "workbuddy"].sort());
});

// A routine refresh changes only the accepted versions; the baselines move with the code that the latest-resolving steps run.
test("pinned npm matrices keep the baseline and oldest Node of the steps that resolve latest", () => {
  const steps = workflow.split("\n      - ");
  for (const client of NPM) {
    const step = steps.find((item) => item.includes(`\n        id: ${client}-versions\n`));
    assert.ok(step, client);
    const baseline = step.match(/^          const baseline = '([^']+)';$/m)?.[1];
    const floor = step.match(new RegExp(`^          include\\.push\\(\\{ os: 'ubuntu-24\\.04', node: '(\\d+)', ${client}: baseline, channel: 'baseline' \\}\\);$`, "m"))?.[1];
    assert.ok(baseline && floor, client);
    const section = readAcceptance(client);
    assert.equal(section.baseline.version, baseline, client);
    assert.deepEqual(npmMatrix(client, section).include[3], { os: "ubuntu-24.04", node: floor, [client]: baseline, channel: "baseline" });
  }
});

test("an npm client runs its baseline on every platform and its oldest Node, and the accepted version only where it differs", () => {
  const section = (accepted) => ({ baseline: { version: "1.2.3" }, accepted: { version: accepted } });
  assert.deepEqual(npmMatrix("claude", section("1.3.0")), { include: [
    ...PLATFORMS.map((os) => ({ os, node: "24", claude: "1.2.3", channel: "baseline" })),
    { os: "ubuntu-24.04", node: "22", claude: "1.2.3", channel: "baseline" },
    ...PLATFORMS.map((os) => ({ os, node: "24", claude: "1.3.0", channel: "accepted" })),
  ] });
  assert.deepEqual(npmMatrix("codex", section("1.2.3")), { include: [
    ...PLATFORMS.map((os) => ({ os, node: "24", codex: "1.2.3", channel: "baseline+accepted" })),
    { os: "ubuntu-24.04", node: "20", codex: "1.2.3", channel: "baseline" },
  ] });
  for (const client of ["cursor", "workbuddy", "toString"]) {
    assert.throws(() => npmMatrix(client, section("1.3.0")), { code: "CLIENT_ACCEPTANCE_ARGUMENTS_INVALID" });
  }
});

test("a missing client, channel or record, an unreadable manifest and an invalid entry all fail", async (t) => {
  const root = await temporary(t);
  const run = Object.keys(manifest.runs).at(-1);
  const cases = [
    ["codex", "{", "CLIENT_ACCEPTANCE_UNREADABLE"],
    ["codex", (m) => { m.schemaVersion = 2; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { delete m.clients.codex; }, "CLIENT_ACCEPTANCE_CLIENT_MISSING"],
    ["toString", () => {}, "CLIENT_ACCEPTANCE_CLIENT_MISSING"],
    ["codex", (m) => { delete m.clients.codex.accepted; }, "CLIENT_ACCEPTANCE_CHANNEL_MISSING"],
    ["cursor", (m) => { m.clients.cursor.baseline = null; }, "CLIENT_ACCEPTANCE_CHANNEL_MISSING"],
    ["workbuddy", (m) => { m.clients.workbuddy.accepted.platforms = {}; }, "CLIENT_ACCEPTANCE_CHANNEL_MISSING"],
    // Each pinned version cites a recorded run that passed it.
    ["codex", (m) => { m.clients.codex.accepted.acceptance = []; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.accepted.acceptance = [{ run, result: "failed", failed: ["windows-2025, Node 24"] }]; },
      "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.accepted.acceptance[0].run = "1/1"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.accepted.acceptance[0].failed = ["ubuntu-24.04, Node 24"]; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["cursor", (m) => { m.clients.cursor.accepted.acceptance[0].run = "1/1"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["workbuddy", (m) => { m.clients.workbuddy.accepted.platforms["darwin-arm64"].acceptance = []; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["workbuddy", (m) => { m.clients.workbuddy.deferred = [{ ...m.clients.workbuddy.deferred[0], runs: ["1/1"] }]; },
      "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.runs[run].head = "main"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.runs.latest = m.runs[run]; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.gaps = ["line\nbreak"]; }, "CLIENT_ACCEPTANCE_INVALID"],
    // npm entries name the exact package, registry, version and integrity.
    ["codex", (m) => { m.clients.codex.accepted.tag = "latest"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.package = "@openai/codex-fork"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.registry = "https://registry.example.invalid/"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.accepted.version = "latest"; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.accepted.integrity = `sha1-${"A".repeat(27)}=`; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { delete m.clients.codex.accepted.shasum; }, "CLIENT_ACCEPTANCE_INVALID"],
    ["codex", (m) => { m.clients.codex.accepted.version = m.clients.codex.baseline.version; }, "CLIENT_ACCEPTANCE_INVALID"],
  ];
  for (const [index, [client, change, code]] of cases.entries()) {
    const file = join(root, `manifest-${index}.json`);
    const copy = structuredClone(manifest);
    if (typeof change === "function") change(copy);
    await writeFile(file, typeof change === "string" ? change : JSON.stringify(copy));
    assert.throws(() => readAcceptance(client, file), { code }, `${index}: ${client}`);
  }
  assert.throws(() => readAcceptance("codex", join(root, "missing.json")), { code: "CLIENT_ACCEPTANCE_UNREADABLE" });
});

test("the registry must serve each pinned npm version with its recorded integrity", async (t) => {
  const section = readAcceptance("codex");
  const matching = await fakeNpm(await temporary(t), recorded(section));
  await verifyNpm(section, { npm: matching.npm });
  assert.deepEqual(await matching.calls(), CHANNELS.map((channel) => ["view", `@openai/codex@${section[channel].version}`,
    "dist.integrity", "dist.shasum", "--json", "--registry=https://registry.npmjs.org/"]));
  const accepted = `@openai/codex@${section.accepted.version}`;
  for (const [answer, code] of [[{ ...recorded(section)[accepted], "dist.shasum": "0".repeat(40) }, "CLIENT_ACCEPTANCE_INTEGRITY_MISMATCH"],
    [{ "dist.shasum": section.accepted.shasum }, "CLIENT_ACCEPTANCE_INTEGRITY_MISMATCH"],
    [undefined, "CLIENT_ACCEPTANCE_LOOKUP_FAILED"], ["not json", "CLIENT_ACCEPTANCE_LOOKUP_FAILED"]]) {
    const { npm } = await fakeNpm(await temporary(t), { ...recorded(section), [accepted]: answer });
    await assert.rejects(verifyNpm(section, { npm }), { code });
  }
});

test("the command writes the pinned matrix and summary only after both versions are verified, and never falls back", async (t) => {
  const root = await temporary(t);
  const section = readAcceptance("opencode");
  const { npm } = await fakeNpm(root, recorded(section));
  const env = { GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary") };
  const matrix = await runCli(["npm-matrix", "opencode"], { env, npm });
  assert.deepEqual(matrix, npmMatrix("opencode", section));
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), `matrix=${JSON.stringify(matrix)}\n`);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.ok(summary.includes(`baseline **${section.baseline.version}**, accepted **${section.accepted.version}**`));
  assert.match(summary, /no latest lookup and no version fallback/);
  // A failed verification writes no matrix, so no native job can start from another version.
  const failed = await temporary(t);
  const mismatched = await fakeNpm(failed, { ...recorded(section),
    [`opencode-ai@${section.accepted.version}`]: { "dist.integrity": section.baseline.integrity, "dist.shasum": section.baseline.shasum } });
  const outputs = { GITHUB_OUTPUT: join(failed, "output"), GITHUB_STEP_SUMMARY: join(failed, "summary") };
  await assert.rejects(runCli(["npm-matrix", "opencode"], { env: outputs, npm: mismatched.npm }), { code: "CLIENT_ACCEPTANCE_INTEGRITY_MISMATCH" });
  for (const file of Object.values(outputs)) await assert.rejects(readFile(file), { code: "ENOENT" });
  for (const args of [[], ["npm-matrix"], ["npm-matrix", "cursor"], ["npm-matrix", "codex", "extra"], ["resolve", "codex"]]) {
    await assert.rejects(runCli(args, { env: {}, npm }), { code: "CLIENT_ACCEPTANCE_ARGUMENTS_INVALID" }, args.join(" "));
  }
  const cli = spawnSync(process.execPath, [SCRIPT, "npm-matrix", "workbuddy"], { encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: join(root, "cli-output") } });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /^CLIENT_ACCEPTANCE_ARGUMENTS_INVALID: the pinned client inputs were not verified; no latest lookup or fallback\.\n$/);
  await assert.rejects(readFile(join(root, "cli-output")), { code: "ENOENT" });
});
