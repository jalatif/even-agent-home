/**
 * Unit test: CODEX_APP_SERVER_PORT resolution in startup/common.js.
 *
 * The export is `parseInt(process.env.CODEX_APP_SERVER_PORT || "8766", 10)`,
 * evaluated at module import time. This changed from a conditional default
 * (mainPort===8765 ? "8766" : "8765") to an unconditional "8766". The test
 * pins the new contract: default is 8766, and the env override is honored.
 *
 * Because the const is computed at import time, each case imports the module
 * in a fresh child process with the env pre-set (ESM module state is cached
 * per-process, so a dynamic import() inside one process can't re-evaluate it).
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(
    // Resolve to backend/src/startup/common.js relative to this script.
    new URL("../backend/src/startup/common.js", import.meta.url)
);

// Helper: import common.js in a child node process with a given env, and
// return the CODEX_APP_SERVER_PORT value it prints.
function readPort(env) {
    const out = execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(MODULE_PATH)}).then(m => process.stdout.write(String(m.CODEX_APP_SERVER_PORT)))`],
        { encoding: "utf8", env: { ...process.env, ...env } }
    );
    return parseInt(out, 10);
}

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); console.log(`  ✔ ${name}`); passed++; }
    catch (err) { console.error(`  ✖ ${name}\n    ${err.message}`); failed++; }
}

console.log("── CODEX_APP_SERVER_PORT resolution ──");

check("defaults to 8766 when env unset", () => {
    // Explicitly delete so a developer's own env doesn't skew the result.
    const port = readPort({ CODEX_APP_SERVER_PORT: "" });
    assert.equal(port, 8766, `default port should be 8766, got ${port}`);
});

check("honors CODEX_APP_SERVER_PORT override", () => {
    const port = readPort({ CODEX_APP_SERVER_PORT: "9000" });
    assert.equal(port, 9000, `override to 9000 should be honored, got ${port}`);
});

check("parses non-default numeric override", () => {
    const port = readPort({ CODEX_APP_SERVER_PORT: "31337" });
    assert.equal(port, 31337, `override to 31337 should be honored, got ${port}`);
});

// Regression guard: the OLD behavior picked 8765 when mainPort was 8766, which
// could collide with the main server. The new default is unconditionally 8766,
// so an unset env must NEVER resolve to 8765.
check("default never resolves to the old 8765 fallback", () => {
    const port = readPort({ CODEX_APP_SERVER_PORT: "" });
    assert.notEqual(port, 8765, `default must not be 8765 (old fallback), got ${port}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
