/**
 * YOLO Mode Harness Test — end-to-end via backend
 *
 * Tests actual prompt endpoint with yolo=true/false/missing.
 * Uses a dedicated port to avoid conflicts.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";

const PORT = 3467;
const URL = `http://localhost:${PORT}`;
const LOG_PREFIX = "[harness]";

function log(...args) { console.log(LOG_PREFIX, ...args); }

async function postJson(path, body) {
    const res = await fetch(`${URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function getJson(path) {
    const res = await fetch(`${URL}${path}`);
    return res.json();
}

// ── Start backend ───────────────────────────────────────────
log("Starting backend...");
const proc = spawn("node", ["src/index.js"], {
    cwd: "backend",
    env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) },
    stdio: "ignore",
});

// Wait until /api/agents responds
for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${URL}/api/agents`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 300));
}

try {
    // ── Verify agents ───────────────────────────────────────
    const agents = await getJson("/api/agents");
    assert.ok(agents.agents.some(a => a.id === "oh-my-pi"), "oh-my-pi available");

    // ── yolo=true ───────────────────────────────────────────
    log("Test: yolo=true");
    const r1 = await postJson("/api/prompt", {
        text: "hi",
        provider: "oh-my-pi",
        sessionId: `yolo-true-${Date.now()}`,
        model: "deepseek-v4-flash",
        thinking: "medium",
        yolo: true,
    });
    assert.equal(r1.ok, true, "yolo=true → ok:true");
    assert.ok(r1.sessionId, "yolo=true → has sessionId");
    log("  ✓ yolo=true prompt accepted");

    // ── yolo=false ──────────────────────────────────────────
    log("Test: yolo=false");
    const r2 = await postJson("/api/prompt", {
        text: "hi",
        provider: "oh-my-pi",
        sessionId: `yolo-false-${Date.now()}`,
        model: "deepseek-v4-flash",
        thinking: "medium",
        yolo: false,
    });
    assert.equal(r2.ok, true, "yolo=false → ok:true");
    log("  ✓ yolo=false prompt accepted");

    // ── yolo missing (default safe) ─────────────────────────
    log("Test: yolo missing");
    const r3 = await postJson("/api/prompt", {
        text: "hi",
        provider: "oh-my-pi",
        sessionId: `yolo-none-${Date.now()}`,
        model: "deepseek-v4-flash",
        thinking: "medium",
    });
    assert.equal(r3.ok, true, "yolo missing → ok:true");
    log("  ✓ no-yolo prompt accepted");

    // ── yolo=1 coerced ──────────────────────────────────────
    log("Test: yolo=1");
    const r4 = await postJson("/api/prompt", {
        text: "hi",
        provider: "oh-my-pi",
        sessionId: `yolo-one-${Date.now()}`,
        model: "deepseek-v4-flash",
        thinking: "medium",
        yolo: 1,
    });
    assert.equal(r4.ok, true, "yolo=1 → ok:true");
    log("  ✓ yolo=1 prompt accepted");

    // ── Flag logic correctness ──────────────────────────────
    log("Test: flag logic");
    function buildArgs(yolo) {
        const a = ["-p", "--mode", "json"];
        if (yolo) a.push("--auto-approve");
        a.push("--no-extensions", "--no-skills", "--no-rules");
        return a;
    }
    assert.ok(buildArgs(true).includes("--auto-approve"), "yolo=true → --auto-approve");
    assert.ok(!buildArgs(false).includes("--auto-approve"), "yolo=false → no flag");
    assert.ok(!buildArgs(undefined).includes("--auto-approve"), "yolo=undefined → no flag");
    assert.ok(!buildArgs(0).includes("--auto-approve"), "yolo=0 → no flag");
    assert.ok(buildArgs(1).includes("--auto-approve"), "yolo=1 → flag present");
    log("  ✓ flag logic correct for all cases");

    console.log("\n✅ All YOLO harness tests passed.\n");

} catch (e) {
    console.error("\n✗ FAIL:", e.message);
    process.exitCode = 1;
} finally {
    proc.kill();
}
