/**
 * OpenClaw provider test harness.
 *
 * Mirrors the hermes test surface (unit-level with mocked fetch + mocked
 * `openclaw` binary) and covers:
 *   1. Config resolution: env-var precedence, file fallback, the loopback
 *      bind-mode bug fix (gateway.bind="loopback" → 127.0.0.1).
 *   2. Eager initial session-list sync at provider construction.
 *   3. Streaming SSE prompt path (text_delta, history capture, status).
 *   4. thinking=off omits the thinking-level header.
 *   5. Non-streaming fallback (no body.getReader) — single text_delta.
 *   6. Error paths: 404 carries the actionable chat-completions-enable hint,
 *      500 surfaces status code without the hint.
 *   7. listSessions: merges in-memory + cache, sorted newest first.
 *   8. getHistory during an active turn includes the partial response.
 *   9. interrupt mid-stream flips status to idle and aborts the fetch.
 *  10. dispose: clears the refresh timer and aborts in-flight sessions.
 *  11. Public surface matches the hermes provider contract.
 *  12. Concurrent prompt on a busy session is rejected with 409.
 *
 * Runs without a real OpenClaw install by pointing OPENCLAW_BIN at a tiny
 * Node stub. To exercise against the real binary, unset OPENCLAW_BIN.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const providerPath = join(repoRoot, "backend", "src", "openclaw", "provider.js");

// ── Test isolation ──────────────────────────────────────────
const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
process.on("exit", () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

let sessionsFixture = JSON.stringify({
    sessions: [
        {
            key: "agent:main:tui-aaaa",
            updatedAt: 1782277937263,
            sessionId: "85f66c1c-7703-45b5-9c0c-57eddc2405ca",
            abortedLastRun: false,
            model: "deepseek-v4-flash",
            modelProvider: "deepseek",
            agentId: "main",
        },
        {
            key: "agent:main:main",
            updatedAt: 1782277865710,
            sessionId: "ef585ca3-957a-4fe9-a463-f8d72b54ba9e",
            abortedLastRun: true,
            model: "deepseek-v4-flash",
            modelProvider: "deepseek",
            agentId: "main",
        },
    ],
});
const fixturePath = join(tmpDir, "sessions.json");
writeFileSync(fixturePath, sessionsFixture);

// Pre-create transcript .jsonl files for two of the fixture sessions so the
// title-enrichment path is exercised. The mock returns a `stores[].path`
// pointing at this directory.
const transcriptsDir = join(tmpDir, "transcripts");
mkdirSync(transcriptsDir, { recursive: true });
writeFileSync(join(transcriptsDir, "85f66c1c-7703-45b5-9c0c-57eddc2405ca.jsonl"),
    '{"type":"session","version":3,"id":"85f66c1c-7703-45b5-9c0c-57eddc2405ca","timestamp":"2026-06-23T20:00:00.000Z"}\n' +
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-23T20:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Build me a CLI todo app in Rust"}],"timestamp":1782277937263}}\n' +
    '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-23T20:00:30.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me plan the crate structure first."},{"type":"text","text":"Sure, here\\u0027s a starting point..."}]}}\n' +
    '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-06-23T20:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Now add tests please"}]}}\n'
);
writeFileSync(join(transcriptsDir, "ef585ca3-957a-4fe9-a463-f8d72b54ba9e.jsonl"),
    '{"type":"session","version":3,"id":"ef585ca3-957a-4fe9-a463-f8d72b54ba9e","timestamp":"2026-06-23T19:00:00.000Z"}\n' +
    '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-23T19:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Wake up, my friend!"}]}}\n'
);
const storePath = join(transcriptsDir, "sessions.json");

// Wrapper around the bare session list so the response includes a
// `stores[].path` entry pointing at our pre-created transcripts directory.
// The provider reads this to locate per-session .jsonl transcripts.
const sessionsJsonWithStores = JSON.stringify({
    path: null,
    stores: [{ agentId: "main", path: storePath }],
    allAgents: true,
    count: 2,
    totalCount: 2,
    limitApplied: 50,
    hasMore: false,
    activeMinutes: null,
    sessions: JSON.parse(sessionsFixture).sessions,
});

const mockBin = join(tmpDir, "openclaw-mock.cjs");
writeFileSync(mockBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("OpenClaw 2026.6.10 (test-mock)\\n"); process.exit(0); }
if (args[0] === "sessions" && args.includes("--json")) {
    const storesFixture = process.env.OPENCLAW_SESSIONS_STORES_FIXTURE;
    if (storesFixture) { try { process.stdout.write(fs.readFileSync(storesFixture, "utf8")); } catch (e) { process.stderr.write("mock-err: " + e.message + "\\n"); } }
    process.exit(0);
}
process.exit(0);
`);
chmodSync(mockBin, 0o755);
writeFileSync(join(tmpDir, "sessions-with-stores.json"), sessionsJsonWithStores);
sessionsFixture = sessionsJsonWithStores;

let passed = 0;
let failed = 0;
const ok = (name) => { passed++; console.log(`  ✔ ${name}`); };
const bad = (name, err) => { failed++; console.error(`  ✘ ${name}: ${err?.stack ?? err}`); };
const section = (label) => console.log(`\n── ${label} ──`);
async function waitFor(predicate, label, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
        lastValue = predicate();
        if (lastValue) return lastValue;
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

// ── Set env BEFORE loading the provider so the eager initial sync sees them ──
const baseEnv = {
    OPENCLAW_BIN: mockBin,
    OPENCLAW_SESSIONS_FIXTURE: fixturePath,
    OPENCLAW_SESSIONS_STORES_FIXTURE: join(tmpDir, "sessions-with-stores.json"),
    OPENCLAW_GATEWAY_URL: "http://openclaw.test:18789",
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    OPENCLAW_AGENT_ID: "main",
    OPENCLAW_CONFIG_PATH: join(tmpDir, "no-such-config.json"),
};
for (const [k, v] of Object.entries(baseEnv)) process.env[k] = v;

// Load the provider once. Cache-bust only when we need a fresh module state
// (e.g. testing different OPENCLAW_CONFIG_PATH bindings).
const providerURL = `${pathToFileURL(providerPath).href}?t=base`;
const { createOpenClawProvider, resolveOpenClawGatewayConfig } = await import(providerURL);

// ── 1. Config resolution (pure function, env reset between cases) ──
section("resolveOpenClawGatewayConfig() — env precedence + loopback bind fix");
{
    const cfg = resolveOpenClawGatewayConfig();
    assert.equal(cfg.url, "http://openclaw.test:18789");
    assert.equal(cfg.authSecret, "test-token");
    ok("env OPENCLAW_GATEWAY_URL / TOKEN take precedence");

    // The loopback bind bug fix: gateway.bind="loopback" must NOT produce
    // http://loopback:9999. It must normalize to 127.0.0.1.
    const cfgPath = join(tmpDir, "loopback-cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ gateway: { bind: "loopback", port: 9999, auth: { token: "config-tok" } } }));
    const prevCfg = process.env.OPENCLAW_CONFIG_PATH;
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    const prevTok = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_CONFIG_PATH = cfgPath;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
        const c = resolveOpenClawGatewayConfig();
        assert.equal(c.url, "http://127.0.0.1:9999", `loopback bind → 127.0.0.1 (was http://loopback:9999)`);
        assert.equal(c.authSecret, "config-tok");
        ok("gateway.bind=\"loopback\" → http://127.0.0.1:9999 (bug fix)");
    } finally {
        process.env.OPENCLAW_CONFIG_PATH = prevCfg;
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
        process.env.OPENCLAW_GATEWAY_TOKEN = prevTok;
    }
}

section("resolveOpenClawGatewayConfig() — all bind modes normalize");
{
    for (const bind of ["loopback", "localhost", "0.0.0.0", "lan", "all", "127.0.0.1"]) {
        const p = join(tmpDir, `bind-${bind}.json`);
        writeFileSync(p, JSON.stringify({ gateway: { bind, port: 8888 } }));
        const prev = process.env.OPENCLAW_CONFIG_PATH;
        const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
        process.env.OPENCLAW_CONFIG_PATH = p;
        delete process.env.OPENCLAW_GATEWAY_URL;
        try {
            const c = resolveOpenClawGatewayConfig();
            assert.match(c.url, /^http:\/\/127\.0\.0\.1:8888$/, `bind=${bind} → 127.0.0.1, got ${c.url}`);
        } finally {
            process.env.OPENCLAW_CONFIG_PATH = prev;
            process.env.OPENCLAW_GATEWAY_URL = prevUrl;
        }
    }
    ok("loopback / localhost / 0.0.0.0 / lan / all / 127.0.0.1 → 127.0.0.1");
}

section("resolveOpenClawGatewayConfig() — remote mode");
{
    const p = join(tmpDir, "remote.json");
    writeFileSync(p, JSON.stringify({
        gateway: { mode: "remote", port: 9999, remote: { url: "https://remote.openclaw.example.com" }, auth: { password: "remote-pw" } },
    }));
    const prev = process.env.OPENCLAW_CONFIG_PATH;
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    const prevTok = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_CONFIG_PATH = p;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
        const c = resolveOpenClawGatewayConfig();
        assert.equal(c.url, "https://remote.openclaw.example.com");
        assert.equal(c.authSecret, "remote-pw");
        ok("mode=remote uses gateway.remote.url and ignores local port");
    } finally {
        process.env.OPENCLAW_CONFIG_PATH = prev;
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
        process.env.OPENCLAW_GATEWAY_TOKEN = prevTok;
    }
}

// ── 2. Provider behavior (single process, mocked fetch) ─────
section("createOpenClawProvider() — eager initial sync + public surface");
{
    const provider = createOpenClawProvider((sid, msg) => {});
    try {
        const sessions = await provider.listSessions(10);
        const ids = sessions.map((s) => s.id);
        assert.ok(ids.includes("85f66c1c-7703-45b5-9c0c-57eddc2405ca"), "fixture session 1 present");
        assert.ok(ids.includes("ef585ca3-957a-4fe9-a463-f8d72b54ba9e"), "fixture session 2 present");
        const aborted = sessions.find((s) => s.id === "ef585ca3-957a-4fe9-a463-f8d72b54ba9e");
        assert.equal(aborted.status, "aborted", "abortedLastRun → status=aborted");
        assert.ok(sessions[0].timestamp >= sessions[1].timestamp, "sorted newest first");
        const required = ["listSessions", "getSessionStatus", "getInfo", "getHistory",
                          "prompt", "respondPermission", "respondQuestion",
                          "interrupt", "getStatus", "dispose"];
        for (const m of required) assert.equal(typeof provider[m], "function", `missing ${m}`);
        ok("eager `openclaw sessions --json` populated the cache before first listSessions()");
        ok("status reflects abortedLastRun");
        ok("listSessions returns cache sorted newest-first");
        ok(`public surface: ${required.length} methods, all callable`);
    } finally {
        provider.dispose();
    }
}

section("listSessions() — first user message becomes the title (enrichment)");
{
    // The fixture has .jsonl transcripts for two of the session IDs. Their
    // titles should be replaced by the first user message instead of the
    // model-name placeholder.
    const provider = createOpenClawProvider(() => {});
    try {
        const sessions = await provider.listSessions(10);
        const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

        const withText = byId["85f66c1c-7703-45b5-9c0c-57eddc2405ca"];
        assert.ok(withText, "session 1 present");
        assert.equal(withText.title, "Build me a CLI todo app in Rust",
            `enriched title from transcript; got ${JSON.stringify(withText.title)}`);

        const withWake = byId["ef585ca3-957a-4fe9-a463-f8d72b54ba9e"];
        assert.ok(withWake, "session 2 present");
        assert.equal(withWake.title, "Wake up, my friend!",
            `enriched title from transcript; got ${JSON.stringify(withWake.title)}`);

        ok("title is replaced by the first user message from the .jsonl transcript");
        ok("different sessions get different titles (the model-name placeholder doesn't repeat)");
    } finally {
        provider.dispose();
    }
}

section("getHistory() — reads .jsonl transcript when session isn't in memory");
{
    // The 85f66c1c session has a transcript with a user turn, an assistant
    // turn (with a thinking part that should be filtered out), and a
    // follow-up user turn. getHistory should return all three messages
    // in chronological order, with the thinking part suppressed.
    const provider = createOpenClawProvider(() => {});
    try {
        // Make sure listSessions has run so transcriptDirs is populated.
        await provider.listSessions(10);
        const hist = provider.getHistory("85f66c1c-7703-45b5-9c0c-57eddc2405ca", 10);
        assert.equal(hist.length, 3, `expected 3 messages, got ${hist.length}: ${JSON.stringify(hist)}`);
        assert.equal(hist[0].role, "user");
        assert.equal(hist[0].text, "Build me a CLI todo app in Rust");
        assert.equal(hist[1].role, "assistant");
        assert.match(hist[1].text, /starting point/, "assistant text extracted, thinking filtered out");
        assert.doesNotMatch(hist[1].text, /thinking/i, "thinking part must not appear in history");
        assert.equal(hist[2].role, "user");
        assert.equal(hist[2].text, "Now add tests please");

        // The session is NOT in the provider's in-memory map; this proves
        // the disk-fallback path actually fires.
        ok("getHistory returns 3 messages from the on-disk transcript");
        ok("thinking part is filtered out of assistant messages");
        ok("user/assistant text parts are extracted in order");
    } finally {
        provider.dispose();
    }
}

section("getHistory() — image-only user turn shows [image attachment] placeholder");
{
    // Write a fresh transcript with an image-only user message and confirm
    // getHistory surfaces it as a placeholder rather than dropping it.
    const imageOnlyDir = join(tmpDir, "transcripts-image");
    mkdirSync(imageOnlyDir, { recursive: true });
    const imageSid = "image-only-session-1234";
    writeFileSync(join(imageOnlyDir, `${imageSid}.jsonl`),
        `{"type":"session","version":3,"id":"${imageSid}","timestamp":"2026-06-24T00:00:00.000Z"}\n` +
        `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-24T00:00:01.000Z","message":{"role":"user","content":[{"type":"image_url","image_url":{"url":"file:///tmp/foo.png"}}],"timestamp":1}}\n` +
        `{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-24T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I see your image."}]}}\n`
    );
    // Add the store path to the mock's response so knownTranscriptDirs
    // picks it up on the next listSessions.
    const extendedFixture = JSON.parse(sessionsFixture);
    extendedFixture.stores = [
        { agentId: "main", path: storePath },
        { agentId: "main-image", path: join(imageOnlyDir, "sessions.json") },
    ];
    sessionsFixture = JSON.stringify(extendedFixture);
    writeFileSync(join(tmpDir, "sessions-with-stores.json"), sessionsFixture);

    const provider = createOpenClawProvider(() => {});
    try {
        await provider.listSessions(10);
        const hist = provider.getHistory(imageSid, 10);
        assert.equal(hist.length, 2, `expected 2 messages, got ${hist.length}: ${JSON.stringify(hist)}`);
        assert.equal(hist[0].role, "user");
        assert.equal(hist[0].text, "[image attachment]", "image-only turn shows placeholder");
        assert.equal(hist[1].role, "assistant");
        assert.equal(hist[1].text, "I see your image.");
        ok("image-only user turn renders as '[image attachment]'");
        ok("text response to the image is still captured");
    } finally {
        provider.dispose();
    }
}

section("prompt() — streaming SSE + history + status + headers");
{
    const encoder = new TextEncoder();
    let request;
    const chunks = [
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return {
            ok: true,
            status: 200,
            body: { getReader() {
                return { async read() {
                    if (chunks.length === 0) return { done: true, value: undefined };
                    return { done: false, value: encoder.encode(chunks.shift()) };
                } };
            } },
        };
    };
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        const sid = "test-stream";
        const result = await provider.prompt(sid, "Say hello", "/tmp/p", "openclaw/main", "medium", true);
        assert.equal(result.sessionId, sid);
        assert.equal(result.provider, "openclaw");
        assert.equal(request.url, "http://openclaw.test:18789/v1/chat/completions");
        assert.equal(request.options.headers.Authorization, "Bearer test-token");
        assert.equal(request.options.headers["x-openclaw-agent-id"], "main");
        assert.equal(request.options.headers["x-openclaw-session-key"], sid);
        assert.equal(request.options.headers["x-openclaw-thinking-level"], "medium");
        const body = JSON.parse(request.options.body);
        assert.equal(body.model, "openclaw/main");
        assert.equal(body.user, sid);
        assert.equal(body.stream, true);
        assert.deepEqual(body.messages, [{ role: "user", content: "Say hello" }]);
        await waitFor(() => events.filter((e) => e.msg.type === "text_delta").length === 3, "streaming text_delta events");
        const deltas = events.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
        assert.deepEqual(deltas, ["hello", " world", "!"]);
        const resultEvent = events.find((e) => e.msg.type === "result");
        assert.equal(resultEvent.msg.text, "hello world!");
        const statusEvents = events.filter((e) => e.msg.type === "status").map((e) => e.msg.state);
        assert.deepEqual(statusEvents, ["busy", "idle"]);
        assert.deepEqual(provider.getHistory(sid, 10), [
            { role: "user", text: "Say hello" },
            { role: "assistant", text: "hello world!" },
        ]);
        assert.deepEqual(provider.getStatus(sid), { state: "idle", provider: "openclaw" });
        assert.equal(provider.getSessionStatus(sid), "idle");
        ok("POST /v1/chat/completions with correct URL, headers, and body");
        ok(`text_delta events: ${JSON.stringify(deltas)}`);
        ok("result event with accumulated text");
        ok("status transitions: busy → idle");
        ok("getHistory captures the full exchange");
        ok("getStatus / getSessionStatus return idle after completion");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("prompt() — thinking=off omits the header");
{
    let request;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => { request = { url, options }; return { ok: true, status: 200, body: null }; };
    try {
        const provider = createOpenClawProvider(() => {});
        await provider.prompt("sid-no-think", "hi", undefined, undefined, "off", false);
        assert.equal(request.options.headers["x-openclaw-thinking-level"], undefined, "thinking=off omits the header");
        assert.equal(request.options.headers["x-openclaw-agent-id"], "main", "OPENCLAW_AGENT_ID=main is the default agent id");
        const body = JSON.parse(request.options.body);
        assert.equal(body.model, "openclaw/main");
        ok("thinking=off omits the header; OPENCLAW_AGENT_ID=main is the default");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("prompt() — non-streaming response (no body.getReader)");
{
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true, status: 200, body: undefined,
        json: async () => ({ choices: [{ message: { content: "single shot" } }] }),
    });
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        await provider.prompt("sid-nonsse", "ping", undefined, "openclaw/main");
        await waitFor(() => events.some((e) => e.msg.type === "text_delta"), "non-streaming text_delta");
        const deltas = events.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
        assert.deepEqual(deltas, ["single shot"]);
        assert.equal(provider.getHistory("sid-nonsse", 10)[1].text, "single shot");
        ok("non-streaming response: one text_delta with full text, history captured");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("prompt() — JSON chat completion with readable body");
{
    const encoder = new TextEncoder();
    const bodyText = JSON.stringify({ choices: [{ message: { content: "json body reply" } }] });
    const chunks = [bodyText];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: { getReader() {
            return { async read() {
                if (chunks.length === 0) return { done: true, value: undefined };
                return { done: false, value: encoder.encode(chunks.shift()) };
            } };
        } },
    });
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        await provider.prompt("sid-readable-json", "ping", undefined, "openclaw/main");
        await waitFor(() => events.some((e) => e.msg.type === "text_delta"), "readable JSON text_delta");
        const deltas = events.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
        assert.deepEqual(deltas, ["json body reply"]);
        assert.equal(provider.getHistory("sid-readable-json", 10)[1].text, "json body reply");
        ok("readable JSON chat-completions body is captured as an assistant reply");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("prompt() — 404 surfaces the chat-completions enablement hint");
{
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", text: async () => "Cannot GET /v1/chat/completions" });
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        await provider.prompt("sid-404", "hi");
        await waitFor(() => events.some((e) => e.msg.type === "error"), "404 error event");
        const err = events.find((e) => e.msg.type === "error");
        assert.match(err.msg.value, /chat\/completions is disabled/);
        assert.match(err.msg.value, /endpoints\.chatCompletions\.enabled/);
        ok("404 → actionable hint about gateway.http.endpoints.chatCompletions.enabled");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("prompt() — 500 surfaces status code without the hint");
{
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "ISE", text: async () => "boom" });
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        await provider.prompt("sid-500", "hi");
        await waitFor(() => events.some((e) => e.msg.type === "error"), "500 error event");
        const err = events.find((e) => e.msg.type === "error");
        assert.match(err.msg.value, /OpenClaw gateway error 500/);
        assert.doesNotMatch(err.msg.value, /chat\/completions is disabled/);
        ok("500 → status code only, no false-positive hint");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("prompt() — concurrent prompt on a busy session is rejected with 409");
{
    const originalFetch = globalThis.fetch;
    let inflightResolve;
    globalThis.fetch = async () => ({
        ok: true, status: 200,
        body: { getReader() { return { async read() { return new Promise((r) => { inflightResolve = () => r({ done: true, value: undefined }); }); } }; } },
    });
    try {
        const provider = createOpenClawProvider(() => {});
        const p1 = provider.prompt("busy-sid", "first");
        await new Promise((r) => setTimeout(r, 50));
        await assert.rejects(provider.prompt("busy-sid", "second"), /Session is busy/);
        inflightResolve();
        await p1;
        provider.dispose();
        ok("busy session → 409 with 'Session is busy' error");
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("interrupt() — mid-stream aborts, flips status to idle");
{
    const originalFetch = globalThis.fetch;
    let abortSignal;
    globalThis.fetch = async (url, options) => {
        abortSignal = options.signal;
        return { ok: true, status: 200, body: { getReader() { return { async read() {
            return new Promise((_, reject) => { abortSignal.addEventListener("abort", () => {
                const e = new Error("aborted"); e.name = "AbortError"; reject(e);
            }); });
        } }; } } };
    };
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        const p = provider.prompt("int-sid", "hi");
        await new Promise((r) => setTimeout(r, 50));
        provider.interrupt("int-sid");
        await p;
        assert.equal(provider.getSessionStatus("int-sid"), "idle");
        assert.equal(abortSignal.aborted, true);
        ok("interrupt mid-stream → status idle, fetch aborted");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("interrupt() + re-prompt — stale turn's late deltas do not leak onto the new turn");
{
    // Regression: interrupt() aborts the fetch, but the old runPrompt may still
    // be draining its reader when a new prompt() starts. Without a turn token,
    // the old turn's late text_delta/result events emitted onto the session
    // AFTER the new turn began would interleave with the new turn's output. The
    // fix (turn token) makes the stale turn detect it no longer owns the
    // session and drop its late events.
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    // Each fetch returns a reader whose read() is gated by an external
    // resolve, so we can interleave turns deterministically.
    let turn1Late = null; // resolve to deliver turn 1's stale delta
    let turn2Resolve = null;
    let callCount = 0;
    globalThis.fetch = async () => {
        callCount += 1;
        const myCall = callCount;
        if (myCall === 1) {
            // Turn 1: one delta, then stall until we resolve turn1Late (simulating
            // a slow gateway that delivers more data AFTER the user interrupted).
            let sentFirst = false;
            return {
                ok: true, status: 200, body: { getReader() { return { async read() {
                    if (!sentFirst) { sentFirst = true; return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"turn1 start"}}]}\n\n') }; }
                    return new Promise((resolve) => { turn1Late = () => resolve({ done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"turn1 LATE LEAK"}}]}\n\n') }); });
                } }; } },
            };
        }
        // Turn 2: deliver its own delta on resolve.
        return {
            ok: true, status: 200, body: { getReader() { return { async read() {
                return new Promise((resolve) => { turn2Resolve = () => resolve({ done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"turn2 real"}}]}\n\n') }); });
            } }; } },
        };
    };
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));

        // Turn 1: streams "turn1 start", then stalls mid-stream.
        const p1 = provider.prompt("race-sid", "one");
        await waitFor(() => events.some((e) => e.msg.type === "text_delta" && e.msg.text === "turn1 start"), "turn1 first delta");

        // User interrupts and immediately starts turn 2.
        provider.interrupt("race-sid");
        const p2 = provider.prompt("race-sid", "two");
        await waitFor(() => typeof turn2Resolve === "function", "turn2 reader ready");

        // Now turn 1's gateway belatedly delivers its stale delta. With the
        // race, this would emit "turn1 LATE LEAK" onto turn 2.
        turn1Late();
        // Deliver turn 2's real delta and end it.
        turn2Resolve();
        await p1.catch(() => {}); // turn 1's fetch rejects (aborted) or returns stale
        await p2;

        const deltas = events.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
        assert.ok(!deltas.includes("turn1 LATE LEAK"),
            `stale turn-1 delta must not leak onto turn 2; deltas=${JSON.stringify(deltas)}`);
        assert.ok(deltas.includes("turn2 real"),
            `turn 2's own delta must be present; deltas=${JSON.stringify(deltas)}`);
        ok("interrupt + re-prompt: stale turn's late deltas are dropped (turn token guard)");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("getHistory() — in-flight partial text included during busy turn");
{
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    const chunks = [
        'data: {"choices":[{"delta":{"content":"part1 "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"part2"}}]}\n\n',
    ];
    globalThis.fetch = async () => ({
        ok: true, status: 200, body: { getReader() { return { async read() {
            if (chunks.length === 0) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks.shift()) };
        } }; } },
    });
    try {
        const provider = createOpenClawProvider(() => {});
        const p = provider.prompt("hist-sid", "go");
        await new Promise((r) => setTimeout(r, 30));
        const h1 = provider.getHistory("hist-sid", 10);
        assert.ok(h1.length >= 2, `expected at least 2 history rows, got ${JSON.stringify(h1)}`);
        const partial = h1.find((x) => x.role === "assistant");
        assert.equal(partial.text, "part1 part2");
        await p;
        ok("getHistory during busy turn includes the partial assistant text");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("getHistory() — stale partial text from a failed turn does not leak into the next turn");
{
    // Regression: runPrompt's catch used to leave session.partialText populated
    // after a failed/aborted turn. getHistory() only appends partialText while
    // the session is busy, so the phantom did not show after the turn ended —
    // but it DID leak into the NEXT turn: the next prompt() flips busy=true
    // before its first delta arrives, and getHistory during that window
    // appended the dead turn's "doomed partial" as the new turn's in-progress
    // reply. After the fix the catch clears partialText, so a freshly-started
    // turn shows no assistant text until it actually streams something.
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;
    let mode = "fail-after-delta"; // "fail-after-delta" | "stall"
    globalThis.fetch = async () => {
        if (mode === "fail-after-delta") {
            let firstRead = true;
            return {
                ok: true, status: 200, body: { getReader() { return { async read() {
                    if (firstRead) {
                        firstRead = false;
                        return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"doomed partial"}}]}\n\n') };
                    }
                    throw new Error("gateway stream broke");
                } }; } },
            };
        }
        // mode === "stall": never resolves a chunk, so turn 2 stays busy with
        // no deltas — exactly the window where stale partialText would leak.
        return {
            ok: true, status: 200, body: { getReader() { return { async read() {
                return new Promise(() => {});
            } }; } },
        };
    };
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));

        // Turn 1: streams one delta, then fails.
        const p1 = provider.prompt("leak-sid", "go");
        await waitFor(() => events.some((e) => e.msg.type === "error"), "turn-1 stream-error event");
        await p1;
        assert.equal(provider.getSessionStatus("leak-sid"), "idle");

        // Turn 2: starts busy but stalls before emitting any delta. This is the
        // window where the un-cleared partialText from turn 1 would bleed in.
        mode = "stall";
        provider.prompt("leak-sid", "again");
        await waitFor(() => provider.getSessionStatus("leak-sid") === "busy", "turn-2 busy");
        const hist = provider.getHistory("leak-sid", 10);
        const assistantRows = hist.filter((x) => x.role === "assistant");
        assert.deepEqual(assistantRows, [],
            `no stale assistant text from turn 1 in turn 2's busy window, got ${JSON.stringify(hist)}`);
        ok("failed turn clears partialText — next turn shows no stale partial reply");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("getInfo() — version + model + account + provider");
{
    const provider = createOpenClawProvider(() => {});
    try {
        const info = provider.getInfo();
        assert.equal(info.provider, "openclaw");
        assert.match(info.version, /OpenClaw 2026\.6\.10/);
        assert.equal(info.model, "openclaw/main");
        assert.equal(info.account.organization, "OpenClaw");
        assert.match(info.account.email, /openclaw\/main via http:\/\/openclaw\.test:18789/);
        ok("getInfo: provider=openclaw, model=openclaw/main, version from --version, account=OpenClaw");
        provider.dispose();
    } finally {
        // dispose here is a no-op (covered in next test)
    }
}

section("dispose() — clears refresh timer and aborts in-flight sessions");
{
    const originalFetch = globalThis.fetch;
    let abortSignal;
    globalThis.fetch = async (url, options) => {
        abortSignal = options.signal;
        return { ok: true, status: 200, body: { getReader() { return { async read() {
            return new Promise((_, reject) => { abortSignal.addEventListener("abort", () => {
                const e = new Error("aborted"); e.name = "AbortError"; reject(e);
            }); });
        } }; } } };
    };
    try {
        const provider = createOpenClawProvider(() => {});
        const p = provider.prompt("disp-sid", "hi");
        await new Promise((r) => setTimeout(r, 50));
        provider.dispose();
        await p;
        assert.equal(abortSignal.aborted, true);
        provider.dispose(); // idempotent
        ok("dispose aborts in-flight fetch; idempotent on second call");
    } finally {
        globalThis.fetch = originalFetch;
    }
}

section("getHistory() — merges on-disk transcript with in-memory turn (no 'fork')");
{
    // Repro for the "fork" appearance: sending a message to an existing
    // openclaw session used to show ONLY the new turn, because getHistory
    // short-circuited to the in-memory message log — which was empty/partial
    // whenever the transcript dir wasn't known at prompt time. The transcript
    // is authoritative for prior history; getHistory must merge transcript +
    // in-memory, deduping turns that exist in both.
    //
    // 85f66c1c has an on-disk transcript with 3 messages. We prompt it (which
    // loads those 3 into memory and appends a new user turn + assistant reply),
    // then assert getHistory returns all 5 with NO duplication of the 3 prior.
    const encoder = new TextEncoder();
    const chunks = ['data: {"choices":[{"delta":{"content":"sure thing"}}]}\n\n'];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true, status: 200,
        body: { getReader() {
            return { async read() {
                if (chunks.length === 0) return { done: true, value: undefined };
                return { done: false, value: encoder.encode(chunks.shift()) };
            } };
        } },
    });
    try {
        const events = [];
        const provider = createOpenClawProvider((sid, msg) => events.push({ sid, msg }));
        await provider.listSessions(10); // populate knownTranscriptDirs
        const sid = "85f66c1c-7703-45b5-9c0c-57eddc2405ca";
        await provider.prompt(sid, "And one more thing", "/tmp/p", "openclaw/main", "off", false);
        await waitFor(() => events.some((e) => e.msg.type === "result"), "result event for merged-history prompt");

        const hist = provider.getHistory(sid, 50);
        // 3 transcript turns + 1 new user + 1 new assistant = 5, no dupes.
        assert.equal(hist.length, 5, `expected 5 merged messages, got ${hist.length}: ${JSON.stringify(hist)}`);
        assert.equal(hist[0].text, "Build me a CLI todo app in Rust");
        assert.equal(hist[2].text, "Now add tests please");
        assert.equal(hist[3].text, "And one more thing", "new user turn appended after transcript history");
        assert.equal(hist[4].text, "sure thing", "new assistant reply appended");
        // No (role,text) pair appears more than once — the dedup contract.
        const keys = hist.map((m) => `${m.role}|${m.text}`);
        assert.equal(new Set(keys).size, keys.length, "no duplicated messages after merge");
        ok("getHistory merges transcript + in-memory turn (no fork, no dupes)");
        provider.dispose();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// ── Summary ─────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);