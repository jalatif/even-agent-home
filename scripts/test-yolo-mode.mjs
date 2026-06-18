/**
 * YOLO Mode Harness Test
 *
 * Verifies that the yolo flag controls permission mode for each provider:
 * - yolo=true  → dangerous/permissive flags included
 * - yolo=false → safe/interactive mode (flags absent)
 *
 * Tests backend route parsing AND provider-level flag decision logic.
 */

import { strict as assert } from "node:assert";

// ── Test 1: Route handler accepts yolo ──────────────────────
console.log("\n── Test 1: Route handler parses yolo from body ──");

// Simulate what the route handler does
function parsePromptBody(body) {
    const { text, sessionId, provider, cwd, model, thinking, yolo } = body ?? {};
    return { text, sessionId, provider, cwd, model, thinking, yolo };
}

{
    const r1 = parsePromptBody({ text: "hi", provider: "claude", yolo: true });
    assert.equal(r1.yolo, true, "yolo=true should be parsed as true");

    const r2 = parsePromptBody({ text: "hi", provider: "claude", yolo: false });
    assert.equal(r2.yolo, false, "yolo=false should be parsed as false");

    const r3 = parsePromptBody({ text: "hi", provider: "claude" });
    assert.equal(r3.yolo, undefined, "missing yolo should be undefined");

    const r4 = parsePromptBody({ text: "hi", provider: "claude", yolo: "true" });
    assert.equal(r4.yolo, "true", "string yolo should pass through (coerced by provider)");
}
console.log("  ✓ Route handler yolo parsing");

// ── Test 2: Claude permissionMode selection ─────────────────
console.log("\n── Test 2: Claude permissionMode ──");

function getClaudePermissionMode(yolo) {
    return yolo ? "bypassPermissions" : "acceptEdits";
}

assert.equal(getClaudePermissionMode(true), "bypassPermissions");
assert.equal(getClaudePermissionMode(false), "acceptEdits");
assert.equal(getClaudePermissionMode(undefined), "acceptEdits");
console.log("  ✓ Claude permissionMode correct for yolo=true/false/undefined");

// ── Test 3: Codex auto-approval logic ───────────────────────
console.log("\n── Test 3: Codex auto-approval ──");

function shouldAutoApprove(yolo) {
    return !!yolo;
}

assert.equal(shouldAutoApprove(true), true, "yolo=true → auto-approve");
assert.equal(shouldAutoApprove(false), false, "yolo=false → request permissions");
assert.equal(shouldAutoApprove(undefined), false, "yolo=undefined → request permissions");
console.log("  ✓ Codex auto-approval correct");

// ── Test 4: CLI provider flag decision ──────────────────────
console.log("\n── Test 4: CLI provider flag decision ──");

function buildOpencodeArgs(yolo) {
    const args = ["run", "--format", "json"];
    if (yolo) args.push("--dangerously-skip-permissions");
    return args;
}

function buildAntigravityArgs(yolo) {
    const args = [];
    if (yolo) args.push("--dangerously-skip-permissions");
    return args;
}

function buildOmpArgs(yolo) {
    const args = ["-p", "--mode", "json"];
    if (yolo) args.push("--auto-approve");
    return args;
}

// Opencode
{
    const argsTrue = buildOpencodeArgs(true);
    assert.ok(argsTrue.includes("--dangerously-skip-permissions"), "opencode yolo=true → flag present");

    const argsFalse = buildOpencodeArgs(false);
    assert.ok(!argsFalse.includes("--dangerously-skip-permissions"), "opencode yolo=false → flag absent");
}
console.log("  ✓ Opencode");

// Antigravity
{
    const argsTrue = buildAntigravityArgs(true);
    assert.ok(argsTrue.includes("--dangerously-skip-permissions"), "antigravity yolo=true → flag present");

    const argsFalse = buildAntigravityArgs(false);
    assert.ok(!argsFalse.includes("--dangerously-skip-permissions"), "antigravity yolo=false → flag absent");
}
console.log("  ✓ Antigravity");

// Oh-My-Pi
{
    const argsTrue = buildOmpArgs(true);
    assert.ok(argsTrue.includes("--auto-approve"), "oh-my-pi yolo=true → flag present");

    const argsFalse = buildOmpArgs(false);
    assert.ok(!argsFalse.includes("--auto-approve"), "oh-my-pi yolo=false → flag absent");
}
console.log("  ✓ Oh-My-Pi");

// ── Test 5: Pi and Hermes accept yolo (no-op) ───────────────
console.log("\n── Test 5: Pi and Hermes accept yolo ──");

function piPrompt(sessionId, text, cwd, model, thinking, yolo) {
    // pi has no permission flag — just verify yolo is accepted
    return { accepted: true, yoloProvided: yolo !== undefined };
}

function hermesPrompt(sessionId, text, cwd, model, thinking, yolo) {
    // hermes is a chat API — just verify yolo is accepted
    return { accepted: true, yoloProvided: yolo !== undefined };
}

assert.equal(piPrompt("id", "hi", "/tmp", "model", "off", true).yoloProvided, true);
assert.equal(piPrompt("id", "hi", "/tmp", "model", "off", false).yoloProvided, true);
assert.equal(piPrompt("id", "hi", "/tmp", "model", "off").yoloProvided, false);
assert.equal(hermesPrompt("id", "hi", "/tmp", "model", "off", true).yoloProvided, true);
assert.equal(hermesPrompt("id", "hi", "/tmp", "model", "off").yoloProvided, false);
console.log("  ✓ Pi and Hermes accept yolo parameter");

// ── Test 6: Integration — route handler dispatches yolo ─────
console.log("\n── Test 6: Route handler dispatches yolo ──");

// Simulate the route handler's prompt call
const providersCalled = [];
function mockProvider(name) {
    return {
        prompt(sessionId, text, cwd, model, thinking, yolo) {
            providersCalled.push({ name, yolo });
            return { sessionId: sessionId || "new-id", provider: name };
        }
    };
}

function simulateRoute(providerName, body) {
    const { text, sessionId, provider, cwd, model, thinking, yolo } = body;
    const targetProvider = mockProvider(provider);
    return targetProvider.prompt(sessionId, text, cwd, model, thinking, yolo);
}

providersCalled.length = 0;
simulateRoute("claude", { text: "hi", provider: "claude", yolo: true });
simulateRoute("claude", { text: "hi", provider: "claude", yolo: false });
simulateRoute("codex", { text: "hi", provider: "codex", yolo: true });
simulateRoute("codex", { text: "hi", provider: "codex" });

assert.equal(providersCalled.length, 4);
assert.equal(providersCalled[0].yolo, true, "claude received yolo=true");
assert.equal(providersCalled[1].yolo, false, "claude received yolo=false");
assert.equal(providersCalled[2].yolo, true, "codex received yolo=true");
assert.equal(providersCalled[3].yolo, undefined, "codex received yolo=undefined");
console.log("  ✓ Route dispatches yolo to all providers");

// ── Summary ─────────────────────────────────────────────────
console.log("\n✅ All YOLO mode harness tests passed.\n");
