// Release acceptance for one dispatched commit: record the candidate and its release eligibility, then decide whether
// the run's single candidate package passed acceptance. Acceptance and eligibility are decided and recorded separately;
// an eligibility problem never stops acceptance jobs, and only a passing acceptance of a releasable candidate exits 0.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@memorax/memorax-code";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}`;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SCHEMA = 1;
// Jobs whose results decide acceptance; each result job already requires its whole matrix.
export const REQUIRED_JOBS = ["candidate", "basic-checks", "package", "workbuddy-releases", "functional-result",
  "opencode-result", "claude-result", "codebuddy-result", "cursor-app-result", "workbuddy-result"];
const CLIENTS = { codex: "codex", opencode: "opencode", claude: "claude", codebuddy: "codebuddy", cursor: "cursor" };

function compareVersions(left, right) {
  const parse = (value) => value.split("-")[0].split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function gitRunner(root) {
  return (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout.trim() };
  };
}

function versionsConsistent(root) {
  return spawnSync(process.execPath, ["scripts/sync-release-version.mjs", "--check"], { cwd: root, encoding: "utf8", timeout: 60_000 }).status === 0;
}

// Read whether this exact version was ever published. A failed or unreadable query never counts as unpublished.
export async function npmPublication(version, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: "UNCONFIRMED", reason: "NPM_QUERY_FAILED" };
  }
  if (response.status === 404) return { status: "NOT_PUBLISHED", latest: null };
  if (response.status !== 200) return { status: "UNCONFIRMED", reason: "NPM_QUERY_FAILED", httpStatus: response.status };
  let document;
  try {
    document = await response.json();
  } catch {
    return { status: "UNCONFIRMED", reason: "NPM_RESPONSE_INVALID" };
  }
  if (!document || typeof document.versions !== "object" || document.versions === null) {
    return { status: "UNCONFIRMED", reason: "NPM_RESPONSE_INVALID" };
  }
  const latest = SEMVER.test(document["dist-tags"]?.latest ?? "") ? document["dist-tags"].latest : null;
  if (Object.hasOwn(document.versions, version)) return { status: "PUBLISHED", latest };
  // npm never reuses an unpublished version number.
  if (document.time && Object.hasOwn(document.time, version)) return { status: "PREVIOUSLY_PUBLISHED", latest };
  return { status: "NOT_PUBLISHED", latest };
}

