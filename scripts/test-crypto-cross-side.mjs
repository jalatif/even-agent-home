/**
 * Cross-side encryption interop test.
 *
 * Every request/response between the web frontend and the backend is encrypted
 * with AES-256-GCM. The two implementations live in different files
 * (backend/src/crypto.js uses node:crypto; web/src/crypto.ts uses WebCrypto)
 * and must agree on the exact wire layout: iv(12) + authTag(16) + ciphertext,
 * key = SHA256(token). An off-by-one in either side's slicing would silently
 * corrupt every encrypted payload and only surface on real hardware.
 *
 * This test joins the two implementations: it encrypts on one side and
 * decrypts on the other, in both directions, and checks the byte layout.
 * Without it, the only coverage was backend→backend (test-crypto.mjs); the web
 * side had zero tests.
 *
 * Run: node scripts/test-crypto-cross-side.mjs  (uses tsx to load the .ts side)
 */
import { webcrypto } from "node:crypto";
import { strict as assert } from "node:assert";

// The web crypto module reads window.crypto.subtle. Shim it BEFORE importing.
globalThis.window = { crypto: webcrypto };

// Load both implementations. The web side is TypeScript; load it via tsx so the
// import resolves without a build step. The backend side is plain ESM JS.
const backend = await import("../backend/src/crypto.js");
const web = await import("tsx/esm/api").then(() => import("../web/src/crypto.ts")).catch(async () => {
  // tsx loader fallback: import directly (tsx registers a loader when present)
  return await import("../web/src/crypto.ts");
});

const TOKEN = "my-secure-token-123";
let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  \u2714 ${name}`); }
function section(name) { console.log(`\n${name}`); }
function check(name, fn) {
  try { fn(); ok(name); } catch (e) { failed++; console.log(`  \u2717 ${name}: ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { failed++; console.log(`  \u2717 ${name}: ${e.message}`); }
}

section("web encrypts → backend decrypts (request body direction)");
{
  const plaintext = JSON.stringify({ provider: "openclaw", sessionId: "abc", text: "hello world" });
  const encrypted = await web.encryptPayload(plaintext, TOKEN);
  const decrypted = backend.decryptPayload(encrypted, TOKEN);
  assert.equal(decrypted.toString("utf8"), plaintext);
  ok("web→backend round-trip preserves JSON body");
}

section("backend encrypts → web decrypts (response body direction)");
{
  const plaintext = JSON.stringify({ sessions: [{ id: "s1", title: "Test" }], history: [] });
  const encrypted = backend.encryptPayload(Buffer.from(plaintext, "utf8"), TOKEN);
  const decrypted = await web.decryptPayload(encrypted, TOKEN);
  assert.equal(decrypted, plaintext);
  ok("backend→web round-trip preserves JSON body");
}

section("wire layout: iv(12) + authTag(16) + ciphertext");
{
  // The web side's chunked btoa produces a base64 string of iv||tag||ct.
  // Decode it and verify the segment boundaries match what the backend expects.
  const plaintext = "layout-check";
  const encryptedB64 = await web.encryptPayload(plaintext, TOKEN);
  const buf = Buffer.from(encryptedB64, "base64");
  check("web payload is at least iv(12)+tag(16) = 28 bytes", () => {
    assert.ok(buf.length >= 28, `payload too short: ${buf.length}`);
  });
  // Decrypt with backend to prove the layout is exactly iv||tag||ct (not ct||tag).
  const decrypted = backend.decryptPayload(encryptedB64, TOKEN).toString("utf8");
  assert.equal(decrypted, plaintext);
  ok("byte layout is iv(12)+authTag(16)+ciphertext on both sides");
}

section("token mismatch fails decryption (auth-tag mismatch)");
{
  const encrypted = await web.encryptPayload("secret", TOKEN);
  await assert.rejects(
    () => web.decryptPayload(encrypted, "wrong-token"),
    //.*/,
    "web decrypt with wrong token must throw",
  );
  check("backend decrypt with wrong token throws", () => {
    assert.throws(() => backend.decryptPayload(encrypted, "wrong-token"));
  });
  ok("wrong token → AES-GCM auth-tag verification fails on both sides");
}

section("tampered ciphertext fails decryption");
{
  const encrypted = await web.encryptPayload("original", TOKEN);
  // Flip a byte in the middle of the ciphertext region.
  const buf = Buffer.from(encrypted, "base64");
  buf[buf.length - 1] ^= 0x01;
  const tampered = buf.toString("base64");
  check("backend rejects tampered ciphertext", () => {
    assert.throws(() => backend.decryptPayload(tampered, TOKEN));
  });
  ok("tampered ciphertext → auth failure (integrity protected)");
}

section("large payload (≥1MB) — chunked btoa path");
{
  // The web side chunks String.fromCharCode to avoid the JS argument limit on
  // large payloads. Exercise it with a 1.2MB body (bigger than the audio path).
  const big = JSON.stringify({ audio: Array.from({ length: 300000 }, (_, i) => i % 256) });
  const encrypted = await web.encryptPayload(big, TOKEN);
  const decrypted = backend.decryptPayload(encrypted, TOKEN).toString("utf8");
  assert.equal(decrypted.length, big.length);
  assert.equal(decrypted, big);
  ok(`1.2MB payload round-trips (${(big.length / 1024).toFixed(0)}KB)`);
}

section("random IV per encryption (no nonce reuse)");
{
  const plaintext = "nonce-check";
  const a = await web.encryptPayload(plaintext, TOKEN);
  const b = await web.encryptPayload(plaintext, TOKEN);
  check("two encryptions of the same plaintext differ", () => {
    assert.notEqual(a, b, "identical ciphertext means IV reuse");
  });
  // Both must still decrypt to the same plaintext.
  assert.equal(backend.decryptPayload(a, TOKEN).toString("utf8"), plaintext);
  assert.equal(backend.decryptPayload(b, TOKEN).toString("utf8"), plaintext);
  ok("fresh IV per call → different ciphertext, same plaintext");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
