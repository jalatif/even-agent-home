/**
 * Encryption Wire-Format Test for backend/src/crypto.js
 *
 * AES-256-GCM keyed off the bridge token is the DEFAULT wire format for every
 * real client: web/src/api.ts always sends `X-AgentHome-Encrypted: 1` and
 * wraps every request/response body as `{ encryptedPayload: "<base64>" }`.
 * backend/src/index.js decrypts inbound and encrypts outbound the same way.
 *
 * Before this suite, that path had ZERO tests. These run offline (no server,
 * no external deps) by importing crypto.js directly.
 *
 * Wire format (from crypto.js): base64( iv(12) || authTag(16) || ciphertext )
 */

import { strict as assert } from "node:assert";
import { encryptPayload, decryptPayload } from "../backend/src/crypto.js";

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}
function testAsync(name, fn) {
    return fn().then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failed++; console.error(`  ✗ ${name}: ${e.message}`); },
    );
}
const TOKEN = "my-bridge-secret-token";
const text = (b) => Buffer.from(b).toString("utf8");

// ── Round trip ─────────────────────────────────────────────
console.log("\n── Round trip ──");
test("encrypt → decrypt returns original bytes", () => {
    const payload = Buffer.from(JSON.stringify({ text: "hello", n: 42 }), "utf8");
    const ct = encryptPayload(payload, TOKEN);
    const pt = decryptPayload(ct, TOKEN);
    assert.deepEqual(pt, payload);
    assert.deepEqual(JSON.parse(text(pt)), { text: "hello", n: 42 });
});

test("round trip preserves unicode + emoji + large payload", () => {
    const big = "海洋生物学 🐠 — ".repeat(5000) + "end";
    const payload = Buffer.from(big, "utf8");
    const pt = decryptPayload(encryptPayload(payload, TOKEN), TOKEN);
    assert.equal(text(pt), big);
});

test("two encryptions of the same payload differ (random IV)", () => {
    const payload = Buffer.from("same content", "utf8");
    const a = encryptPayload(payload, TOKEN);
    const b = encryptPayload(payload, TOKEN);
    assert.notEqual(a, b, "identical ciphertexts — IV is not random");
    // ...but both decrypt to the same plaintext.
    assert.deepEqual(decryptPayload(a, TOKEN), decryptPayload(b, TOKEN));
});

// ── Auth tag / tamper detection ────────────────────────────
console.log("\n── Tamper detection (GCM auth tag) ──");
test("flipping a ciphertext byte throws on decrypt", () => {
    const payload = Buffer.from("secret message", "utf8");
    const buf = Buffer.from(encryptPayload(payload, TOKEN), "base64");
    buf[buf.length - 1] ^= 0x01; // flip last ciphertext byte
    assert.throws(() => decryptPayload(buf.toString("base64"), TOKEN));
});

test("flipping an auth-tag byte throws on decrypt", () => {
    const payload = Buffer.from("secret message", "utf8");
    const buf = Buffer.from(encryptPayload(payload, TOKEN), "base64");
    buf[15] ^= 0x01; // auth tag is bytes 12..27
    assert.throws(() => decryptPayload(buf.toString("base64"), TOKEN));
});

test("truncating the payload throws (length < iv+authTag)", () => {
    const short = Buffer.alloc(20, 0x41).toString("base64"); // 20 < 28
    assert.throws(() => decryptPayload(short, TOKEN), /Invalid payload length/);
});

test("empty-string payload throws", () => {
    assert.throws(() => decryptPayload("", TOKEN));
});

// ── Wrong token ────────────────────────────────────────────
console.log("\n── Wrong-token rejection ──");
test("decrypt with the wrong token throws", () => {
    const payload = Buffer.from("secret message", "utf8");
    const ct = encryptPayload(payload, TOKEN);
    assert.throws(() => decryptPayload(ct, "wrong-token"));
});

// ── Wire format structure ──────────────────────────────────
console.log("\n── Wire format (matches index.js / api.ts) ──");
test("output is base64 of iv(12) + authTag(16) + ciphertext", () => {
    const payload = Buffer.from("abc", "utf8");
    const buf = Buffer.from(encryptPayload(payload, TOKEN), "base64");
    assert.ok(buf.length >= 12 + 16 + payload.length, "too short for iv+tag+ct");
    // IV is the first 12 bytes; two encryptions must have different IVs.
    const iv1 = Buffer.from(encryptPayload(payload, TOKEN), "base64").subarray(0, 12);
    const iv2 = buf.subarray(0, 12);
    assert.ok(!iv1.equals(iv2), "IVs collided — randomness broken");
});

test("api.ts-style request body shape survives a round trip", () => {
    // This mirrors what api.ts sends and index.js expects: a JSON string
    // encrypted then wrapped as { encryptedPayload }.
    const body = JSON.stringify({ provider: "claude", text: "hi", sessionId: "" });
    const encryptedPayload = encryptPayload(Buffer.from(body, "utf8"), TOKEN);
    const wire = JSON.stringify({ encryptedPayload });
    const parsed = JSON.parse(wire);
    assert.ok(typeof parsed.encryptedPayload === "string");
    const decrypted = decryptPayload(parsed.encryptedPayload, TOKEN);
    assert.deepEqual(JSON.parse(text(decrypted)), { provider: "claude", text: "hi", sessionId: "" });
});

await testAsync("many round trips under load stay correct", async () => {
    for (let i = 0; i < 200; i++) {
        const payload = Buffer.from(`msg-${i}-${Math.random()}`, "utf8");
        const pt = decryptPayload(encryptPayload(payload, TOKEN), TOKEN);
        if (!pt.equals(payload)) throw new Error(`mismatch at i=${i}`);
    }
    await Promise.resolve();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