export async function collectCandidate({ root, sha, ref, expectedSha = "", runGit = gitRunner(root),
  checkVersions = () => versionsConsistent(root), fetchImpl } = {}) {
  const reasons = [], unconfirmed = [], notes = [];
  const packageJson = JSON.parse(readFileSync(join(root, "packages/npm/memorax-code/package.json"), "utf8"));
  const version = packageJson.version;
  if (packageJson.name !== PACKAGE_NAME || !SEMVER.test(version)) reasons.push("PACKAGE_IDENTITY_INVALID");
  if (ref !== "refs/heads/main") reasons.push("REF_NOT_MAIN");
  const expected = expectedSha.trim().toLowerCase();
  if (expected && !COMMIT.test(expected)) reasons.push("EXPECTED_SHA_INVALID");
  else if (expected && expected !== sha) reasons.push("CANDIDATE_SHA_MISMATCH");
  if (!checkVersions()) reasons.push("VERSION_INCONSISTENT");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) reasons.push("CHANGELOG_ENTRY_MISSING");

  let previousRelease = null, range = null, docsBase = null;
  try {
    const head = runGit(["rev-parse", "HEAD"]);
    if (head.status !== 0) throw new Error("GIT_QUERY_FAILED");
    if (head.stdout !== sha) reasons.push("CHECKOUT_MISMATCH");
    const tag = runGit(["rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`]);
    if (tag.status === 0) reasons.push("TAG_EXISTS");
    else if (tag.status !== 1) throw new Error("GIT_QUERY_FAILED");
    const merged = runGit(["tag", "--merged", sha, "--list", "v*", "--sort=-version:refname"]);
    if (merged.status !== 0) throw new Error("GIT_QUERY_FAILED");
    const previous = merged.stdout.split("\n").find((name) => name && name !== `v${version}` && SEMVER.test(name.slice(1)));
    if (previous) {
      const commit = runGit(["rev-list", "-n", "1", previous]);
      const count = runGit(["rev-list", "--count", `${previous}..${sha}`]);
      const subjects = runGit(["log", "--first-parent", "--format=%s", `${previous}..${sha}`]);
      if ([commit, count, subjects].some((result) => result.status !== 0)) throw new Error("GIT_QUERY_FAILED");
      previousRelease = { tag: previous, sha: commit.stdout, version: previous.slice(1) };
      if (compareVersions(previousRelease.version, version) >= 0) reasons.push("VERSION_NOT_INCREASED");
      const pullRequests = [...subjects.stdout.matchAll(/^Merge pull request #(\d+) /gm)].map((match) => Number(match[1]));
      range = { from: previous, commits: Number(count.stdout), pullRequests };
      docsBase = { sha: commit.stdout, source: "previous-release" };
    } else {
      notes.push("PREVIOUS_RELEASE_NOT_FOUND");
      const parent = runGit(["rev-parse", `${sha}^1`]);
      if (parent.status === 0) docsBase = { sha: parent.stdout, source: "first-parent" };
    }
  } catch {
    unconfirmed.push("GIT_QUERY_FAILED");
  }

  const npm = await npmPublication(version, { fetchImpl });
  if (npm.status === "PUBLISHED") reasons.push("VERSION_ALREADY_PUBLISHED");
  else if (npm.status === "PREVIOUSLY_PUBLISHED") reasons.push("VERSION_PREVIOUSLY_PUBLISHED");
  else if (npm.status === "UNCONFIRMED") unconfirmed.push(npm.reason);
  if (npm.latest && previousRelease && npm.latest !== previousRelease.version) notes.push("NPM_LATEST_DIFFERS_FROM_PREVIOUS_RELEASE");

  const status = reasons.length ? "NOT_RELEASABLE" : unconfirmed.length ? "UNCONFIRMED" : "RELEASABLE";
  return {
    schemaVersion: SCHEMA, candidateSha: sha, testScriptsSha: sha, ref, expectedSha: expected || null,
    package: { name: packageJson.name, version }, previousRelease, range, npm, docsBase,
    eligibility: { status, reasons, unconfirmed }, notes,
  };
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const parseJson = (value) => {
  try { return JSON.parse(value); } catch { return null; }
};

function matrixRows(value) {
  const include = parseJson(value ?? "")?.include;
  return Array.isArray(include) ? include : null;
}

// Verify that the downloaded artifact is the package job's exact candidate and read its own package metadata.
function verifyPackage({ outputs, candidate, packageDir, artifact, runId }, fail, incomplete) {
  const record = { file: null, sha256: outputs["package-sha256"] || null, packageJson: null,
    artifact: { name: outputs["package-artifact-name"] || null, id: outputs["package-artifact-id"] || null, digest: outputs["package-artifact-digest"] || null } };
  if (!record.sha256 || !record.artifact.name || !record.artifact.id || !record.artifact.digest) {
    incomplete("PACKAGE_RECORD_MISSING");
    return record;
  }
  if (!artifact) incomplete("ARTIFACT_METADATA_MISSING");
  else if (String(artifact.id) !== record.artifact.id || artifact.name !== record.artifact.name || artifact.digest !== record.artifact.digest
    || artifact.expired !== false || String(artifact.workflow_run?.id) !== String(runId)) fail("ARTIFACT_IDENTITY_MISMATCH");
  const files = walk(packageDir).filter((path) => /(?:^|[\\/])memorax-memorax-code-[^\\/]+\.tgz$/.test(path));
  if (files.length !== 1) {
    (files.length ? fail : incomplete)(files.length ? "PACKAGE_FILE_AMBIGUOUS" : "PACKAGE_FILE_MISSING");
    return record;
  }
  const [file] = files;
  record.file = file.split(/[\\/]/).at(-1);
  if (lstatSync(file).isSymbolicLink()) {
    fail("PACKAGE_FILE_NOT_REGULAR");
    return record;
  }
  if (sha256File(file) !== record.sha256) fail("PACKAGE_SHA256_MISMATCH");
  const extracted = spawnSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const metadata = extracted.status === 0 ? parseJson(extracted.stdout) : null;
  if (!metadata) {
    incomplete("PACKAGE_METADATA_UNREADABLE");
    return record;
  }
  record.packageJson = { name: metadata.name, version: metadata.version };
  if (candidate && (metadata.name !== PACKAGE_NAME || metadata.version !== candidate.package.version
    || record.file !== `memorax-memorax-code-${candidate.package.version}.tgz`)) fail("PACKAGE_VERSION_MISMATCH");
  return record;
}

// Pick each WorkBuddy cell's report from the latest attempt that produced one.
function workbuddyCells(rows, reportsDir, fail, incomplete) {
  const directories = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
  return (rows ?? []).map((row) => {
    const prefix = `workbuddy-report-${row.os}-${row.release?.channel}-node-${row.node}-attempt`;
    const latest = directories.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)))[0];
    const report = latest ? parseJson(existsSync(join(reportsDir, latest, "report.json")) ? readFileSync(join(reportsDir, latest, "report.json"), "utf8") : "") : null;
    const cell = { os: row.os, node: row.node, channel: row.release?.channel, desktopVersion: row.release?.desktopVersion,
      runtimeVersion: null, arch: null, source: null, report: latest ?? null };
    if (!report || !/^\d+\.\d+\.\d+$/.test(report.runtimeVersion ?? "") || !/^\d+\.\d+\.\d+\.\d+$/.test(report.desktopVersion ?? "")) {
      incomplete("WORKBUDDY_REPORT_MISSING");
      return cell;
    }
    if (report.desktopVersion !== row.release?.desktopVersion) fail("WORKBUDDY_REPORT_MISMATCH");
    return { ...cell, runtimeVersion: report.runtimeVersion, arch: report.arch ?? null, source: report.source ?? null };
  });
}

export function decideRelease({ needs, packageDir, workbuddyReportsDir, artifact = null, attempts = [], env = process.env }) {
  const issues = { fail: new Set(), incomplete: new Set() };
  const fail = (code) => issues.fail.add(code);
  const incomplete = (code) => issues.incomplete.add(code);
  const jobs = Object.fromEntries(REQUIRED_JOBS.map((id) => [id, needs?.[id]?.result ?? "missing"]));
  for (const [id, result] of Object.entries(jobs)) {
    if (result === "failure") fail(`JOB_FAILED:${id}`);
    else if (result !== "success") incomplete(`JOB_NOT_SUCCESSFUL:${id}:${result}`);
  }

  const candidate = needs?.candidate?.result === "success" ? parseJson(needs.candidate.outputs?.record ?? "") : null;
  if (!candidate || candidate.schemaVersion !== SCHEMA) incomplete("CANDIDATE_RECORD_MISSING");
  else if (candidate.candidateSha !== env.GITHUB_SHA) fail("CANDIDATE_SHA_CHANGED");
  const outputs = needs?.package?.outputs ?? {};
  const packageRecord = verifyPackage({ outputs, candidate, packageDir, artifact, runId: env.GITHUB_RUN_ID }, fail, incomplete);

  const clients = {};
  for (const [name, key] of Object.entries(CLIENTS)) {
    const rows = matrixRows(outputs[`${name}-matrix`]);
    if (!rows) incomplete(`CLIENT_VERSIONS_MISSING:${name}`);
    clients[name] = (rows ?? []).map((row) => ({ os: row.os, node: row.node, channel: row.channel, version: row[key] }));
  }
  const workbuddyRows = matrixRows(needs?.["workbuddy-releases"]?.outputs?.matrix);
  if (!workbuddyRows) incomplete("CLIENT_VERSIONS_MISSING:workbuddy");
  clients.workbuddy = { coverage: needs?.["workbuddy-releases"]?.outputs?.coverage || null,
    cells: workbuddyCells(workbuddyRows, workbuddyReportsDir, fail, incomplete) };

  const acceptance = issues.fail.size ? "FAIL" : issues.incomplete.size ? "INCOMPLETE" : "PASS";
  const eligibility = candidate?.eligibility ?? { status: "UNCONFIRMED", reasons: [], unconfirmed: ["CANDIDATE_RECORD_MISSING"] };
  const verdict = acceptance !== "PASS" ? acceptance
    : { RELEASABLE: "PASS", NOT_RELEASABLE: "NOT_RELEASABLE" }[eligibility.status] ?? "UNCONFIRMED";
  const version = candidate?.package?.version ?? null;
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const distTag = version?.includes("-") ? "preview" : "latest";
  return {
    schemaVersion: SCHEMA, verdict,
    acceptance: { status: acceptance, jobs, issues: [...issues.fail, ...issues.incomplete] },
    eligibility: { status: eligibility.status, reasons: eligibility.reasons ?? [], unconfirmed: eligibility.unconfirmed ?? [] },
    candidate: candidate ? { version, candidateSha: candidate.candidateSha, testScriptsSha: candidate.testScriptsSha,
      ref: candidate.ref, expectedSha: candidate.expectedSha } : null,
    package: packageRecord,
    previousRelease: candidate?.previousRelease ?? null, range: candidate?.range ?? null,
    npm: candidate?.npm ?? null, docsBase: candidate?.docsBase ?? null, notes: candidate?.notes ?? [],
    clients,
    run: { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT), url: runUrl,
      earlierAttempts: attempts.map(({ attempt, jobs: list }) => ({ attempt,
        unsuccessfulJobs: list.filter((job) => ["failure", "cancelled", "timed_out"].includes(job.conclusion)).map((job) => `${job.name}: ${job.conclusion}`) })) },
    upgradeCoverage: "Upgrade suites install fixed earlier MemoraX Code versions; upgrading from the previous release to this candidate is not exercised.",
    publish: verdict !== "PASS" ? [] : [
      `Download ${packageRecord.artifact.name} (artifact ${packageRecord.artifact.id}) from ${runUrl}; do not rebuild.`,
      `Confirm that sha256 of ${packageRecord.file} is ${packageRecord.sha256}.`,
      `npm publish ${packageRecord.file} --access public --tag ${distTag}`,
      `Compare npm view ${PACKAGE_NAME}@${version} dist.integrity dist.shasum with the sha512 and sha1 of the same file.`,
      `Tag v${version} at ${candidate.candidateSha} and attach the same file and its SHA256SUMS to the GitHub Release.`,
    ],
  };
}

