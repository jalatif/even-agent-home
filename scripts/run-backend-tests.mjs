#!/usr/bin/env node
/**
 * Backend test runner.
 *
 * Runs every `scripts/test-*.mjs` suite and aggregates pass/fail. Suites that
 * need a live backend (or provider CLIs) are marked as integration and only
 * run when --integration is passed; the default `npm test --prefix backend`
 * runs the pure-unit suites that pass standalone.
 *
 * A suite self-declares as integration by exporting a `INTEGRATION = true`
 * named export OR by being listed in INTEGRATION_SUITES below. Suites that
 * gracefully self-skip (exit 0 when their dependency is missing, e.g.
 * test-stt-contract when ffmpeg isn't installed) are safe in the default run.
 *
 * Usage:
 *   node scripts/run-backend-tests.mjs                # unit suites only
 *   node scripts/run-backend-tests.mjs --integration  # unit + integration
 *   node scripts/run-backend-tests.mjs --all          # alias for --integration
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

// Suites that require a live backend / provider CLIs and therefore cannot run
// standalone. They are excluded from the default (unit) run.
const INTEGRATION_SUITES = new Set([
  "test-harness.mjs",            // spawns the full simulator + vite dev server
  "test-provider-contracts.mjs", // hits a real backend on :8765 for every provider
]);

const runIntegration = process.argv.includes("--integration") || process.argv.includes("--all");

const all = readdirSync(here)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort();

const unit = all.filter((f) => !INTEGRATION_SUITES.has(f));
const integration = all.filter((f) => INTEGRATION_SUITES.has(f));
const selected = runIntegration ? all : unit;

const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
const fail = [];
let pass = 0;

for (const file of selected) {
  const label = file.replace(/\.mjs$/, "");
  process.stdout.write(`${pad(label, 38)} `);
  const child = spawn(process.execPath, [join(here, file)], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.on("data", () => {}); // discard; each suite prints its own summary
  child.stderr.on("data", (c) => { stderr += c.toString(); });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code === 0) {
    pass++;
    console.log("PASS");
  } else {
    fail.push({ file, stderr: stderr.slice(-500) });
    console.log(`FAIL (exit ${code})`);
  }
}

console.log("");
if (integration.length && !runIntegration) {
  console.log(`${integration.length} integration suite(s) skipped (use --integration to include): ${integration.join(", ")}`);
}
console.log(`${pass} passed, ${fail.length} failed, ${selected.length} total`);
if (fail.length) {
  console.log("\nFailures:");
  for (const { file, stderr } of fail) {
    console.log(`  ${file}:`);
    console.log(stderr.trim().split("\n").map((l) => `    ${l}`).slice(-6).join("\n"));
  }
  process.exit(1);
}
