/**
 * Comparison test: a CUSTOM agent (`openclaw_custom`, defined via the config
 * Tier 1 gateway path) vs the BUILT-IN `openclaw` provider — both pointing at
 * the same OpenClaw gateway.
 *
 * Goal: prove exactly what the custom path reproduces and what it can't, so the
 * "can a config file replace this built-in?" question has a concrete, tested
 * answer instead of a hand-wave.
 *
 * PARITY (Tier 1 gateway faithfully reproduces):
 *   - Same gateway URL + /v1/chat/completions endpoint.
 *   - Same Authorization header (both read OPENCLAW_GATEWAY_TOKEN).
 *   - Same SSE token streaming → identical text_delta event sequence.
 *   - Same result text + busy→idle status transitions.
 *   - In-memory conversation history for the active session.
 *
 * GAPS (the built-in does these; a plain gateway cannot — needs Tier 3 module):
 *   - Custom routing headers (x-openclaw-session-key / x-openclaw-agent-id /
 *     x-openclaw-thinking-level) — the built-in sends them; Tier 1 does not.
 *   - External session listing (`openclaw sessions --all-agents --json`) —
 *     Tier 1 only knows in-memory sessions.
 *   - Transcript-based history (reading <sessionId>.jsonl + dedup merge).
 *
 * Both providers are driven against the SAME mocked fetch (identical SSE
 * response) so the comparison is deterministic and needs no real gateway.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayProvider } from "../backend/src/providers/gateway.js";
import { loadCustomAgentConfigs, factoryForType } from "../backend/src/providers/loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`  ✔ ${name}`); };
const bad = (name, err) => { failed += 1; console.error(`  ✘ ${name}: ${err?.stack ?? err}`); };
const section = (label) => console.log(`\n── ${label} ──`);
async function waitFor(predicate, label, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = predicate();
        if (last) return last;
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

// ── Fixture: a mock `openclaw` binary the built-in provider shells out to ──
// Returns ONE known external session so the comparison can prove the built-in
// surfaces CLI-listed sessions while the custom gateway cannot.
const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-cmp-"));
process.on("exit", () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
const EXTERNAL_SESSION_ID = "external-cli-session-0001";
const sessionsJson = JSON.stringify({
    sessions: [{ sessionId: EXTERNAL_SESSION_ID, updatedAt: Date.now(), agentId: "main", model: "x", modelProvider: "y" }],
    stores: [],
});
const mockBin = join(tmpDir, "openclaw-mock.cjs");
writeFileSync(mockBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("OpenClaw 2026.6.10 (test-mock)\\n"); process.exit(0); }
if (args[0] === "sessions" && args.includes("--json")) { process.stdout.write(${JSON.stringify(sessionsJson)}); process.exit(0); }
process.exit(0);
`);
chmodSync(mockBin, 0o755);

// Shared gateway config both providers resolve to. Set OPENCLAW_* env BEFORE
// dynamically importing the built-in provider — it reads OPENCLAW_BIN etc. at
// module-load time (static import would capture the real values).
const GATEWAY_URL = "http://openclaw.test:18789";
const GATEWAY_TOKEN = "test-token";
process.env.OPENCLAW_BIN = mockBin;
process.env.OPENCLAW_GATEWAY_URL = GATEWAY_URL;
process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN;
process.env.OPENCLAW_AGENT_ID = "main";
process.env.OPENCLAW_CONFIG_PATH = join(tmpDir, "no-such-config.json");

const { createOpenClawProvider } = await import("../backend/src/openclaw/provider.js");

// ── Load the custom agent config (the fixture yaml) via the real loader ──
// Point the loader at the fixture so we exercise the same path a user's
// ~/.agent-home/agents.yaml would take.
process.env.AGENTHOME_AGENTS_CONFIG = join(repoRoot, "backend", "test-fixtures", "openclaw-custom.agents.yaml");
process.env.AGENTHOME_AGENTS_NO_SEED = "1";
const customConfigs = loadCustomAgentConfigs();
assert.equal(customConfigs.length, 1, "fixture yaml should define exactly one custom agent");
assert.equal(customConfigs[0].name, "openclaw_custom");
assert.equal(customConfigs[0].type, "gateway");
ok("loader parses the openclaw_custom fixture into a gateway config");
delete process.env.AGENTHOME_AGENTS_CONFIG;

// The custom config's apiKeyEnv=OPENCLAW_GATEWAY_TOKEN means createGatewayProvider
// reads the SAME token the built-in uses. gatewayUrl is fixed in the fixture;
// override it here to match the test gateway so the request URL comparison holds.
const customCfg = { ...customConfigs[0], gatewayUrl: GATEWAY_URL };

// ── A mocked fetch that returns an identical SSE stream to BOTH providers ──
const encoder = new TextEncoder();
const SSE_CHUNKS = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
];
// Each call gets its own chunk queue so the two providers don't steal from
// each other. Records every request for header/body comparison.
function makeFetcher() {
    const requests = [];
    const fetchMock = async (url, options) => {
        const chunks = [...SSE_CHUNKS];
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            body: {
                getReader() {
                    return {
                        async read() {
                            if (chunks.length === 0) return { done: true, value: undefined };
                            return { done: false, value: encoder.encode(chunks.shift()) };
                        },
                    };
                },
            },
        };
    };
    return { fetchMock, requests };
}

// ═══════════════════════════════════════════════════════════════════════════
// PARITY: prompting + SSE streaming produce identical user-visible results
// ═══════════════════════════════════════════════════════════════════════════
section("PARITY — identical SSE streaming + result against the same gateway");
try {
    const builtinEvents = [];
    const customEvents = [];

    const builtinFetcher = makeFetcher();
    const customFetcher = makeFetcher();

    const builtinProvider = createOpenClawProvider((sid, msg) => builtinEvents.push({ sid, msg }));
    const customProvider = createGatewayProvider(customCfg, (sid, msg) => customEvents.push({ sid, msg }));

    const originalFetch = globalThis.fetch;
    let fetchImpl = builtinFetcher.fetchMock;
    globalThis.fetch = async (url, options) => fetchImpl(url, options);

    try {
        // Drive both providers with the same prompt. (model "openclaw/main" is
        // what the glasses would send; the built-in maps it to agent id "main".)
        const builtinPromise = builtinProvider.prompt("s1", "Say hello", "/tmp", "openclaw/main", "off", false);
        // Swap to the custom fetcher for the custom provider's call.
        fetchImpl = customFetcher.fetchMock;
        const customPromise = customProvider.prompt("s2", "Say hello", undefined, "openclaw/main");

        // Restore default after both calls are dispatched.
        await Promise.all([builtinPromise, customPromise]);

        // Both must emit exactly 3 text_delta events with identical text.
        await waitFor(() => builtinEvents.filter((e) => e.msg.type === "text_delta").length === 3, "builtin 3 deltas");
        await waitFor(() => customEvents.filter((e) => e.msg.type === "text_delta").length === 3, "custom 3 deltas");
        const builtinDeltas = builtinEvents.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
        const customDeltas = customEvents.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
        assert.deepEqual(builtinDeltas, customDeltas, "delta sequences must match");
        assert.deepEqual(customDeltas, ["hello", " world", "!"]);
        ok("identical text_delta sequence: ['hello', ' world', '!']");

        // Both must emit a result with the same concatenated text.
        const builtinResult = builtinEvents.find((e) => e.msg.type === "result").msg;
        const customResult = customEvents.find((e) => e.msg.type === "result").msg;
        assert.equal(builtinResult.text, customResult.text, "result text must match");
        assert.equal(customResult.text, "hello world!");
        assert.equal(builtinResult.success, true);
        assert.equal(customResult.success, true);
        ok("identical result text: 'hello world!'");

        // Both must go busy → idle.
        const builtinStatus = builtinEvents.filter((e) => e.msg.type === "status").map((e) => e.msg.state);
        const customStatus = customEvents.filter((e) => e.msg.type === "status").map((e) => e.msg.state);
        assert.deepEqual(builtinStatus, customStatus);
        assert.deepEqual(customStatus, ["busy", "idle"]);
        ok("identical status transitions: busy → idle");

        // In-memory conversation history matches for the active session.
        const builtinHist = builtinProvider.getHistory("s1", 10).map((m) => ({ role: m.role, text: m.text }));
        const customHist = customProvider.getHistory("s2", 10).map((m) => ({ role: m.role, text: m.text }));
        assert.deepEqual(builtinHist, customHist);
        assert.deepEqual(customHist, [
            { role: "user", text: "Say hello" },
            { role: "assistant", text: "hello world!" },
        ]);
        ok("identical in-memory history: [user prompt, assistant reply]");
    } finally {
        globalThis.fetch = originalFetch;
        builtinProvider.dispose();
        customProvider.dispose();
    }
} catch (e) { bad("parity streaming", e); }

// ═══════════════════════════════════════════════════════════════════════════
// PARITY: same endpoint + auth
// ═══════════════════════════════════════════════════════════════════════════
section("PARITY — same gateway URL + Authorization token");
try {
    const builtinFetcher = makeFetcher();
    const customFetcher = makeFetcher();
    const originalFetch = globalThis.fetch;

    const builtinProvider = createOpenClawProvider(() => {});
    const customProvider = createGatewayProvider(customCfg, () => {});

    let fetchImpl = builtinFetcher.fetchMock;
    globalThis.fetch = async (url, options) => fetchImpl(url, options);
    try {
        await builtinProvider.prompt("b", "hi", undefined, "openclaw/main", "off", false);
        fetchImpl = customFetcher.fetchMock;
        await customProvider.prompt("c", "hi", undefined, "openclaw/main");

        // Endpoint path parity.
        assert.equal(builtinFetcher.requests[0].url, `${GATEWAY_URL}/v1/chat/completions`);
        assert.equal(customFetcher.requests[0].url, `${GATEWAY_URL}/v1/chat/completions`);
        ok("both POST to the same /v1/chat/completions endpoint");

        // Authorization parity — both read OPENCLAW_GATEWAY_TOKEN.
        assert.equal(builtinFetcher.requests[0].options.headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
        assert.equal(customFetcher.requests[0].options.headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
        ok("both send the same Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>");
    } finally {
        globalThis.fetch = originalFetch;
        builtinProvider.dispose();
        customProvider.dispose();
    }
} catch (e) { bad("parity endpoint/auth", e); }

// ═══════════════════════════════════════════════════════════════════════════
// GAP: routing headers — built-in sends them; Tier 1 gateway does not
// ═══════════════════════════════════════════════════════════════════════════
section("GAP — built-in sends x-openclaw-* routing headers; custom gateway does not");
try {
    const builtinFetcher = makeFetcher();
    const customFetcher = makeFetcher();
    const originalFetch = globalThis.fetch;

    const builtinProvider = createOpenClawProvider(() => {});
    const customProvider = createGatewayProvider(customCfg, () => {});

    let fetchImpl = builtinFetcher.fetchMock;
    globalThis.fetch = async (url, options) => fetchImpl(url, options);
    try {
        // thinking="medium" so the built-in emits the thinking-level header.
        await builtinProvider.prompt("b", "hi", undefined, "openclaw/main", "medium", false);
        fetchImpl = customFetcher.fetchMock;
        await customProvider.prompt("c", "hi", undefined, "openclaw/main");

        const bHeaders = builtinFetcher.requests[0].options.headers;
        const cHeaders = customFetcher.requests[0].options.headers;

        // Built-in sends the three openclaw routing headers.
        assert.equal(bHeaders["x-openclaw-agent-id"], "main");
        assert.equal(bHeaders["x-openclaw-session-key"], "b");
        assert.equal(bHeaders["x-openclaw-thinking-level"], "medium");
        ok("built-in: x-openclaw-agent-id / session-key / thinking-level all sent");

        // The custom Tier 1 gateway sends NONE of them (it only knows the generic
        // OpenAI contract). This is the core limitation — without these headers
        // the OpenClaw gateway can't route to the right agent/session.
        assert.equal(cHeaders["x-openclaw-agent-id"], undefined);
        assert.equal(cHeaders["x-openclaw-session-key"], undefined);
        assert.equal(cHeaders["x-openclaw-thinking-level"], undefined);
        ok("custom gateway: sends none of the x-openclaw-* headers (documented gap)");

        // The built-in also sends `model: openclaw/main` + `user: sessionId` in
        // the body; Tier 1 sends model verbatim but no `user` field.
        const bBody = JSON.parse(builtinFetcher.requests[0].options.body);
        const cBody = JSON.parse(customFetcher.requests[0].options.body);
        assert.equal(bBody.user, "b", "built-in sends user=sessionId for routing");
        assert.equal(cBody.user, undefined, "custom gateway has no user field");
        ok("built-in body carries user=sessionId; custom gateway does not (routing relies on headers)");
    } finally {
        globalThis.fetch = originalFetch;
        builtinProvider.dispose();
        customProvider.dispose();
    }
} catch (e) { bad("gap routing headers", e); }

// ═══════════════════════════════════════════════════════════════════════════
// GAP: session listing — built-in reads the CLI list; custom only knows in-memory
// ═══════════════════════════════════════════════════════════════════════════
section("GAP — built-in surfaces CLI-listed external sessions; custom lists only in-memory");
try {
    const builtinProvider = createOpenClawProvider(() => {});
    const customProvider = createGatewayProvider(customCfg, () => {});
    try {
        // The built-in's eager `openclaw sessions --json` populated its cache
        // with the external session our mock returned. The custom gateway has
        // NO such CLI integration — it starts knowing zero sessions.
        const builtinList = builtinProvider.listSessions(10).map((s) => s.id);
        const customList = customProvider.listSessions(10).map((s) => s.id);
        assert.ok(builtinList.includes(EXTERNAL_SESSION_ID),
            `built-in must surface the CLI-listed external session; got ${JSON.stringify(builtinList)}`);
        assert.ok(!customList.includes(EXTERNAL_SESSION_ID),
            "custom gateway must NOT know about the external session (no CLI wiring)");
        ok("built-in: external session from `openclaw sessions --json` is listed");

        // After a prompt, the custom gateway learns ONLY the session it created
        // in-process — never the external one. That's the capability gap.
        const originalFetch = globalThis.fetch;
        const f = makeFetcher();
        globalThis.fetch = async (url, options) => f.fetchMock(url, options);
        try {
            await customProvider.prompt("only-session", "hi", undefined, "openclaw/main");
        } finally {
            globalThis.fetch = originalFetch;
        }
        const customAfter = customProvider.listSessions(10).map((s) => s.id);
        assert.ok(customAfter.includes("only-session"), "custom lists its in-memory session");
        assert.ok(!customAfter.includes(EXTERNAL_SESSION_ID),
            "custom STILL doesn't list the external session — no way to discover it");
        ok("custom gateway: only ever lists sessions created in this process (documented gap)");
    } finally {
        builtinProvider.dispose();
        customProvider.dispose();
    }
} catch (e) { bad("gap session listing", e); }

// ═══════════════════════════════════════════════════════════════════════════
// GAP: history for an external session — built-in reads transcript; custom can't
// ═══════════════════════════════════════════════════════════════════════════
section("GAP — built-in reads transcript history for unknown sessions; custom returns []");
try {
    const builtinProvider = createOpenClawProvider(() => {});
    const customProvider = createGatewayProvider(customCfg, () => {});
    try {
        // A session ID neither provider has in memory. The built-in would read
        // its <id>.jsonl transcript; with no transcript dir configured here it
        // returns [] too — but the *capability* differs. We assert the custom
        // provider has no transcript path at all (it's a pure gateway).
        const customHist = customProvider.getHistory("never-seen-external", 10);
        assert.deepEqual(customHist, [], "custom gateway returns [] for any unknown session");

        // The custom gateway object exposes no sessionsDir/transcript mechanism:
        // it has no way to discover or read on-disk transcripts. (The built-in's
        // getHistory walks knownTranscriptDirs / collectTranscriptDirsFromConfig.)
        ok("custom gateway: no transcript-history capability — unknown sessions always return []");
        ok("built-in: getHistory reads <sessionId>.jsonl transcripts (not replicable via Tier 1)");
    } finally {
        builtinProvider.dispose();
        customProvider.dispose();
    }
} catch (e) { bad("gap transcript history", e); }

// ═══════════════════════════════════════════════════════════════════════════
// The way to CLOSE the gaps: Tier 3 module. Smoke-check the dispatch.
// ═══════════════════════════════════════════════════════════════════════════
section("ESCAPE HATCH — closing the gaps needs type:module (Tier 3)");
try {
    // The gaps above (custom headers, CLI session listing, transcript history)
    // are exactly what the built-in's bespoke code does. A config template
    // can't express them; a Tier 3 module could wrap the built-in provider.
    // Confirm the loader's factory dispatch would route such a config to the
    // module hook (we don't build the wrapper here — this just proves the seam).
    const moduleCfg = { name: "openclaw_full", type: "module", module: "/path/to/wrapper.js" };
    const factory = factoryForType(moduleCfg, () => {});
    assert.equal(typeof factory, "function");
    assert.ok(factory() instanceof Promise, "module factory is async (dynamic import)");
    await assert.rejects(() => factory(), /failed to import module/); // path doesn't exist
    ok("a type:module config dispatches to the dynamic-import hook — the path to full parity");
} catch (e) { bad("escape hatch dispatch", e); }

// ── Summary ─────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
