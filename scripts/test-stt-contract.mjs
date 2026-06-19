/**
 * STT (Speech-to-Text) Contract Test
 *
 * Coverage gaps this guards:
 *
 * 1. BUILT-IN path (Issue 3 gap): the whole /api/transcribe route had ZERO
 *    tests before this. A missing system dependency shipped to real hardware
 *    and was only caught by a user. This boots the real backend (built-in
 *    Whisper engine) and asserts a known-PCM input round-trips to a non-empty
 *    transcript.
 *
 * 2. PROVIDER PROXY path: when the backend is started with
 *    --stt-provider-url <deepgram-host> --stt-provider-key <key>, it must
 *    proxy the audio to the provider with the correct contract (WAV body +
 *    `Authorization: Token <key>`) AND keep the key entirely server-side —
 *    the key must NEVER appear in the response sent to the frontend (which is
 *    distributed to end users; a leaked key = unbounded billing).
 *
 *    A mock Deepgram-compatible server records what the backend forwards so
 *    the test can assert the wire contract + the no-leak invariant directly.
 */

import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 3478;
const PROVIDER_PORT = 3479;
const URL = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Generate a known-PCM fixture ───────────────────────────────────────
function generatePcm() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stt-test-"));
    const aiff = path.join(tmp, "in.aiff");
    const pcm = path.join(tmp, "in.pcm");
    const text = "Hello world, this is a speech to text contract test.";
    try {
        execFileSync("say", ["-o", aiff, text], { stdio: "ignore" });
        execFileSync("ffmpeg", ["-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-f", "s16le", pcm], { stdio: "ignore" });
        return { pcm: fs.readFileSync(pcm), tmp };
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        const err = new Error("Test requires `say` and `ffmpeg` on PATH to generate a PCM fixture.");
        err.code = "MISSING_BIN";
        throw err;
    }
}

// ── Mock Deepgram-compatible server ────────────────────────────────────
// Records the exact request the backend forwards so we can assert: WAV body,
// Token auth scheme, correct query params, and that the response carries the
// transcript but NOT the key.
function startMockDeepgram() {
    const received = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        received.push({
            url: req.url,
            method: req.method,
            headers: {
                authorization: req.headers.authorization || null,
                "content-type": req.headers["content-type"] || null,
            },
            body,
            // A real WAV starts with "RIFF....WAVE". Asserting this proves the
            // backend wrapped the raw PCM in a WAV header (Deepgram rejects raw PCM).
            bodyStartsWithRiff: body.slice(0, 4).toString("ascii") === "RIFF",
            bodyHasWave: body.slice(8, 12).toString("ascii") === "WAVE",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            results: { channels: [{ alternatives: [{ transcript: "deepgram mock transcript", confidence: 0.99 }] }] },
        }));
    });
    return new Promise((resolve) => {
        server.listen(PROVIDER_PORT, "127.0.0.1", () => resolve({ server, received }));
    });
}

async function waitForBackend(url) {
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`${url}/api/agents`); if (r.ok) return; } catch {}
        await sleep(300);
    }
    throw new Error("backend did not boot in time");
}

// ── Run ────────────────────────────────────────────────────────────────
let pcmFixture;
let exitCode = 0;

try {
    pcmFixture = generatePcm();
    console.log(`Generated PCM fixture: ${pcmFixture.pcm.length} bytes`);
} catch (e) {
    if (e.code === "MISSING_BIN") { console.log(`ℹ SKIP: ${e.message}`); process.exit(0); }
    throw e;
}

