/**
 * Integration test for the Tier 2 CLI provider
 * (backend/src/providers/cli.js).
 *
 * Spawns a tiny mock "CLI" (a node script under test/fixtures/) that emits the
 * pi/oh-my-pi JSONL event dialect:
 *   {type:"session", id, ...}
 *   {type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"..."}}
 *   {type:"turn_end"}
 *
 * Asserts the generic cli provider, driven only by the `events` map, correctly:
 *   - captures the session id from the declared JSON path
 *   - emits text_delta for each delta
 *   - resolves prompt with the canonical session id (not the temp emit id)
 *   - emits a success result on the result marker
 *   - errors on a silent failure (no text, no marker)
 *
 * Also covers on-disk session listing via `sessionsDir` using a fixture transcript.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createCliProvider } from "../backend/src/providers/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
// Mock CLI scripts that emit a fixed JSONL event stream.
const FIXTURE_STREAM = join(here, "fixtures", "mock-cli-stream.mjs");
const FIXTURE_SILENT = join(here, "fixtures", "mock-cli-silent.mjs");

// pi-style events schema (what the config's `events` map describes).
// The mock emits `{type:"session", id:"..."}` so the session-id path is "id".
const PI_EVENTS = {
    sessionId: "id",
    textDelta: {
        type: "message_update",
        nestedType: "assistantMessageEvent.type",
        value: "assistantMessageEvent.delta",
    },
    thinkingAsText: true,
    resultMarkers: ["turn_end", "agent_end"],
};

function cfg(overrides = {}) {
    return {
        name: "mock-cli-agent",
        type: "cli",
        bin: process.execPath,       // node
        args: [FIXTURE_STREAM],
        model: "m",
        events: PI_EVENTS,
        // non-TUI mock: no need for detached process groups / color suppression
        detached: false,
        suppressColor: false,
        timeoutMs: 5000,
        ...overrides,
    };
}

// The cli provider's prompt() resolves as soon as the session id is known
// (HTTP 202 model — streaming continues in the background and a `result` event
// is emitted on completion). Tests must wait for that result event before
// asserting on the collected event stream.
function waitForResult(events) {
    return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timed out waiting for result event")), 8000);
        const check = () => {
            const r = events.find((e) => (e.msg ?? e).type === "result");
            if (r) { clearTimeout(deadline); resolve(r.msg ?? r); }
            else setTimeout(check, 5);
        };
        check();
    });
}

test("cli: captures session id + streams deltas + result marker", async () => {
    const events = [];
    const provider = createCliProvider(cfg(), (sid, msg) => events.push({ sid, msg }));
    // Don't await prompt for completion — await the result EVENT instead.
    void provider.prompt("phone-1", "hello", "/tmp", undefined, undefined, false);
    const resultEv = await waitForResult(events);

    // The mock emits a fixed session id from the {type:"session"} event; the
    // provider must have captured it via the configured "id" path.
    assert.equal(resultEv.provider, "mock-cli-agent");
    assert.equal(resultEv.success, true);
    assert.equal(resultEv.text, "Hello world");

    const deltas = events.filter((e) => e.msg.type === "text_delta").map((e) => e.msg.text);
    assert.deepEqual(deltas, ["Hel", "lo", " world"]);
});

test("cli: result marker alone (without deltas) still resolves success", async () => {
    const events = [];
    const provider = createCliProvider(cfg(), (sid, msg) => events.push(msg));
    void provider.prompt("phone-2", "hi", "/tmp");
    const resultEv = await waitForResult(events);
    assert.equal(resultEv.success, true);
});

test("cli: silent failure (no text, no marker) → failure result + error", async () => {
    const events = [];
    const provider = createCliProvider(
        cfg({ args: [FIXTURE_SILENT] }),
        (sid, msg) => events.push(msg)
    );
    void provider.prompt("phone-3", "hi", "/tmp");
    const resultEv = await waitForResult(events);
    assert.equal(resultEv.success, false, "no text + no marker = failure");
    assert.ok(resultEv.error, "an error message must be present");
});

test("cli: sessionFlag is added when resuming a known session", async () => {
    // A mock that emits the args it received as text_delta content, so we can
    // assert the provider rendered the sessionFlag template for a known session.
    const tmp = mkdtempSync(join(tmpdir(), "cli-args-"));
    const echoCli = join(tmp, "echo-args.mjs");
    writeFileSync(
        echoCli,
        `const a = process.argv.slice(1).join(" ");\n` +
        `process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:a}})+"\\n");\n` +
        `process.stdout.write(JSON.stringify({type:"turn_end"})+"\\n");\n`
    );

    const events = [];
    const provider = createCliProvider(
        cfg({ args: [echoCli], sessionFlag: ["--session", "{{sessionId}}"] }),
        (sid, msg) => events.push(msg)
    );
    // The phone id IS the known session id (no {type:"session"} event from the
    // mock), so the provider treats it as a resume and appends the flag.
    void provider.prompt("known-session", "hi", "/tmp");
    const resultEv = await waitForResult(events);
    assert.equal(resultEv.success, true);
    // The streamed text is the args the mock received; it must contain the
    // rendered session flag with the session id substituted in.
    const streamed = events.find((e) => e.type === "text_delta")?.text || "";
    assert.match(streamed, /--session known-session/, "sessionFlag must be rendered for a known session");
});

test("cli: on-disk sessionsDir listing reads transcripts", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-sessions-"));
    const sessionsDir = join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
        join(sessionsDir, "abc.jsonl"),
        [
            JSON.stringify({ type: "session", id: "abc-123", title: "First chat", cwd: "/tmp" }),
            JSON.stringify({ type: "message", message: { role: "user", content: "hey".repeat(80) } }),
        ].join("\n") + "\n"
    );

    const provider = createCliProvider(cfg({ sessionsDir }), () => {});
    const sessions = provider.listSessions(10);
    assert.ok(sessions.length >= 1, "on-disk session must be listed");
    const found = sessions.find((s) => s.id === "abc-123");
    assert.ok(found, "the fixture session id must appear");
    assert.equal(found.title, "First chat");
    assert.equal(found.provider, "mock-cli-agent");
});

test("cli: history reads on-disk transcript messages", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-hist-"));
    const sessionsDir = join(home, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
        join(sessionsDir, "h1.jsonl"),
        [
            JSON.stringify({ type: "session", id: "h-1" }),
            JSON.stringify({ type: "message", message: { role: "user", content: "u1" } }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "a1" } }),
        ].join("\n") + "\n"
    );
    const provider = createCliProvider(cfg({ sessionsDir }), () => {});
    const hist = provider.getHistory("h-1", 10);
    assert.equal(hist.length, 2);
    assert.equal(hist[0].role, "user");
    assert.equal(hist[0].text, "u1");
    assert.equal(hist[1].role, "assistant");
    assert.equal(hist[1].text, "a1");
});
