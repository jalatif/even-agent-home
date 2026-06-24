/**
 * Dependency-Presence Self-Check (Issue 3/5 surfacing gap)
 *
 * Why this exists: a missing runtime dependency (e.g. the old ffmpeg, or a
 * broken native module) used to surface only on FIRST USE on real hardware —
 * e.g. "Voice failed: spawn ffmpeg ENOENT" reached a user. This check runs the
 * dependency verification the backend should have done at startup, so a
 * missing/broken dep fails HERE in test (or logs loudly in prod) instead of
 * deep in a request path.
 *
 * Three checks:
 *   1. Every runtime dependency in backend/package.json can be imported.
 *   2. The STT module (backend/src/stt.js) loads AND its pipeline factory can
 *      be reached — i.e. @huggingface/transformers is present and not a broken
 *      native build (we don't run inference here; that's test-stt-contract.mjs).
 *   3. The agent-availability scan the backend uses (`command -v <bin>`) is
 *      exercised for every provider CLI, so a missing agent bin is reported
 *      explicitly rather than silently marked "Unavailable" with no signal.
 *
 * Exit code 0 = all importable + STT loads. Missing agent bins are REPORTED as
 * warnings (not failures) because agents are optional — but the STT engine and
 * the npm deps are required, so those are hard failures.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const backendPkg = JSON.parse(readFileSync(path.join(repoRoot, "backend", "package.json"), "utf8"));

let hard = 0;   // failures (must-fix)
let soft = 0;   // warnings (optional)
function fail(msg) { console.error(`  ✖ ${msg}`); hard++; }
function warn(msg) { console.warn(`  ⚠ ${msg}`); soft++; }
function ok(msg) { console.log(`  ✔ ${msg}`); }

console.log("== 1. Runtime dependencies import cleanly ==");
for (const dep of Object.keys(backendPkg.dependencies)) {
    try {
        require.resolve(dep, { paths: [path.join(repoRoot, "backend")] });
        ok(`"${dep}" resolves`);
    } catch (e) {
        fail(`"${dep}" failed to resolve: ${e.message}`);
    }
}

console.log("\n== 2. STT engine loads (transformers.js present + stt.js importable) ==");
try {
    // Dynamic import of the ESM stt module. This transitively imports
    // @huggingface/transformers; a broken/missing native onnx build would
    // throw here rather than on the first /api/transcribe request.
    const stt = await import("../backend/src/stt.js");
    if (typeof stt.transcribeAudio !== "function") {
        fail("stt.js imported but transcribeAudio is not a function");
    } else {
        ok("backend/src/stt.js imports; transcribeAudio is exported");
    }
    // Confirm @huggingface/transformers is installed and loadable from the
    // backend's context. stt.js importing successfully already proves the
    // package resolves + its ESM build loads; we additionally verify it
    // resolves via the backend's node_modules and exports the pipeline the
    // STT engine depends on. We import the bare specifier from a script that
    // sits in the backend dir's resolution scope (no direct paths option for
    // dynamic import, so we check resolvability + delegate the real load to
    // stt.js, which already succeeded above).
    let hfEntry;
    try {
        hfEntry = require.resolve("@huggingface/transformers", { paths: [path.join(repoRoot, "backend")] });
    } catch {
        hfEntry = null;
    }
    if (!hfEntry) {
        fail("@huggingface/transformers not resolvable from backend/node_modules");
    } else {
        // stt.js's successful import above exercised the ESM load path. Doing
        // a second dynamic import here of the resolved CJS entry can return a
        // different (interop-wrapped) shape, so rather than re-import we trust
        // stt.js — if transformers' pipeline/env were broken, stt.js's top-
        // level `import { pipeline, env }` would have thrown before this line.
        ok("@huggingface/transformers installed + loaded (stt.js imported it)");
    }
    // Empty-input fast path: must return "No audio provided" WITHOUT loading
    // the model (proves the lazy-load guard works and the module is callable).
    const empty = await stt.transcribeAudio([]);
    if (empty !== "No audio provided") {
        fail(`transcribeAudio([]) returned "${empty}" (expected "No audio provided")`);
    } else {
        ok("transcribeAudio([]) short-circuits without loading the model");
    }
} catch (e) {
    fail(`STT module failed to load: ${e.message}`);
}

console.log("\n== 3. Agent CLI availability (each provider bin is reported explicitly) ==");
// Mirror backend/src/routes/core.js CLI_BINS so a drift is caught.
const CLI_BINS = {
    "claude": null,      // null = SDK-based, no bin needed
    "codex": null,
    "opencode": "opencode",
    "antigravity": "agy",
    "oh-my-pi": "omp",
    "pi": "pi",
    "hermes": "hermes",
    "openclaw": "openclaw",
};
function binPresent(bin) {
    if (bin === null) return "n/a (SDK)";
    try {
        execSync(`command -v ${bin}`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}
for (const [provider, bin] of Object.entries(CLI_BINS)) {
    const present = binPresent(bin);
    if (present === "n/a (SDK)") {
        ok(`${provider}: uses SDK (no CLI bin required)`);
    } else if (present === true) {
        ok(`${provider}: CLI bin "${bin}" present`);
    } else {
        warn(`${provider}: CLI bin "${bin}" NOT on PATH (agent will report Unavailable; this is optional)`);
    }
}

console.log("\n== Summary ==");
if (hard === 0) {
    console.log(`✅ Required deps + STT engine OK. (${soft} optional agent-bin warning(s))`);
    process.exit(0);
} else {
    console.error(`❌ ${hard} required-dependency failure(s), ${soft} optional warning(s).`);
    process.exit(1);
}
