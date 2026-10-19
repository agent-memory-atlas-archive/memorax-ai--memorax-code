import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCandidate, decideRelease, npmPublication, PACKAGE_NAME, REQUIRED_JOBS, runCli } from "./release-acceptance.mjs";

const skip = process.platform === "win32";
const temporary = (t, prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const git = (root, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const registry = (document, status = 200) => async () => ({ status, json: async () => document });

function writeRelease(root, version, changelogVersions) {
  mkdirSync(join(root, "packages/npm/memorax-code"), { recursive: true });
  writeFileSync(join(root, "packages/npm/memorax-code/package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n${changelogVersions.map((item) => `## [${item}] - 2026-10-20\n`).join("\n")}`);
}

// A repository whose first commit is the v0.1.19 release and whose HEAD prepares 0.1.20 after two merged pull requests.
function releaseRepository(t, { tagPrevious = true } = {}) {
  const root = temporary(t, "release-candidate-");
  git(root, "init", "-q", "-b", "main");
  writeRelease(root, "0.1.19", ["0.1.19"]);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore:(release) prepare 0.1.19");
  const previous = git(root, "rev-parse", "HEAD");
  if (tagPrevious) git(root, "tag", "v0.1.19");
  writeFileSync(join(root, "notes.txt"), "change\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Merge pull request #301 from memorax-ai/feature");
  writeRelease(root, "0.1.20", ["0.1.20", "0.1.19"]);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Merge pull request #302 from memorax-ai/release");
  return { root, previous, head: git(root, "rev-parse", "HEAD"), parent: git(root, "rev-parse", "HEAD^1") };
}

const candidate = (root, sha, options = {}) => collectCandidate({ root, sha, ref: "refs/heads/main", checkVersions: () => true,
  fetchImpl: registry({ versions: { "0.1.19": {} }, time: { "0.1.19": "2026-10-01" }, "dist-tags": { latest: "0.1.19" } }), ...options });

test("a main candidate with an unpublished, consistent and documented version is releasable", { skip }, async (t) => {
  const repo = releaseRepository(t);
  const record = await candidate(repo.root, repo.head);
  assert.deepEqual(record.eligibility, { status: "RELEASABLE", reasons: [], unconfirmed: [] });
  assert.equal(record.candidateSha, repo.head);
  assert.equal(record.testScriptsSha, repo.head);
  assert.deepEqual(record.package, { name: PACKAGE_NAME, version: "0.1.20" });
  assert.deepEqual(record.previousRelease, { tag: "v0.1.19", sha: repo.previous, version: "0.1.19" });
  assert.deepEqual(record.range, { from: "v0.1.19", commits: 2, pullRequests: [302, 301] });
  assert.deepEqual(record.docsBase, { sha: repo.previous, source: "previous-release" });
  assert.deepEqual(record.npm, { status: "NOT_PUBLISHED", latest: "0.1.19" });
});

test("eligibility problems are recorded as reasons, never thrown", { skip }, async (t) => {
  const repo = releaseRepository(t);
  for (const [options, reason] of [
    [{ ref: "refs/heads/chore/ci-release-acceptance" }, "REF_NOT_MAIN"],
    [{ expectedSha: "a".repeat(40) }, "CANDIDATE_SHA_MISMATCH"],
    [{ expectedSha: "main" }, "EXPECTED_SHA_INVALID"],
    [{ checkVersions: () => false }, "VERSION_INCONSISTENT"],
    [{ fetchImpl: registry({ versions: { "0.1.20": {} } }) }, "VERSION_ALREADY_PUBLISHED"],
    [{ fetchImpl: registry({ versions: {}, time: { "0.1.20": "2026-10-20" } }) }, "VERSION_PREVIOUSLY_PUBLISHED"],
  ]) {
    const record = await candidate(repo.root, repo.head, options);
    assert.equal(record.eligibility.status, "NOT_RELEASABLE", reason);
    assert.deepEqual(record.eligibility.reasons, [reason]);
  }
  assert.equal((await candidate(repo.root, repo.head, { expectedSha: repo.head.toUpperCase() })).eligibility.status, "RELEASABLE");
  assert.equal((await candidate(repo.root, repo.head, { fetchImpl: registry(null, 404) })).eligibility.status, "RELEASABLE");
});

test("an npm query that fails or cannot be read leaves eligibility unconfirmed, not unpublished", { skip }, async (t) => {
  const repo = releaseRepository(t);
  const invalid = async () => ({ status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } });
  for (const [fetchImpl, reason] of [
    [registry({}, 500), "NPM_QUERY_FAILED"], [registry({}, 429), "NPM_QUERY_FAILED"],
    [async () => { throw new TypeError("fetch failed"); }, "NPM_QUERY_FAILED"],
    [invalid, "NPM_RESPONSE_INVALID"], [registry({ versions: null }), "NPM_RESPONSE_INVALID"],
  ]) {
    const record = await candidate(repo.root, repo.head, { fetchImpl });
    assert.equal(record.npm.status, "UNCONFIRMED");
    assert.deepEqual(record.eligibility, { status: "UNCONFIRMED", reasons: [], unconfirmed: [reason] });
  }
  const offMain = await candidate(repo.root, repo.head, { ref: "refs/heads/feature", fetchImpl: registry({}, 503) });
  assert.deepEqual(offMain.eligibility, { status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN"], unconfirmed: ["NPM_QUERY_FAILED"] });
  assert.equal((await npmPublication("0.1.20", { fetchImpl: registry({}, 500) })).status, "UNCONFIRMED");
});

test("git history decides tags, the previous release and the documentation base", { skip }, async (t) => {
  const repo = releaseRepository(t);
  writeRelease(repo.root, "0.1.20", ["0.1.19"]);
  assert.deepEqual((await candidate(repo.root, repo.head)).eligibility.reasons, ["CHANGELOG_ENTRY_MISSING"]);
  git(repo.root, "checkout", "-q", "--", ".");
  git(repo.root, "tag", "v0.1.20");
  assert.deepEqual((await candidate(repo.root, repo.head)).eligibility.reasons, ["TAG_EXISTS"]);
  git(repo.root, "tag", "-d", "v0.1.20");
  git(repo.root, "tag", "v0.1.21", repo.previous);
  const notIncreased = await candidate(repo.root, repo.head);
  assert.deepEqual(notIncreased.eligibility.reasons, ["VERSION_NOT_INCREASED"]);
  assert.equal(notIncreased.previousRelease.tag, "v0.1.21");
  assert.deepEqual((await candidate(repo.root, repo.previous)).eligibility.reasons, ["CHECKOUT_MISMATCH", "VERSION_NOT_INCREASED"]);

  const untagged = releaseRepository(t, { tagPrevious: false });
  const record = await candidate(untagged.root, untagged.head);
  assert.equal(record.eligibility.status, "RELEASABLE");
  assert.equal(record.previousRelease, null);
  assert.deepEqual(record.notes, ["PREVIOUS_RELEASE_NOT_FOUND"]);
  assert.deepEqual(record.docsBase, { sha: untagged.parent, source: "first-parent" });
  const broken = await candidate(untagged.root, untagged.head, { runGit: () => { throw new Error("spawn git ENOENT"); } });
  assert.deepEqual(broken.eligibility, { status: "UNCONFIRMED", reasons: [], unconfirmed: ["GIT_QUERY_FAILED"] });
});

const SHA = "c".repeat(40);
const ENV = { GITHUB_SHA: SHA, GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "memorax-ai/memorax-code", GITHUB_SERVER_URL: "https://github.com" };
const WORKBUDDY_ROWS = [
  { os: "ubuntu-24.04", node: "24", release: { channel: "baseline+latest", desktopVersion: "5.5.6.38337834" } },
  { os: "windows-2025", node: "24", release: { channel: "fallback", desktopVersion: "5.6.2.39298511" } },
];

// One downloaded candidate package plus the run outputs, artifact record and WorkBuddy reports for a passing run.
function acceptedRun(t, { version = "0.1.20", eligibility = { status: "RELEASABLE", reasons: [], unconfirmed: [] } } = {}) {
  const root = temporary(t, "release-record-");
  const staging = join(root, "staging", "package");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  const packageDir = join(root, "download");
  mkdirSync(join(packageDir, "memorax-code-package-attempt1"), { recursive: true });
  const tgz = join(packageDir, "memorax-code-package-attempt1", "memorax-memorax-code-0.1.20.tgz");
  assert.equal(spawnSync("tar", ["-czf", tgz, "-C", join(root, "staging"), "package"]).status, 0);
  const sha256 = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  const reports = join(root, "reports");
  for (const [index, row] of WORKBUDDY_ROWS.entries()) {
    const directory = join(reports, `workbuddy-report-${row.os}-${row.release.channel}-node-${row.node}-attempt1`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "report.json"), JSON.stringify({ schemaVersion: 1, desktopVersion: row.release.desktopVersion,
      runtimeVersion: `2.1${index}.0`, arch: "x64", source: "download.codebuddy.cn" }));
  }
  const matrix = (key, value) => JSON.stringify({ include: [{ os: "ubuntu-24.04", node: "24", channel: "baseline", [key]: value }] });
  const needs = Object.fromEntries(REQUIRED_JOBS.map((id) => [id, { result: "success", outputs: {} }]));
  needs.candidate.outputs.record = JSON.stringify({ schemaVersion: 1, candidateSha: SHA, testScriptsSha: SHA, ref: "refs/heads/main",
    expectedSha: null, package: { name: PACKAGE_NAME, version: "0.1.20" }, previousRelease: { tag: "v0.1.19", sha: "b".repeat(40), version: "0.1.19" },
    range: { from: "v0.1.19", commits: 2, pullRequests: [302, 301] }, npm: { status: "NOT_PUBLISHED", latest: "0.1.19" },
    docsBase: { sha: "b".repeat(40), source: "previous-release" }, eligibility, notes: [] });
  Object.assign(needs.package.outputs, { "package-artifact-name": "memorax-code-package-attempt1", "package-artifact-id": "123",
    "package-artifact-digest": "sha256:abc", "package-sha256": sha256, "codex-matrix": matrix("codex", "0.147.0"),
    "opencode-matrix": matrix("opencode", "1.18.18"), "claude-matrix": matrix("claude", "2.1.277"),
    "codebuddy-matrix": matrix("codebuddy", "2.159.0"), "cursor-matrix": matrix("cursor", "3.21.18") });
  needs["workbuddy-releases"].outputs = { matrix: JSON.stringify({ include: WORKBUDDY_ROWS }),
    coverage: "Coverage degraded: Windows latest not tested; selected 5.6.2.39298511." };
  const artifact = { id: 123, name: "memorax-code-package-attempt1", digest: "sha256:abc", expired: false, workflow_run: { id: 999 } };
  return { root, packageDir, reports, needs, artifact, sha256,
    decide: (overrides = {}) => decideRelease({ needs, packageDir, workbuddyReportsDir: reports, artifact, env: ENV, ...overrides }) };
}

test("a releasable candidate passes only with every job and the exact package verified", { skip }, (t) => {
  const run = acceptedRun(t);
  const record = run.decide();
  assert.equal(record.verdict, "PASS");
  assert.deepEqual(record.acceptance.issues, []);
  assert.deepEqual(record.package, { file: "memorax-memorax-code-0.1.20.tgz", sha256: run.sha256,
    packageJson: { name: PACKAGE_NAME, version: "0.1.20" },
    artifact: { name: "memorax-code-package-attempt1", id: "123", digest: "sha256:abc" } });
  assert.deepEqual(record.clients.codex, [{ os: "ubuntu-24.04", node: "24", channel: "baseline", version: "0.147.0" }]);
  assert.deepEqual(record.clients.workbuddy.cells.map((cell) => [cell.channel, cell.desktopVersion, cell.runtimeVersion, cell.source]),
    [["baseline+latest", "5.5.6.38337834", "2.10.0", "download.codebuddy.cn"], ["fallback", "5.6.2.39298511", "2.11.0", "download.codebuddy.cn"]]);
  assert.match(record.clients.workbuddy.coverage, /^Coverage degraded/);
  assert.equal(record.publish.length, 5);
  assert.match(record.publish[2], /^npm publish memorax-memorax-code-0\.1\.20\.tgz --access public --tag latest$/);
  assert.equal(record.run.url, "https://github.com/memorax-ai/memorax-code/actions/runs/999");
});

test("acceptance and eligibility are decided separately", { skip }, (t) => {
  for (const [eligibility, verdict] of [
    [{ status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN", "VERSION_ALREADY_PUBLISHED"], unconfirmed: [] }, "NOT_RELEASABLE"],
    [{ status: "UNCONFIRMED", reasons: [], unconfirmed: ["NPM_QUERY_FAILED"] }, "UNCONFIRMED"],
  ]) {
    const record = acceptedRun(t, { eligibility }).decide();
    assert.equal(record.acceptance.status, "PASS");
    assert.deepEqual(record.eligibility, eligibility);
    assert.equal(record.verdict, verdict);
    assert.deepEqual(record.publish, []);
  }
  const run = acceptedRun(t, { eligibility: { status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN"], unconfirmed: [] } });
  run.needs["opencode-result"].result = "failure";
  const failed = run.decide();
  assert.equal(failed.verdict, "FAIL");
  assert.deepEqual(failed.eligibility.reasons, ["REF_NOT_MAIN"]);
});

test("failed, cancelled, skipped or missing required jobs never pass", { skip }, (t) => {
  for (const id of REQUIRED_JOBS) {
    for (const [result, verdict] of [["failure", "FAIL"], ["cancelled", "INCOMPLETE"], ["skipped", "INCOMPLETE"], [undefined, "INCOMPLETE"]]) {
      const run = acceptedRun(t);
      if (result) run.needs[id].result = result;
      else delete run.needs[id];
      const record = run.decide();
      assert.equal(record.verdict, verdict, `${id}=${result}`);
      if (id === "candidate") assert.equal(record.eligibility.status, "UNCONFIRMED");
    }
  }
});

test("the candidate package must be the recorded artifact, file, checksum and version", { skip }, (t) => {
  const cases = [
    ["checksum", (run) => { run.needs.package.outputs["package-sha256"] = "0".repeat(64); }, "FAIL", "PACKAGE_SHA256_MISMATCH"],
    ["no file", (run) => rmSync(run.packageDir, { recursive: true }), "INCOMPLETE", "PACKAGE_FILE_MISSING"],
    ["two files", (run) => writeFileSync(join(run.packageDir, "memorax-memorax-code-0.1.21.tgz"), ""), "FAIL", "PACKAGE_FILE_AMBIGUOUS"],
    ["no artifact record", (run) => ({ artifact: null }), "INCOMPLETE", "ARTIFACT_METADATA_MISSING"],
    ["digest", (run) => ({ artifact: { ...run.artifact, digest: "sha256:other" } }), "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["other run", (run) => ({ artifact: { ...run.artifact, workflow_run: { id: 1 } } }), "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["expired", (run) => ({ artifact: { ...run.artifact, expired: true } }), "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["no package outputs", (run) => { delete run.needs.package.outputs["package-artifact-id"]; }, "INCOMPLETE", "PACKAGE_RECORD_MISSING"],
    ["unreadable metadata", (run) => {
      const tgz = join(run.packageDir, "memorax-code-package-attempt1", "memorax-memorax-code-0.1.20.tgz");
      writeFileSync(tgz, "not a tarball");
      run.needs.package.outputs["package-sha256"] = createHash("sha256").update("not a tarball").digest("hex");
    }, "INCOMPLETE", "PACKAGE_METADATA_UNREADABLE"],
  ];
  for (const [label, change, verdict, issue] of cases) {
    const run = acceptedRun(t);
    const record = run.decide(change(run) ?? {});
    assert.equal(record.verdict, verdict, label);
    assert.ok(record.acceptance.issues.includes(issue), `${label}: ${record.acceptance.issues}`);
  }
  const wrongVersion = acceptedRun(t, { version: "0.1.19" }).decide();
  assert.equal(wrongVersion.verdict, "FAIL");
  assert.ok(wrongVersion.acceptance.issues.includes("PACKAGE_VERSION_MISMATCH"));
});

test("the candidate record must exist and keep the run's commit", { skip }, (t) => {
  const unreadable = acceptedRun(t);
  unreadable.needs.candidate.outputs.record = "{not json";
  const missing = unreadable.decide();
  assert.equal(missing.verdict, "INCOMPLETE");
  assert.deepEqual(missing.eligibility, { status: "UNCONFIRMED", reasons: [], unconfirmed: ["CANDIDATE_RECORD_MISSING"] });
  const moved = acceptedRun(t).decide({ env: { ...ENV, GITHUB_SHA: "d".repeat(40) } });
  assert.equal(moved.verdict, "FAIL");
  assert.ok(moved.acceptance.issues.includes("CANDIDATE_SHA_CHANGED"));
});

test("WorkBuddy versions come from each cell's latest report and must match the frozen release", { skip }, (t) => {
  const run = acceptedRun(t);
  const first = join(run.reports, "workbuddy-report-windows-2025-fallback-node-24-attempt1", "report.json");
  const retry = join(run.reports, "workbuddy-report-windows-2025-fallback-node-24-attempt2");
  mkdirSync(retry, { recursive: true });
  writeFileSync(join(retry, "report.json"), JSON.stringify({ desktopVersion: "5.6.2.39298511", runtimeVersion: "2.99.0" }));
  writeFileSync(first, JSON.stringify({ desktopVersion: "9.9.9.9", runtimeVersion: "2.11.0" }));
  const record = run.decide();
  assert.equal(record.verdict, "PASS");
  assert.equal(record.clients.workbuddy.cells[1].runtimeVersion, "2.99.0");
  assert.equal(record.clients.workbuddy.cells[1].report, "workbuddy-report-windows-2025-fallback-node-24-attempt2");
  rmSync(retry, { recursive: true });
  const mismatch = run.decide();
  assert.equal(mismatch.verdict, "FAIL");
  assert.ok(mismatch.acceptance.issues.includes("WORKBUDDY_REPORT_MISMATCH"));
  rmSync(join(run.reports, "workbuddy-report-ubuntu-24.04-baseline+latest-node-24-attempt1"), { recursive: true });
  assert.ok(run.decide().acceptance.issues.includes("WORKBUDDY_REPORT_MISSING"));
});

test("the record CLI keeps earlier attempts and exits 0 only for a passing releasable candidate", { skip }, async (t) => {
  for (const [eligibility, code] of [[undefined, 0], [{ status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN"], unconfirmed: [] }, 1]]) {
    const run = acceptedRun(t, eligibility ? { eligibility } : {});
    const api = join(run.root, "api");
    mkdirSync(api);
    writeFileSync(join(api, "artifact.json"), JSON.stringify(run.artifact));
    writeFileSync(join(api, "attempt-1.json"), JSON.stringify([{ jobs: [{ name: "Cursor App latest 3.25.6 (windows-2025, Node 24)", conclusion: "failure" },
      { name: "package", conclusion: "success" }] }]));
    const output = join(run.root, "record", "release-record.json");
    const summary = join(run.root, "summary.md");
    const status = await runCli(["record", "--package-dir", run.packageDir, "--workbuddy-reports", run.reports, "--api-dir", api,
      "--output", output, "--github-summary", summary], { ...ENV, GITHUB_RUN_ATTEMPT: "2", NEEDS_JSON: JSON.stringify(run.needs) });
    assert.equal(status, code);
    const record = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(record.run.earlierAttempts, [{ attempt: 1, unsuccessfulJobs: ["Cursor App latest 3.25.6 (windows-2025, Node 24): failure"] }]);
    assert.match(readFileSync(summary, "utf8"), code ? /does not accept the candidate for delivery/ : /Publish the accepted file manually/);
  }
});