function renderCandidate(record) {
  const range = record.range ? `${record.range.commits} commits since ${record.range.from}${record.range.pullRequests.length ? `, PRs ${record.range.pullRequests.map((number) => `#${number}`).join(", ")}` : ""}` : "previous release not found";
  return [`### Release candidate ${record.package.version}`, "",
    `- Candidate ${record.candidateSha} (test scripts from ${record.testScriptsSha}), ref ${record.ref}`,
    `- Eligibility: **${record.eligibility.status}**${[...record.eligibility.reasons, ...record.eligibility.unconfirmed].length ? ` (${[...record.eligibility.reasons, ...record.eligibility.unconfirmed].join(", ")})` : ""}`,
    `- npm: ${record.npm.status}${record.npm.latest ? `, latest ${record.npm.latest}` : ""}; ${range}`,
    `- Documentation compares with ${record.docsBase ? `${record.docsBase.sha} (${record.docsBase.source})` : "an unrecorded base"}`, "",
    "Eligibility is recorded separately and does not stop the acceptance jobs.", ""].join("\n");
}

function renderRecord(record) {
  const listed = (values) => (values.length ? ` (${values.join(", ")})` : "");
  return [`### Release acceptance: **${record.verdict}**`, "",
    `- Acceptance: **${record.acceptance.status}**${listed(record.acceptance.issues)}`,
    `- Eligibility: **${record.eligibility.status}**${listed([...record.eligibility.reasons, ...record.eligibility.unconfirmed])}`,
    `- Candidate: ${record.candidate ? `${record.candidate.version} at ${record.candidate.candidateSha}` : "not recorded"}`,
    `- Package: ${record.package.file ?? "not verified"}, tgz SHA-256 ${record.package.sha256 ?? "-"}; artifact ${record.package.artifact.name ?? "-"} (ID ${record.package.artifact.id ?? "-"}, digest ${record.package.artifact.digest ?? "-"})`,
    `- Previous release: ${record.previousRelease ? `${record.previousRelease.tag} at ${record.previousRelease.sha}` : "not found"}`,
    `- WorkBuddy coverage: ${record.clients.workbuddy.coverage ?? "unavailable"}`,
    `- ${record.upgradeCoverage}`, "",
    record.verdict === "PASS" ? `Publish the accepted file manually:\n\n${record.publish.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n`
      : "This run does not accept the candidate for delivery. Do not publish its package.\n", ""].join("\n");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = /^--([a-z][a-z0-9-]{0,40})$/.exec(args[index])?.[1];
    if (!name || index + 1 >= args.length) throw new Error("Usage: release-acceptance.mjs candidate|record --option value ...");
    options[name] = args[index + 1];
  }
  return options;
}

