/**
 * Session-list contract checks for every Agent Home provider.
 *
 * This is intentionally route-level: the pi regression came from the
 * combination of `/api/sessions` defaulting to PROJECT_DIR and provider cwd
 * lookup missing legacy session-directory encodings. Testing only provider
 * internals would not catch that integration failure.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";

const PORT = Number(process.env.SESSION_LIST_TEST_PORT || 3491);
const URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "session-list-contract-token";
const CURRENT_CWD = process.cwd();

const PROVIDERS = [
  "claude",
  "codex",
  "opencode",
  "antigravity",
  "oh-my-pi",
  "pi",
  "hermes",
];

// Providers whose persisted session stores support meaningful cwd filtering.
// opencode and hermes do not expose cwd on their list backends in this app.
const CWD_FILTER_PROVIDERS = new Set([
  "claude",
  "codex",
  "antigravity",
  "oh-my-pi",
  "pi",
]);

function apiGet(path) {
  return fetch(`${URL}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-AgentHome-Auth": TOKEN,
    },
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${path} returned ${res.status}: ${body.error || res.statusText}`);
    }
    return body;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeOf(session) {
  const t = new Date(session.timestamp || 0).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function assertValidSession(provider, session) {
  assert.equal(typeof session.id, "string", `${provider}: session id must be string`);
  assert.ok(session.id.trim(), `${provider}: session id must be non-empty`);
  assert.equal(session.provider, provider, `${provider}: session.provider must match agent`);
  assert.equal(typeof session.timestamp, "string", `${provider}: timestamp must be string`);
  assert.ok(Number.isFinite(timeOf(session)), `${provider}: timestamp must parse`);
}

function assertSortedNewestFirst(provider, sessions) {
  for (let i = 1; i < sessions.length; i += 1) {
    const prev = timeOf(sessions[i - 1]);
    const current = timeOf(sessions[i]);
    assert.ok(
      prev >= current,
      `${provider}: sessions must be newest first (${sessions[i - 1].timestamp} before ${sessions[i].timestamp})`,
    );
  }
}

async function waitForBackend() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${URL}/api/agents`, {
        headers: { "X-AgentHome-Auth": TOKEN },
      });
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("backend did not start");
}

console.log(`[session-list] Starting backend on ${URL}`);
const proc = spawn(
  "node",
  ["bin/even-agent-home.js", "--token", TOKEN, "--host", "127.0.0.1", "--port", String(PORT)],
  {
    cwd: "backend",
    env: { ...process.env, TEST_MODE: "1", PORT: String(PORT) },
    stdio: "ignore",
  },
);

let passed = 0;
let skipped = 0;
let failed = 0;

try {
  await waitForBackend();

  for (const provider of PROVIDERS) {
    console.log(`\n─── ${provider} ───`);

    try {
      const allRes = await apiGet(`/api/sessions?agent=${encodeURIComponent(provider)}&limit=20`);
      const allSessions = allRes.sessions || [];
      assert.ok(Array.isArray(allSessions), `${provider}: sessions response must be an array`);
      assert.ok(allSessions.length <= 20, `${provider}: default list must honor limit`);

      for (const session of allSessions) assertValidSession(provider, session);
      assertSortedNewestFirst(provider, allSessions);
      console.log(`  ✓ global list: ${allSessions.length} sessions, valid and sorted`);
      passed += 1;

      const limitRes = await apiGet(`/api/sessions?agent=${encodeURIComponent(provider)}&limit=3`);
      const limitedSessions = limitRes.sessions || [];
      assert.ok(limitedSessions.length <= 3, `${provider}: smaller limit must be honored`);
      assert.deepEqual(
        limitedSessions.map((s) => s.id),
        allSessions.slice(0, 3).map((s) => s.id),
        `${provider}: limit=3 must return the first 3 globally sorted sessions`,
      );
      console.log("  ✓ limit=3 keeps newest-first prefix");
      passed += 1;

      if (!CWD_FILTER_PROVIDERS.has(provider)) {
        console.log("  - cwd filter not supported by this provider store");
        skipped += 1;
        continue;
      }

      const expectedForCwd = allSessions.filter((s) => s.cwd === CURRENT_CWD);
      const cwdRes = await apiGet(
        `/api/sessions?agent=${encodeURIComponent(provider)}&cwd=${encodeURIComponent(CURRENT_CWD)}&limit=20`,
      );
      const cwdSessions = cwdRes.sessions || [];
      assert.ok(Array.isArray(cwdSessions), `${provider}: cwd sessions response must be an array`);
      assert.ok(cwdSessions.length <= 20, `${provider}: cwd list must honor limit`);
      for (const session of cwdSessions) {
        assertValidSession(provider, session);
        assert.equal(session.cwd, CURRENT_CWD, `${provider}: cwd-filtered session must match requested cwd`);
      }
      assertSortedNewestFirst(provider, cwdSessions);

      if (expectedForCwd.length > 0) {
        assert.ok(
          cwdSessions.some((s) => s.id === expectedForCwd[0].id),
          `${provider}: cwd list must include newest global session for current cwd`,
        );
        console.log(`  ✓ cwd list: includes newest current-cwd session ${expectedForCwd[0].id}`);
        passed += 1;
      } else {
        console.log("  - cwd list: no current-cwd sessions in global list to cross-check");
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${err.message}`);
    }
  }
} finally {
  proc.kill();
}

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
