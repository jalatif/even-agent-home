/**
 * Controller State Machine Invariants Test (LEGACY REPLICA)
 *
 * ⚠️ DEPRECATION NOTICE: This suite re-implements the controller's poll/update
 * logic inline and tests the COPY, not the real `AgentHomeController`. It gives
 * false confidence — it passes even if the real controller is broken, and
 * silently drifts when the real logic changes.
 *
 * The AUTHORITATIVE coverage lives in `web/test/controller.test.ts`, which
 * imports the real `AgentHomeController` class and drives it through
 * `pollTick()`. The scenarios below (user-message-survives-send, reply-landing,
 * history-shrink) are covered there by:
 *   - "polling lands the reply when the turn ends even if backend history
 *      momentarily lags local"
 *   - "polling replaces a stuck 'Thinking...' placeholder when the turn ends"
 *
 * This file is kept for historical reference but should not be relied on as a
 * regression guard. Prefer adding cases to controller.test.ts.
 */

import { strict as assert } from "node:assert";

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}: ${e.message}`);
    }
}

// ── Invariant 1: After sendTextMessage, user message persists ─
console.log("\n── Invariant 1: User message survives send ──");

{
    // Simulate what the controller DOES (fixed version):
    // 1. Add user message locally
    // 2. Call API
    // 3. Stay on messages screen with local messages + isThinking

    let screen = "sidebar.messages";
    let messages = [{ role: "user", text: "previous" }];
    let isThinking = false;

    // User types "hello"
    const newText = "hello";
    messages = [...messages, { role: "user", text: newText }];
    screen = "sidebarSending";

    // API call happens (simulated — just returns)
    screen = "sidebar.messages";
    isThinking = true;
    // KEY: we keep local messages, not re-fetch

    test("messages count is 2 after send", () => {
        assert.equal(messages.length, 2);
    });
    test("last message is the user's", () => {
        assert.equal(messages[1].text, "hello");
    });
    test("screen is sidebar.messages", () => {
        assert.equal(screen, "sidebar.messages");
    });
    test("isThinking is true", () => {
        assert.equal(isThinking, true);
    });
}

// ── Invariant 1b: Backend sessionId must be captured ─────────
console.log("\n── Invariant 1b: Backend sessionId captured ──");

{
    let sessionId = "";  // empty for new session
    const messages = [{ role: "user", text: "hello" }];

    // Backend returns a real sessionId
    const apiResponse = { sessionId: "omp-real-id-456" };

    // BUG: ignoring apiResponse.sessionId → polling polls "" → backend 404s
    // FIX:
    sessionId = apiResponse.sessionId || sessionId;

    test("new session captures backend sessionId", () => {
        assert.equal(sessionId, "omp-real-id-456");
    });
    test("sessionId is non-empty for polling target", () => {
        assert.ok(sessionId.length > 0);
    });
}

// ── Invariant 2: Polling never shrinks messages ──────────────
console.log("\n── Invariant 2: Polling never shrinks messages ──");

{
    let stateMessages = [{ role: "user", text: "hello" }];
    let isThinking = true;

    // Polling fires, backend returns empty history
    const pollMessages = [];
    const pollStatus = "idle";

    // KEY: if backend has fewer messages than we have locally, keep local
    if (pollMessages.length === 0 && stateMessages.length > 0) {
        // Keep local messages, just update thinking state
        isThinking = pollStatus === "busy";
        // Messages unchanged
    }

    test("local messages preserved when backend empty", () => {
        assert.equal(stateMessages.length, 1);
        assert.equal(stateMessages[0].text, "hello");
    });

    // Now backend catches up
    const catchUpMessages = [
        { role: "user", text: "hello" },
        { role: "assistant", text: "response" },
    ];

    if (catchUpMessages.length >= stateMessages.length) {
        stateMessages = catchUpMessages;
    }

    test("messages grow when backend catches up", () => {
        assert.equal(stateMessages.length, 2);
        assert.equal(stateMessages[1].text, "response");
    });
}

// ── Invariant 3: openSession must not wipe existing messages ─
console.log("\n── Invariant 3: openSession preserves existing messages ──");

{
    // BUG SCENARIO: openSession wipes messages after send
    // This simulates the bug: user sends message, openSession fetches empty history

    let messages = [{ role: "user", text: "hello" }];
    let screen = "sidebarSending";

    // BAD: calling openSession after send (old behavior)
    function oldOpenSession() {
        screen = "loading";
        // Fetch history from backend — returns empty
        const backendHistory = [];
        messages = backendHistory; // BUG: overwrites local messages!
        screen = "sidebar.messages";
    }

    function newOpenSession(existingMessages) {
        screen = "loading";
        const backendHistory = [];
        // FIX: merge instead of replace
        // Only use backend if it has MORE messages
        if (backendHistory.length >= existingMessages.length) {
            messages = backendHistory;
        }
        // else keep existingMessages
        screen = "sidebar.messages";
    }

    // Test old behavior (BUG)
    let oldMessages = [...messages];
    oldOpenSession();
    test("BUG: old openSession wipes messages", () => {
        assert.equal(messages.length, 0, "old behavior wiped messages (known bug, now fixed)");
    });

    // Test new behavior (FIX)
    messages = [{ role: "user", text: "hello" }];
    newOpenSession(messages);
    test("FIX: new openSession preserves messages", () => {
        assert.equal(messages.length, 1);
    });
}

// ── Invariant 4: Screen transitions are valid ────────────────
console.log("\n── Invariant 4: Valid screen transitions ──");

{
    const validTransitions = {
        "loading": ["sidebar.agents", "asleep"],
        "sidebar.agents": ["sidebar.sessions", "asleep", "loading"],
        "sidebar.sessions": ["sidebar.messages", "sidebar.agents", "loading"],
        "sidebar.messages": ["sidebarSending", "sidebar.sessions", "sidebarRecording", "sidebarConfirm"],
        "sidebarSending": ["sidebar.messages"], // Should NEVER go to loading after send
        "sidebarRecording": ["sidebarTranscribing"],
        "sidebarTranscribing": ["sidebarConfirm", "sidebar.messages"],
        "sidebarConfirm": ["sidebarSending", "sidebar.messages"],
    };

    test("sidebarSending → sidebar.messages is valid (NOT loading)", () => {
        assert.ok(validTransitions["sidebarSending"].includes("sidebar.messages"));
        assert.ok(!validTransitions["sidebarSending"].includes("loading"),
            "sidebarSending should never transition to loading — that would trigger openSession");
    });

    test("sidebar.messages → sidebarSending is valid", () => {
        assert.ok(validTransitions["sidebar.messages"].includes("sidebarSending"));
    });
}

// ── Invariant 5: YOLO passes through to API ──────────────────
console.log("\n── Invariant 5: YOLO flag is forwarded ──");

{
    // Simulate config → API call
    const configs = {
        "oh-my-pi": { enabled: true, model: "m1", thinking: "medium", yolo: true },
        "claude": { enabled: true, model: "m2", thinking: "off", yolo: false },
        "codex": { enabled: true, model: "m3" }, // no yolo field
    };

    function buildPromptCall(agent, configs) {
        const config = configs[agent];
        return {
            agent, model: config?.model, thinking: config?.thinking, yolo: config?.yolo
        };
    }

    test("yolo=true reaches API", () => {
        const call = buildPromptCall("oh-my-pi", configs);
        assert.equal(call.yolo, true);
    });

    test("yolo=false reaches API", () => {
        const call = buildPromptCall("claude", configs);
        assert.equal(call.yolo, false);
    });

    test("missing yolo → undefined (safe default)", () => {
        const call = buildPromptCall("codex", configs);
        assert.equal(call.yolo, undefined);
    });
}

// ── Invariant 6: Message dedup in polling ────────────────────
console.log("\n── Invariant 6: Message dedup in polling ──");

{
    let messages = [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
    ];

    // Polling returns same messages (no change)
    const pollResult = [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
    ];

    // Dedup: don't update if content unchanged and length unchanged
    const lastOld = messages[messages.length - 1];
    const lastNew = pollResult[pollResult.length - 1];
    const textChanged = lastOld?.text !== lastNew?.text;
    const lengthChanged = messages.length !== pollResult.length;

    test("no update when messages unchanged", () => {
        assert.equal(textChanged, false);
        assert.equal(lengthChanged, false);
    });

    // Polling returns new message
    const pollWithNew = [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
        { role: "assistant", text: "also this" },
    ];

    const tc2 = messages[messages.length - 1]?.text !== pollWithNew[pollWithNew.length - 1]?.text;
    const lc2 = messages.length !== pollWithNew.length;

    test("update when new message arrives", () => {
        assert.equal(tc2, true);
        assert.equal(lc2, true);
    });
}

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
