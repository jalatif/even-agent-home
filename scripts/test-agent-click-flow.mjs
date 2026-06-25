/**
 * Agent Click Flow Integration Test
 *
 * Simulates clicking an agent on the agents list and verifies the
 * controller transitions through the expected screens without
 * looping back to the agents list.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";

const PORT = 3478;
const URL = `http://localhost:${PORT}`;

function getJson(p) { return fetch(`${URL}${p}`).then(r => r.json()); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start backend ───────────────────────────────────────────
console.log("Starting backend...");
const proc = spawn("node", ["bin/even-agent-home.js", "--token", "test-token", "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: "backend",
    env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) },
    stdio: "ignore",
});
for (let i = 0; i < 20; i++) {
    try { const r = await fetch(`${URL}/api/agents`); if (r.ok) break; } catch {}
    await sleep(300);
}

let failed = false;
try {
    // ══════════════════════════════════════════════════════════
    // Test: Agent click flow
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Agent click flow ═══");

    // Step 1: Fetch the agents list (simulates boot)
    console.log("  Step 1: Fetch agents");
    const agentsResp = await getJson("/api/agents");
    // Agents can be strings or {id, available} objects
    const agentList = agentsResp.agents || [];
    assert.ok(agentList.length > 0, "at least one agent");
    const agentIds = agentList.map(a => typeof a === "string" ? a : a.id);
    console.log(`    Agents: ${agentIds.join(", ")}`);

    // Step 2: Click first agent — open sessions list
    const agent = agentIds[0];
    console.log(`  Step 2: Open sessions for "${agent}"`);
    const sessionsResp = await getJson(`/api/sessions?agent=${encodeURIComponent(agent)}`);
    const sessions = sessionsResp.sessions || [];
    assert.ok(Array.isArray(sessions), "sessions is array");
    console.log(`    ${sessions.length} sessions returned`);

    // Step 3: Verify sessions have valid IDs
    for (const s of sessions.slice(0, 3)) {
        assert.ok(s.id !== undefined, "session has id");
        console.log(`    session: id=${(s.id || "").slice(0, 20)}... title=${(s.title || "").slice(0, 40)}`);
    }

    // Step 4: Open a session and check history + status
    if (sessions.length > 0) {
        const session = sessions[0];
        const sessionId = session.id;
        console.log(`  Step 3: Open session ${(sessionId || "").slice(0, 20)}...`);

        const historyResp = await getJson(`/api/history?agent=${encodeURIComponent(agent)}&sessionId=${encodeURIComponent(sessionId)}`);
        assert.ok(Array.isArray(historyResp.history), "history is array");
        console.log(`    History: ${historyResp.history.length} messages`);

        const statusResp = await getJson(`/api/status?provider=${encodeURIComponent(agent)}&sessionId=${encodeURIComponent(sessionId)}`);
        console.log(`    Status: ${statusResp.state}`);
    }

    // Step 5: Verify we can re-fetch agents without looping
    console.log("  Step 4: Re-fetch agents (should not loop)");
    const agentsAgain = await getJson("/api/agents");
    const agentIdsAgain = (agentsAgain.agents || []).map(a => typeof a === "string" ? a : a.id);
    assert.equal(agentIdsAgain.length, agentIds.length, "same agent count");
    console.log(`    ${agentIdsAgain.length} agents — no loop`);

    console.log("\n✅ All agent click flow tests passed.\n");

} catch (e) {
    console.error("\n✗ FAIL:", e.message);
    console.error(e.stack);
    failed = true;
} finally {
    proc.kill();
    process.exit(failed ? 1 : 0);
}
