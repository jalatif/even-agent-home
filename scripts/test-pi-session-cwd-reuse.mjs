/**
 * Regression test: pi provider must reuse a session's original project dir
 * across consecutive prompts so pi never shows its "Fork this session?"
 * prompt.
 *
 * Background:
 *   pi guards a session to its original cwd. The first prompt on an unknown
 *   session recovers that cwd from the session JSONL header (findSessionCwd)
 *   and caches the session in-memory with that cwd. The SECOND prompt must
 *   reuse `existing.cwd` rather than re-deriving cwd from the request/body —
 *   otherwise pi is spawned from the backend's process.cwd(), which usually
 *   differs from the session's project, and pi emits its interactive fork
 *   prompt (which, with stdin ignored, reads as "N" → no output → "Agent
 *   Error").
 *
 * This test drives the real createPiProvider against a stub `pi` binary that
 * records the cwd it was spawned with. Both prompts must run in the project
 * dir recorded in the JSONL header — proving both the findSessionCwd path
 * (prompt 1) and the existing.cwd reuse path (prompt 2).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Isolated PI_HOME so we don't touch ~/.pi ──────────────────────────
const PI_HOME = mkdtempSync(join(tmpdir(), "pi-cwd-test-"));
const SESSIONS_DIR = join(PI_HOME, "agent", "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

// The project dir the session "belongs" to. Deliberately distinct from this
// test process's cwd so a regression (falling back to process.cwd()) is
// detectable.
const SESSION_PROJECT_DIR = mkdtempSync(join(tmpdir(), "pi-project-"));
// macOS exposes /var under /private/var via a symlink; realpath so cwd
// comparisons match regardless of which spelling each side resolves to.
const canonicalProjectDir = realpathSync(SESSION_PROJECT_DIR);

// Stub `pi`: emit minimal valid JSON the provider's stdout parser expects,
// then record the cwd we were spawned under. The session id is passed via
// --session <id>; we echo it back in a {type:"session"} event so the
// provider resolves the prompt.
const MARKER_FILE = join(PI_HOME, "spawn-cwds.txt");
const stubScript = `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
let session = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session" && args[i + 1]) session = args[i + 1];
}
// Record the actual cwd pi was spawned with.
appendFileSync(${JSON.stringify(MARKER_FILE)}, process.cwd() + "\\n");
// Minimal valid event stream: a session event + turn_end so finalize() sees
// a completed turn with output.
const out = [];
if (session) out.push(JSON.stringify({ type: "session", id: session, cwd: process.cwd() }));
out.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }));
out.push(JSON.stringify({ type: "turn_end" }));
process.stdout.write(out.join("\\n") + "\\n");
`;
const stubBin = join(PI_HOME, "fake-pi.mjs");
writeFileSync(stubBin, stubScript);
chmodSync(stubBin, 0o755);

// A pre-existing external session on disk: a JSONL file whose header carries
// the session's real project dir. findSessionCwd scans SESSIONS_DIR subdirs
// for a file whose name contains the session id and reads its first line.
const SESSION_ID = "deadbeef-1111-2222-3333-cwdreuse000001";
const sessionSubdir = join(SESSIONS_DIR, "encoded-project-dir");
mkdirSync(sessionSubdir, { recursive: true });
writeFileSync(
    join(sessionSubdir, `${SESSION_ID}.jsonl`),
    JSON.stringify({ type: "session", id: SESSION_ID, cwd: SESSION_PROJECT_DIR }) + "\n"
        + JSON.stringify({ type: "message", message: { role: "user", content: "first" } }) + "\n"
        + JSON.stringify({ type: "message", message: { role: "assistant", content: "ok" } }) + "\n"
);

// ── Load the provider with env overrides baked in BEFORE import ───────
process.env.PI_BIN = stubBin;
process.env.PI_HOME = PI_HOME;
// Ensure the test's own process.cwd() is NOT the session project dir, so a
// fall-through to process.cwd() would be visibly wrong.
assert.notStrictEqual(
    process.cwd(), SESSION_PROJECT_DIR,
    "test harness cwd must differ from the session project dir"
);

const { createPiProvider } = await import("../backend/src/pi/provider.js");

let passed = 0, failed = 0;
let provider;
const cleanup = () => { try { rmSync(PI_HOME, { recursive: true, force: true }); } catch {} try { rmSync(SESSION_PROJECT_DIR, { recursive: true, force: true }); } catch {} };

try {
    const events = [];
    provider = createPiProvider((id, evt) => events.push({ id, evt }));

    const waitForIdle = async (sessionId) => {
        for (let i = 0; i < 100; i++) {
            const st = provider.getStatus(sessionId);
            if (st && st.state === "idle") return;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`timed out waiting for idle on ${sessionId}`);
    };

    const readSpawnedCwds = () =>
        readFileSync(MARKER_FILE, "utf8").trim().split("\n").filter(Boolean);

    // ── Prompt 1: session unknown to this provider instance ───────
    // findSessionCwd should recover SESSION_PROJECT_DIR from the JSONL header.
    const r1 = await provider.prompt(SESSION_ID, "first message", "", "", "off", true);
    assert.ok(r1.sessionId, "prompt 1 must return a sessionId");
    await waitForIdle(r1.sessionId);

    // ── Prompt 2: session now cached in the in-memory map ─────────
    // The regression: previously this skipped cwd recovery and fell back to
    // process.cwd(). It must now reuse existing.cwd == SESSION_PROJECT_DIR.
    const r2 = await provider.prompt(SESSION_ID, "second message", "", "", "off", true);
    assert.ok(r2.sessionId, "prompt 2 must return a sessionId");
    await waitForIdle(r2.sessionId);

    const cwds = readSpawnedCwds();
    assert.strictEqual(cwds.length, 2, `expected 2 pi spawns, got ${cwds.length}`);

    console.log(`  prompt 1 spawned pi in: ${cwds[0]}`);
    console.log(`  prompt 2 spawned pi in: ${cwds[1]}`);
    console.log(`  expected (session project): ${SESSION_PROJECT_DIR}`);
    console.log(`  test process cwd:           ${process.cwd()}`);

    assert.strictEqual(
        cwds[0], canonicalProjectDir,
        `prompt 1: findSessionCwd must recover the JSONL project dir.\n` +
        `   got:      ${cwds[0]}\n` +
        `   expected: ${canonicalProjectDir}`
    );
    assert.strictEqual(
        cwds[1], canonicalProjectDir,
        `prompt 2: must reuse existing.cwd, not fall back to process.cwd().\n` +
        `   got:      ${cwds[1]}\n` +
        `   expected: ${canonicalProjectDir}\n` +
        `   (process.cwd was ${process.cwd()} — the fork-prompt regression)`
    );

    console.log("\n✓ PASS: both prompts reused the session's original project dir (no fork prompt).");
    passed++;
} catch (err) {
    console.error("\n✗ FAIL:", err.message);
    failed++;
} finally {
    if (typeof provider?.dispose === "function") { try { provider.dispose(); } catch {} }
    cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