let builtInProc, providerProc, mockProvider;
try {
    // ── Path 1: built-in /api/transcribe ───────────────────────────────
    console.log("\n== Path 1: built-in STT engine (transformers.js Whisper) ==");
    builtInProc = spawn(process.execPath, ["bin/even-agent-home.js", "--token", "stt-test", "--host", "127.0.0.1", "--port", String(PORT)], {
        cwd: path.resolve(import.meta.dirname, "..", "backend"),
        env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) },
        stdio: "ignore",
    });
    await waitForBackend(URL);

    const r = await fetch(`${URL}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: Array.from(pcmFixture.pcm) }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, `built-in /api/transcribe should return 200 (got ${r.status})`);
    assert.ok(typeof body.text === "string" && body.text.trim().length > 0, "transcript must be non-empty string");
    const lower = body.text.toLowerCase();
    assert.ok(lower.includes("hello") || lower.includes("world") || lower.includes("speech") || lower.includes("test"),
        `transcript "${body.text}" did not contain expected words`);
    console.log(`  ✔ transcript: "${body.text}"`);

    const empty = await (await fetch(`${URL}/api/transcribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: [] }) })).json();
    assert.equal(empty.text, "No audio provided");
    console.log("  ✔ empty audio handled gracefully");
    builtInProc.kill("SIGTERM"); builtInProc = null;
    await sleep(500);

    // ── Path 2: backend proxies to external Deepgram provider ─────────
    console.log("\n== Path 2: backend proxies to Deepgram provider (key stays server-side) ==");
    mockProvider = await startMockDeepgram();
    const TEST_KEY = "test-key-do-not-leak-xxxxxxxxxx";
    providerProc = spawn(process.execPath, [
        "bin/even-agent-home.js",
        "--token", "stt-provider-test",
        "--host", "127.0.0.1",
        "--port", String(PORT),
        "--stt-provider-url", `http://127.0.0.1:${PROVIDER_PORT}`,
        "--stt-provider-type", "deepgram",
        "--stt-provider-key", TEST_KEY,
    ], {
        cwd: path.resolve(import.meta.dirname, "..", "backend"),
        env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) },
        stdio: "ignore",
    });
    await waitForBackend(URL);

    const t0 = Date.now();
    const res = await fetch(`${URL}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: Array.from(pcmFixture.pcm) }),
    });
    const resText = await res.text();
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200, `provider proxy should return 200 (got ${res.status}: ${resText})`);

    // CRITICAL: the provider key must NEVER appear in the frontend-facing
    // response. This is the no-leak invariant.
    assert.ok(!resText.includes(TEST_KEY), `PROVIDER KEY LEAKED to frontend response: ${resText}`);
    const resJson = JSON.parse(resText);
    assert.equal(resJson.text, "deepgram mock transcript", `expected proxied transcript, got: ${resText}`);
    console.log(`  ✔ transcript proxied in ${elapsed}ms: "${resJson.text}"`);
    console.log("  ✔ provider key NOT present in frontend response (no leak)");

    // Assert the backend forwarded the correct Deepgram contract to the mock.
    assert.equal(mockProvider.received.length, 1, "backend should forward exactly one request to provider");
    const fwd = mockProvider.received[0];
    assert.equal(fwd.method, "POST");
    assert.equal(fwd.headers.authorization, `Token ${TEST_KEY}`, "must use 'Token <key>' scheme for Deepgram");
    assert.equal(fwd.headers["content-type"], "audio/wav", "must send WAV content-type");
    assert.ok(fwd.url.includes("/v1/listen"), "must hit the /v1/listen path");
    assert.ok(fwd.url.includes("model=nova-3"), "must request nova-3 model");
    assert.ok(fwd.bodyStartsWithRiff, "forwarded body must be WAV (RIFF header)");
    assert.ok(fwd.bodyHasWave, "forwarded body must be WAV (WAVE marker)");
    assert.ok(fwd.body.length > pcmFixture.pcm.length, `WAV body (${fwd.body.length}) must be PCM (${pcmFixture.pcm.length}) + 44-byte header`);
    console.log("  ✔ backend forwarded WAV body + Token auth + nova-3 model to provider");

    console.log("\n✅ All STT contract tests passed");
} catch (err) {
    console.error("\n❌ STT contract test failed:", err.message);
    exitCode = 1;
} finally {
    if (builtInProc) try { builtInProc.kill("SIGTERM"); } catch {}
    if (providerProc) try { providerProc.kill("SIGTERM"); } catch {}
    if (mockProvider) try { await new Promise((r) => mockProvider.server.close(r)); } catch {}
    if (pcmFixture) try { fs.rmSync(pcmFixture.tmp, { recursive: true, force: true }); } catch {}
    process.exit(exitCode);
}
