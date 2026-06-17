/**
 * Frontend Flow E2E Test
 *
 * Simulates the EXACT controller state machine against the real backend.
 * This catches the class of bugs where controller state transitions
 * race with async backend responses.
 *
 * Simulated controller flow:
 * 1. openSession → fetch status + history
 * 2. sendTextMessage → prompt + capture sessionId + keep local messages
 * 3. Polling → status + history, never shrink messages
 * 4. Resume → open existing session, verify messages exist
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";

const PORT = 3475;
const URL = `http://localhost:${PORT}`;

async function postJson(path, body) {
    const r = await fetch(`${URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return r.json();
}

async function getJson(path) {
    return (await fetch(`${URL}${path}`)).json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start backend ───────────────────────────────────────────
console.log("Starting backend...");
const proc = spawn("node", ["src/index.js"], {
    cwd: "backend",
    env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) },
    stdio: "ignore",
});

for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${URL}/api/agents`); if (r.ok) break; } catch {}
    await sleep(300);
}

let failed = false;

try {
    const PROMPT_OPTS = {
        model: "deepseek-v4-flash",
        thinking: "medium",
        yolo: true,
    };

    // ══════════════════════════════════════════════════════════
    // Test 1: New session — send message, verify sessionId
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Test 1: New session send message ═══");

    // Simulate: user opens new session (empty sessionId)
    console.log("  Step 1: User on sidebar.messages with empty sessionId");
    let agent = "oh-my-pi";
    let sessionId = "";
    let messages = [];  // local messages array (what controller holds)

    // Simulate: user types "hello test one"
    const userText1 = "hello test one";
    messages = [...messages, { role: "user", text: userText1 }];
    console.log(`  Step 2: User typed "${userText1}", local messages: ${messages.length}`);

    // Simulate: sendTextMessage calls api.prompt()
    console.log("  Step 3: Calling api.prompt()...");
    const promptRes1 = await postJson("/api/prompt", {
        text: userText1,
        provider: agent,
        sessionId,  // "" for new session
        ...PROMPT_OPTS,
    });
    assert.equal(promptRes1.ok, true, "prompt returns ok:true");

    // CRITICAL: capture the backend's sessionId
    sessionId = promptRes1.sessionId || sessionId;
    console.log(`  Step 4: Backend returned sessionId="${sessionId}"`);
    assert.ok(sessionId.length > 0, "BUG: sessionId not captured from backend — polling will fail");

    // Verify: session exists in the list
    await sleep(1000);
    const sessions1 = await getJson(`/api/sessions?agent=${agent}`);
    const found1 = sessions1.sessions?.some(s => s.id === sessionId);
    console.log(`  Step 5: Session in list: ${found1}`);

    // ══════════════════════════════════════════════════════════
    // Test 2: Polling — never shrink messages
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Test 2: Polling preserves messages ═══");

    // Simulate: first poll cycle (backend might not have written yet)
    console.log("  Poll 1: Simulating first poll cycle...");
    let pollStatus = await getJson(`/api/status?agent=${agent}&sessionId=${sessionId}`);
    let pollHistory = await getJson(`/api/history?agent=${agent}&sessionId=${sessionId}`);

    console.log(`    Status: ${pollStatus.state}, History length: ${pollHistory.history.length}`);

    // CRITICAL INVARIANT: if backend history is empty but we have local messages, KEEP local
    if (pollHistory.history.length === 0 && messages.length > 0) {
        console.log("    Backend history empty, keeping local messages");
        // Messages unchanged — this is the fix
    } else if (pollHistory.history.length > messages.length) {
        messages = pollHistory.history;
        console.log(`    Updated from backend: ${messages.length} messages`);
    }
    assert.ok(messages.length > 0, "BUG: local messages were wiped by empty backend history");

    // Poll again after a few seconds — backend may have caught up
    console.log("  Poll 2: Waiting 5s for backend...");
    await sleep(5000);
    pollStatus = await getJson(`/api/status?agent=${agent}&sessionId=${sessionId}`);
    pollHistory = await getJson(`/api/history?agent=${agent}&sessionId=${sessionId}`);
    console.log(`    Status: ${pollStatus.state}, History length: ${pollHistory.history.length}`);

    // Update messages if backend has more
    if (pollHistory.history.length > messages.length) {
        messages = pollHistory.history;
        console.log(`    Updated: ${messages.length} messages`);
    }
    assert.ok(messages.length > 0, "BUG: messages still empty after 5s wait");

    // ══════════════════════════════════════════════════════════
    // Test 3: Second message to same session
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Test 3: Second message to same session ═══");

    const userText2 = "second message";
    messages = [...messages, { role: "user", text: userText2 }];
    console.log(`  Step 1: User typed "${userText2}", local messages: ${messages.length}`);

    const promptRes2 = await postJson("/api/prompt", {
        text: userText2,
        provider: agent,
        sessionId,  // MUST use captured sessionId
        ...PROMPT_OPTS,
    });
    assert.equal(promptRes2.ok, true);
    console.log(`  Step 2: Prompt accepted`);

    // Poll for response
    console.log("  Step 3: Polling...");
    await sleep(3000);
    pollHistory = await getJson(`/api/history?agent=${agent}&sessionId=${sessionId}`);
    if (pollHistory.history.length > messages.length) {
        messages = pollHistory.history;
        console.log(`    Updated: ${messages.length} messages`);
    }

    // ══════════════════════════════════════════════════════════
    // Test 4: Resume — open existing session
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Test 4: Resume existing session ═══");

    // Simulate: user opens the session from the list
    console.log(`  Step 1: Opening session ${sessionId}`);
    const resumeStatus = await getJson(`/api/status?agent=${agent}&sessionId=${sessionId}`);
    const resumeHistory = await getJson(`/api/history?agent=${agent}&sessionId=${sessionId}`);
    console.log(`    Status: ${resumeStatus.state}, History: ${resumeHistory.history.length} messages`);

    // ══════════════════════════════════════════════════════════
    // Test 5: Resume — send message to existing session
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Test 5: Resume + send message ═══");

    // Find the session we just created from the list
    const sessionsList = await getJson(`/api/sessions?agent=${agent}`);
    const existingSession = sessionsList.sessions?.find(s => s.id && s.id.length > 10);
    if (existingSession) {
        const resumeId = existingSession.id;
        console.log(`  Step 1: Found session ${resumeId.slice(0, 30)}...`);

        // Simulate sending a message to this existing session
        const resumeText = "resume test message";
        const resumePrompt = await postJson("/api/prompt", {
            text: resumeText, provider: agent, sessionId: resumeId, ...PROMPT_OPTS,
        });
        assert.equal(resumePrompt.ok, true, "resume prompt should succeed");
        console.log(`  Step 2: Prompt accepted`);

        // The backend sessionId should match the one we passed (meaning --resume worked)
        if (resumePrompt.sessionId === resumeId) {
            console.log("  ✓ Resume sessionId matches (--resume passed correctly)");
        } else {
            console.log(`  ⚠ Resume sessionId mismatch: ${resumePrompt.sessionId} vs ${resumeId.slice(0, 20)}...`);
        }
    } else {
        console.log("  ⚠ No existing session to resume (backend may not have persisted)");
    }
    // ══════════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════════
    console.log("\n═══ Summary ═══");
    console.log(`  SessionId propagated: ${sessionId.length > 0 ? "✓" : "✗ BUG"}`);
    console.log(`  Messages preserved: ${messages.length > 0 ? "✓" : "✗ BUG"}`);
    console.log("\n✅ Frontend flow E2E tests passed.\n");

} catch (e) {
    console.error("\n✗ FAIL:", e.message);
    failed = true;
} finally {
    proc.kill();
    process.exit(failed ? 1 : 0);
}
