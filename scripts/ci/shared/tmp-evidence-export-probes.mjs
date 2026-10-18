// TEMPORARY: compares the evidence export probes with their expectations on a real runner.
// Reverted with the rest of the validation probes before review.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("./ci-evidence.mjs", import.meta.url));
const root = process.argv[2];
const env = process.env;
const cli = (...args) => {
  const run = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
  // Indent the child output so its workflow commands are logged, not executed.
  console.log(`$ ci-evidence.mjs ${args[0]}\n${`${run.stdout ?? ""}${run.stderr ?? ""}`.replace(/^/gm, "  | ")}`);
  return { exit: run.status, stdout: run.stdout ?? "" };
};
const status = (stdout) => /^exportStatus=([A-Z_]+)$/m.exec(stdout)?.[1] ?? "none";
const results = [];
const probe = (name, expected, actual) =>
  results.push({ name, expected, actual, ok: JSON.stringify(expected) === JSON.stringify(actual) });

const empty = cli("export-status", "--outcome", env.EMPTY_OUTCOME ?? "", "--artifact-id", env.EMPTY_ARTIFACT_ID ?? "");
probe("upload that finds no files", { uploadOutcome: "success", artifactId: "", exit: 0, exportStatus: "EMPTY", warned: true },
  { uploadOutcome: env.EMPTY_OUTCOME, artifactId: env.EMPTY_ARTIFACT_ID, exit: empty.exit, exportStatus: status(empty.stdout),
    warned: /^::warning title=CI evidence export::/m.test(empty.stdout) });

const invalid = cli("export-status", "--outcome", env.INVALID_OUTCOME ?? "", "--artifact-id", env.INVALID_ARTIFACT_ID ?? "");
probe("upload with an invalid artifact name", { uploadOutcome: "failure", artifactId: "", exit: 0, exportStatus: "UPLOAD_FAILED", warned: true },
  { uploadOutcome: env.INVALID_OUTCOME, artifactId: env.INVALID_ARTIFACT_ID, exit: invalid.exit, exportStatus: status(invalid.stdout),
    warned: /^::warning title=CI evidence export::/m.test(invalid.stdout) });

// A directory in place of the job summary file makes every summary write fail.
const unwritable = join(root, "unwritable-summary");
mkdirSync(unwritable, { recursive: true });
const exported = cli("export-status", "--outcome", "success", "--artifact-id", "1", "--github-summary", unwritable);
probe("export status with an unwritable job summary", { exit: 0, exportStatus: "UPLOADED", warned: true },
  { exit: exported.exit, exportStatus: status(exported.stdout), warned: /could not be written/.test(exported.stdout) });

const evidence = join(root, "summarize-root");
mkdirSync(join(evidence, "suites"), { recursive: true });
const summarized = cli("summarize", evidence, "--client", "codex", "--os", "windows-2025", "--test-step-outcome", "skipped",
  "--inputs-step-outcome", "skipped", "--github-summary", unwritable);
probe("evidence summary with an unwritable job summary", { exit: 0, warned: true, summaryJson: true },
  { exit: summarized.exit, warned: /^::warning title=CI evidence::The evidence summary failed/m.test(summarized.stdout),
    summaryJson: existsSync(join(evidence, "summary.json")) });

const table = ["### TEMPORARY evidence export probes (not native test results)", "",
  "| Probe | Expected | Actual | Result |", "| --- | --- | --- | --- |",
  ...results.map(({ name, expected, actual, ok }) => `| ${name} | \`${JSON.stringify(expected)}\` | \`${JSON.stringify(actual)}\` | ${ok ? "as expected" : "**differs**"} |`),
  ""].join("\n");
console.log(table);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);
process.exitCode = results.every(({ ok }) => ok) ? 0 : 1;
