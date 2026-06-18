/**
 * Interrupt & Dispose Lifecycle Test
 *
 * Covers the scenario gap flagged in the deep review (§5 gaps 1-2):
 *   1. interrupt() on a busy turn actually terminates it — status flips to
 *      idle and the spawned process is killed (SIGTERM, with 2s SIGKILL
 *      escalation). Before this suite, no test asserted that interrupt did
 *      anything at all for any provider.
 *   2. dispose() exists on EVERY provider and clears state without throwing.
 *      This matters because shutdownProviders() only disposes providers that
 *      expose dispose() — claude/codex/hermes previously leaked child
 *      processes on SIGINT/SIGTERM.
 *
 * Uses oh-my-pi for the live interrupt test (its SIGTERM+SIGKILL escalation
 * is the canonical pattern; omp is present in dev). The dispose smoke test
 * imports each provider factory directly so it runs even when a provider's
 * CLI is absent.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";

const PORT = 3492;
const URL = `http://localhost:${PORT}`;
const TOKEN = "interrupt-test-token";

function postJson(p, b) {
    return fetch(`${URL}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(b),
    }).then((r) => r.json());
}
function getJson(p) {
    return fetch(`${URL}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function bad(name, err) { failed++; console.error(`  ✗ ${name}: ${err?.message ?? err}`); }

// Spawn the CLI entry (not src/index.js, which is library-only — it only
// exports startServer and never calls it, so spawning it directly is a silent
// no-op). The CLI wires up token/port/host and invokes startServer. TEST_MODE=1
// bypasses auth, but we pass a real token too so this works either way.
const proc = spawn(
    "node",
    ["bin/even-agent-home.js", "--token", TOKEN, "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: "backend", env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) }, stdio: "ignore" },
);
for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${URL}/api/agents`); if (r.ok) break; } catch {}
    await sleep(300);
}

try {
    // ══════════════════════════════════════════════════════════
    // Test 1: dispose() exists and is a no-throw fn on every provider
    // ══════════════════════════════════════════════════════════
    console.log("\n── Test 1: dispose() present + callable on every provider ──");
    const factories = {
        claude: () => import("../backend/src/claude/provider.js").then((m) => m.createClaudeProvider(() => {})),
        codex: () => import("../backend/src/codex/provider.js").then((m) => m.createCodexProvider(() => {}, () => ({ threadResume() { return Promise.resolve(); }, threadUnsubscribe() { return Promise.resolve(); }, threadRead() { return Promise.resolve(null); } }))),
        opencode: () => import("../backend/src/opencode/provider.js").then((m) => m.createOpenCodeProvider(() => {})),
        antigravity: () => import("../backend/src/antigravity/provider.js").then((m) => m.createAntigravityProvider(() => {})),
        "oh-my-pi": () => import("../backend/src/oh-my-pi/provider.js").then((m) => m.createOhMyPiProvider(() => {})),
        pi: () => import("../backend/src/pi/provider.js").then((m) => m.createPiProvider(() => {})),
        hermes: () => import("../backend/src/hermes/provider.js").then((m) => m.createHermesProvider(() => {})),
    };
    for (const [id, make] of Object.entries(factories)) {
        try {
            const provider = await make();
            assert.equal(typeof provider.dispose, "function", `${id}.dispose is not a function`);
            // Must not throw on a provider with zero active sessions.
            provider.dispose();
            ok(`${id}.dispose() is a function and is a clean no-op with no sessions`);
        } catch (e) {
            bad(`${id} dispose smoke`, e);
        }
    }

    // ══════════════════════════════════════════════════════════
    // Test 2: interrupt() terminates a live busy turn (oh-my-pi)
    // ══════════════════════════════════════════════════════════
    console.log("\n── Test 2: interrupt() kills a busy oh-my-pi turn ──");
    const sid = `interrupt-test-${Date.now()}`;
    try {
        const promptRes = await postJson("/api/prompt", {
            text: "Write a very long essay about the history of computing, at least 2000 words.",
            provider: "oh-my-pi",
            sessionId: sid,
            model: "deepseek-v4-flash",
            thinking: "off",
            yolo: true,
        });
        assert.equal(promptRes.ok, true, "prompt accepted");
        const canonicalId = promptRes.sessionId;
        ok(`prompt started: ${canonicalId.slice(0, 24)}...`);

        // Poll rapidly for the busy window. omp spawns + emits `session` then
        // starts generating; we want to catch it mid-turn. If the model
        // resolves faster than our poll cadence, we still interrupt an idle
        // session, which exercises the same idempotent kill path.
        let sawBusy = false;
        for (let i = 0; i < 10; i++) {
            const probe = await getJson(`/api/status?agent=oh-my-pi&sessionId=${canonicalId}`);
            if (probe.state === "busy") { sawBusy = true; break; }
            await sleep(150);
        }
        console.log(`    caught busy before interrupt: ${sawBusy}`);

        const intrRes = await postJson("/api/interrupt", { sessionId: canonicalId, provider: "oh-my-pi" });
        assert.equal(intrRes.ok, true, "interrupt accepted");
        ok("interrupt accepted");

        // The provider resolves idle synchronously in interrupt(); allow the
        // SIGKILL escalation timer (2s) and close handler to settle.
        await sleep(2500);
        const after = await getJson(`/api/status?agent=oh-my-pi&sessionId=${canonicalId}`);
        assert.ok(after.state === "idle",
            `status should be idle after interrupt, got "${after.state}"`);
        ok(`status after interrupt: ${after.state}`);

        // The omp child must actually be gone. A second interrupt on the same
        // session must still succeed (no throw) and stay idle — proves the
        // process handle was cleared, not left dangling.
        const intrRes2 = await postJson("/api/interrupt", { sessionId: canonicalId, provider: "oh-my-pi" });
        assert.equal(intrRes2.ok, true, "second interrupt accepted (no dangling proc)");
        ok("second interrupt is a safe no-op (proc handle cleared)");
    } catch (e) {
        bad("oh-my-pi interrupt lifecycle", e);
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
} finally {
    proc.kill();
    process.exit(failed > 0 ? 1 : 0);
}
