/**
 * Regression test: pi provider must NOT surface the "Session found in different
 * project ... Fork this session?" prompt as an "Agent Error".
 *
 * Background:
 *   When a session's original cwd differs from the backend's cwd AND
 *   findSessionCwd() can't recover it (e.g. session created by another backend
 *   instance, or JSONL rotated), pi is spawned from the wrong dir. pi prints
 *   its interactive fork prompt to stderr, reads EOF on stdin (ignored) = "N",
 *   produces no assistant output, and exits. Before the fix, finalize() treated
 *   this as a silent failure and surfaced the fork-prompt text as agentError —
 *   a confusing "Agent Error" on the glasses for what is really just a cwd
 *   mismatch warning (the session is still usable on the next prompt).
 *
 *   The fix detects the fork-prompt pattern in finalize() and treats it as a
 *   non-error (success=true, error=undefined).
 *
 * This test drives createPiProvider against a stub `pi` that emits the fork
 * prompt on stderr + exits with no output. The provider's result event must
 * report success and no error.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_HOME = mkdtempSync(join(tmpdir(), "pi-fork-test-"));
const SESSIONS_DIR = join(PI_HOME, "agent", "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

// Stub `pi`: emit the fork prompt on stderr, NO JSON on stdout, exit 0.
// This is exactly what pi does when spawned from a cwd that differs from the
// session's original project and stdin is ignored.
const stubScript = `#!/usr/bin/env node
process.stderr.write("Session found in different project: /some/other/dir\\n");
process.stderr.write("Fork this session into current directory? [y/N]\\n");
// No stdout, no JSON events, no turn_end — exit cleanly. Provider's finalize()
// will see !fullText && !sawTurnEnd and must recognize the fork-prompt pattern.
process.exit(0);
`;
const stubBin = join(PI_HOME, "fake-pi-fork.mjs");
writeFileSync(stubBin, stubScript);
chmodSync(stubBin, 0o755);

process.env.PI_BIN = stubBin;
process.env.PI_HOME = PI_HOME;

const { createPiProvider } = await import("../backend/src/pi/provider.js");

const cleanup = () => { try { rmSync(PI_HOME, { recursive: true, force: true }); } catch {} };

try {
    const events = [];
    const provider = createPiProvider((id, evt) => events.push({ id, evt }));

    const waitForResult = async (sessionId) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const result = events.find((e) => e.id === sessionId && e.evt.type === "result");
            if (result) return result.evt;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("timeout waiting for result event");
    };

    // Prompt with a session id that has NO recoverable cwd (no JSONL on disk,
    // not in the in-memory map) — forces the fall-through to process.cwd(),
    // triggering pi's fork prompt.
    const SESSION_ID = "fork-test-0001";
    const promptPromise = provider.prompt(SESSION_ID, "hello", undefined, undefined, undefined, false);

    const result = await waitForResult(SESSION_ID);
    await promptPromise;

    // The fix: fork-prompt is suppressed, NOT surfaced as an error.
    assert.equal(
        result.success, true,
        `fork-prompt must be suppressed (success=true); got success=${result.success} error=${JSON.stringify(result.error)}`
    );
    assert.equal(
        result.error, undefined,
        `fork-prompt must not surface as agentError; got: ${JSON.stringify(result.error)}`
    );

    // And getStatus must not carry a lingering lastError.
    const status = provider.getStatus(SESSION_ID);
    assert.equal(status.error, undefined, `getStatus must not carry the fork-prompt as error; got: ${JSON.stringify(status.error)}`);

    console.log("\n✓ PASS: pi 'Fork this session?' prompt suppressed (not surfaced as Agent Error).");
} catch (e) {
    console.error("\n✗ FAIL:", e.message);
    cleanup();
    process.exit(1);
}

cleanup();