function readAttempts(apiDir) {
  if (!apiDir || !existsSync(apiDir)) return [];
  return readdirSync(apiDir).map((name) => /^attempt-(\d+)\.json$/.exec(name)).filter(Boolean)
    .map((match) => ({ attempt: Number(match[1]),
      jobs: (parseJson(readFileSync(join(apiDir, match[0]), "utf8")) ?? []).flatMap((page) => page?.jobs ?? []) }))
    .sort((left, right) => left.attempt - right.attempt);
}

export async function runCli(args, env = process.env) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command === "candidate") {
    const record = await collectCandidate({ root: process.cwd(), sha: options.sha, ref: options.ref, expectedSha: options["expected-sha"] ?? "" });
    if (options["github-output"]) appendFileSync(options["github-output"], `record=${JSON.stringify(record)}\ndocs-base-sha=${record.docsBase?.sha ?? ""}\n`);
    if (options["github-summary"]) appendFileSync(options["github-summary"], renderCandidate(record));
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  if (command === "record") {
    let record;
    try {
      const artifactPath = options["api-dir"] ? join(options["api-dir"], "artifact.json") : "";
      record = decideRelease({
        needs: parseJson(env.NEEDS_JSON ?? "") ?? {}, packageDir: options["package-dir"], workbuddyReportsDir: options["workbuddy-reports"],
        artifact: artifactPath && existsSync(artifactPath) ? parseJson(readFileSync(artifactPath, "utf8")) : null,
        attempts: readAttempts(options["api-dir"]), env,
      });
    } catch (error) {
      record = { schemaVersion: SCHEMA, verdict: "INCOMPLETE", acceptance: { status: "INCOMPLETE", issues: [`RECORD_FAILED:${error.code ?? error.name}`] } };
    }
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(record, null, 2)}\n`);
    if (options["github-summary"]) {
      appendFileSync(options["github-summary"], record.package ? renderRecord(record)
        : `### Release acceptance: **${record.verdict}**\n\n${record.acceptance.issues.join(", ")}\n\n`);
    }
    console.log(JSON.stringify(record, null, 2));
    return record.verdict === "PASS" ? 0 : 1;
  }
  throw new Error("Usage: release-acceptance.mjs candidate|record --option value ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`::error title=Release acceptance::${error.message}`);
    process.exitCode = 1;
  });
}
