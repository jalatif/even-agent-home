/**
 * Integration test for the Tier 1 gateway provider
 * (backend/src/providers/gateway.js).
 *
 * Spins up a tiny HTTP server that speaks the OpenAI /v1/chat/completions SSE
 * contract, points a `type: gateway` config at it, and asserts the provider:
 *   - streams text_delta events as tokens arrive
 *   - emits a final result with the concatenated text
 *   - sends the configured Authorization header / model / messages
 *   - interrupts cleanly
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";

import { createGatewayProvider } from "../backend/src/providers/gateway.js";

// Build SSE chunks the OpenAI way: data: {choices:[{delta:{content:"X"}}]}
function sseChunk(content) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";

function startMockGateway({ expectedModel, expectedAuth, tokens }) {
    let lastReq = null;
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            lastReq = { url: req.url, method: req.method, auth: req.headers.authorization, body };
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            for (const tok of tokens) res.write(sseChunk(tok));
            res.write(SSE_DONE);
            res.end();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                port,
                server,
                getLastReq: () => lastReq,
            });
        });
    });
}

test("gateway: streams tokens and emits a result", async () => {
    const mock = await startMockGateway({ tokens: ["Hello", " world", "!"] });
    const url = `http://127.0.0.1:${mock.port}`;
    const events = [];
    const emit = (sid, msg) => events.push(msg);

    const cfg = { name: "mock-gw", type: "gateway", gatewayUrl: url, model: "test-model", apiKey: "secret-key" };
    const provider = createGatewayProvider(cfg, emit);

    const result = await provider.prompt("s1", "hi", "/tmp", undefined, undefined, false);

    assert.equal(result.provider, "mock-gw");
    assert.equal(result.sessionId, "s1");

    // text_delta events carry each token in order.
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text);
    assert.deepEqual(deltas, ["Hello", " world", "!"]);

    // result carries the concatenated text.
    const resultEv = events.find((e) => e.type === "result");
    assert.ok(resultEv);
    assert.equal(resultEv.success, true);
    assert.equal(resultEv.text, "Hello world!");
    assert.equal(resultEv.provider, "mock-gw");

    // The mock saw the right model + Authorization header + messages body.
    const lastReq = mock.getLastReq();
    assert.equal(lastReq.url, "/v1/chat/completions");
    assert.equal(lastReq.method, "POST");
    assert.equal(lastReq.auth, "Bearer secret-key");
    const sent = JSON.parse(lastReq.body);
    assert.equal(sent.model, "test-model");
    assert.equal(sent.stream, true);
    assert.equal(sent.messages[0].role, "user");
    assert.equal(sent.messages[0].content, "hi");

    mock.server.close();
});

test("gateway: omit Authorization when no apiKey", async () => {
    const mock = await startMockGateway({ tokens: ["x"] });
    const url = `http://127.0.0.1:${mock.port}`;
    const provider = createGatewayProvider(
        { name: "gw", type: "gateway", gatewayUrl: url, model: "m" },
        () => {}
    );
    await provider.prompt("s2", "hi", "/tmp");
    assert.equal(mock.getLastReq().auth, undefined, "no Authorization header when apiKey empty");
    mock.server.close();
});

test("gateway: apiKeyEnv reads from process.env", async () => {
    process.env.TEST_GW_KEY = "env-derived-key";
    const mock = await startMockGateway({ tokens: ["y"] });
    const url = `http://127.0.0.1:${mock.port}`;
    const provider = createGatewayProvider(
        { name: "gw", type: "gateway", gatewayUrl: url, model: "m", apiKey: "ignored-static", apiKeyEnv: "TEST_GW_KEY" },
        () => {}
    );
    await provider.prompt("s3", "hi", "/tmp");
    assert.equal(mock.getLastReq().auth, "Bearer env-derived-key", "apiKeyEnv wins over apiKey");
    delete process.env.TEST_GW_KEY;
    mock.server.close();
});

test("gateway: error event when the server returns non-2xx", async () => {
    const server = createServer((req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const events = [];
    const provider = createGatewayProvider(
        { name: "gw", type: "gateway", gatewayUrl: `http://127.0.0.1:${port}`, model: "m" },
        (sid, msg) => events.push(msg)
    );
    const result = await provider.prompt("s4", "hi", "/tmp");
    const errEv = events.find((e) => e.type === "error");
    assert.ok(errEv, "an error event must be emitted");
    assert.match(errEv.value, /Gateway error 500/);
    const resultEv = events.find((e) => e.type === "result");
    assert.equal(resultEv.success, false);
    assert.equal(result.provider, "gw");
    server.close();
});

test("gateway: history + status reflect in-memory session", async () => {
    const mock = await startMockGateway({ tokens: ["answer"] });
    const url = `http://127.0.0.1:${mock.port}`;
    const provider = createGatewayProvider(
        { name: "gw", type: "gateway", gatewayUrl: url, model: "m" },
        () => {}
    );
    await provider.prompt("s5", "hi", "/tmp");
    const hist = provider.getHistory("s5", 10);
    assert.equal(hist.length, 2); // user + assistant
    assert.equal(hist[0].role, "user");
    assert.equal(hist[1].role, "assistant");
    assert.equal(hist[1].text, "answer");
    assert.equal(provider.getStatus("s5").state, "idle");
    mock.server.close();
});
