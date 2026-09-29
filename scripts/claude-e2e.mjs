#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [tarballDirectory = resolve(repoRoot, "dist/npm/tarballs"), version = "2.1.277"] = process.argv.slice(2);
if (process.argv.length > 4 || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/claude-e2e.mjs [TARBALL_DIR] [CLAUDE_VERSION]");
}
const windows = process.platform === "win32";
const command = windows ? "pwsh" : "bash";
const args = windows
  ? ["-NoProfile", "-File", resolve(repoRoot, "scripts/claude-install-check.ps1"),
    "-TarballDirectory", resolve(tarballDirectory), "-ClaudeVersion", version]
  : [resolve(repoRoot, "scripts/claude-install-check.sh"), resolve(tarballDirectory), version];
const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
if (!windows) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
}
child.once("error", () => { process.exitCode = 1; console.error("Could not start the Claude functional runner."); });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
