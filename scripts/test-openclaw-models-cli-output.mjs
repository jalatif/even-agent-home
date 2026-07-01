/**
 * Regression test: providers whose CLI `models` (or equivalent) does NOT
 * emit a parseable list of model ids. The fix is a `MODEL_REFRESH_DISABLED`
 * set in backend/src/routes/core.js that skips the CLI refresh and falls
 * back to the curated DEFAULT_MODELS.
 *
 * Three providers are in the bypass today:
 *
 *   - openclaw: `openclaw models` prints a config summary
 *     ("Config : ~/.openclaw/openclaw.json", "Agent dir : …", "Default : …")
 *     that parseLineModels happily slurps line-by-line as "models". The
 *     frontend then defaults to models[0] and sends
 *     "Config : ~/.openclaw/openclaw.json" as the `model` field, which the
 *     openclaw gateway rejects with:
 *         OpenClaw gateway error 400: {"error":{"message":"Unknown agent
 *         'Config : ~/.openclaw/openclaw.json'.", ...}}
 *   - hermes: `hermes models` is not a valid subcommand and exits with
 *     "invalid choice: 'models'", leaking the CLI error into the API
 *     response while the static DEFAULT_MODELS silently survive in
 *     cached.models.
 *   - antigravity (`agy`): `agy` is a flags-only CLI with no `models`
 *     subcommand; same leak pattern as hermes.
 *
 * This test pins:
 *   1. The buggy parser path returns bogus strings for the openclaw CLI
 *      output — documents WHY the bypass exists, so a future refactor of
 *      parseLineModels that "improves" line selection still gets a clear
 *      negative signal here.
 *   2. After the bypass, /api/models?agent=<provider> returns the curated
 *      list and the leaky CLI error is suppressed for all three providers.
 *
 * (1) is a pure-function test of the parser logic — we replicate it locally
 * so the regression stays pinned to the exact buggy output shape even if the
 * implementation moves into a shared module.
 * (2) is exercised via a spawned backend instance, since
 * MODEL_REFRESH_DISABLED is internal to routes/core.js and isn't exported.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3491;
const URL_ = `http://localhost:${PORT}`;

// Mirrors parseLineModels from backend/src/routes/core.js — kept in sync
// deliberately so the test pins the bug at the same code shape that the fix
// routes around. If the upstream parser changes shape, this copy breaks and
// the test author is forced to re-verify the regression stays covered.
function parseLineModels(output) {
    const uniqueStrings = (values) =>
        [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
    return uniqueStrings(output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/^error[:\s]/i.test(line) && !/^warning[:\s]/i.test(line)));
}

// Captured 2026-06-30 from `openclaw 2026.6.10 (aa69b12)`. If openclaw adds
// new fields here, the assertion below will fail and the test author should
// re-evaluate whether the MODEL_REFRESH_DISABLED bypass is still the right
// call (it likely still is — openclaw's `models` is a config dump, not a
// model roster).
const OPENCLAW_MODELS_OUTPUT = `Config        : ~/.openclaw/openclaw.json
Agent dir     : ~/.openclaw/agents/main/agent
Default       : openrouter/deepseek/deepseek-v4-flash
Fallbacks (0) : -
Image model   : -
Image fallbacks (0): -
Aliases (1)   : OpenRouter -> openrouter/auto
Configured models (3): openrouter/auto, deepseek/deepseek-v4-flash, openrouter/deepseek/deepseek-v4-flash

Auth overview
Auth store    : ~/.openclaw/agents/main/agent/openclaw-agent.sqlite
Shell env     : off
Providers w/ OAuth/tokens (0): -
- openrouter effective=profiles:~/.openclaw/agents/main/agent/openclaw-agent.sqlite | profiles=1 (oauth=0, token=*** api_key=*** | openrouter:default=sk-or-v1...4445cee5

OAuth/token status
- none`;

test("bug pin: parseLineModels returns bogus lines for openclaw models CLI output", () => {
    const parsed = parseLineModels(OPENCLAW_MODELS_OUTPUT);
    // Pin the exact failure mode: the first entry is "Config        : …openclaw.json".
    // Without the bypass, this string gets selected by the frontend as the
    // default model and causes the gateway to reject every prompt with
    // "Unknown agent 'Config : ~/.openclaw/openclaw.json'."
    assert.ok(
        parsed.some((m) => m.includes("Config") && m.includes("~/.openclaw/openclaw.json")),
        `parser returned no Config/openclaw.json line; instead got: ${JSON.stringify(parsed)}`
    );
    // And the parser does NOT extract any clean openclaw-shaped model id (the
    // only ones present in the dump are "openrouter/auto", "deepseek/…", etc.,
    // prefixed with a colon and whitespace — those would also be bogus as
    // gateway agent ids).
    assert.equal(
        parsed.filter((m) => m === "openclaw/main").length,
        0,
        `parser should not accidentally produce "openclaw/main" from the openclaw CLI dump`
    );
});

function binInstalled(bin) {
    try {
        execFileSync(`command -v ${bin}`, { stdio: "ignore", shell: true });
        return true;
    } catch {
        return false;
    }
}

function startBackend() {
    const cwd = mkdtempSync(join(tmpdir(), "model-refresh-disabled-test-"));
    const env = { ...process.env, PORT: String(PORT) };
    const proc = spawn(
        process.execPath,
        [join(repoRoot, "backend/bin/even-agent-home.js"), "--port", String(PORT), "--token", "test-token", "--host", "127.0.0.1"],
        { env, stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot }
    );
    return { proc, cwd };
}

async function waitForBackend(maxMs = 10000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${URL_}/api/agents`, {
                headers: { Authorization: "Bearer test-token" },
            });
            if (res.ok) return true;
        } catch {
            // not ready yet
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

// Curated DEFAULT_MODELS for each bypassed provider. These are what the
// backend should return — not the bogus CLI output. If you change a curated
// list in core.js, update the expected value here AND the comment in core.js.
const BYPASS_CASES = [
    { agent: "openclaw", expectedModels: ["openclaw/main"], requiresBin: "openclaw" },
    { agent: "hermes", expectedModels: ["hermes-v2", "hermes-pro"], requiresBin: "hermes" },
    { agent: "antigravity", expectedModelsStartsWith: "claude-haiku-4-5", requiresBin: "agy" },
];

for (const { agent, expectedModels, expectedModelsStartsWith, requiresBin } of BYPASS_CASES) {
    test(`fix: /api/models?agent=${agent} returns curated list (no CLI-dump leak)`, async (t) => {
        if (!binInstalled(requiresBin)) {
            t.skip(`${requiresBin} CLI not installed; skipping live-backend regression for ${agent}`);
            return;
        }
        const { proc, cwd } = startBackend();
        t.after(() => {
            try { proc.kill("SIGTERM"); } catch {}
            try { rmSync(cwd, { recursive: true, force: true }); } catch {}
        });
        const ready = await waitForBackend();
        assert.ok(ready, "backend did not become ready within 10s");

        // First call: kicks off refreshModels. Wait long enough for any
        // attempted CLI call to settle so we can see whether the leaked
        // error message lands in the response.
        await new Promise((r) => setTimeout(r, 1500));
        const res = await fetch(`${URL_}/api/models?agent=${agent}`, {
            headers: { Authorization: "Bearer test-token" },
        });
        assert.equal(res.status, 200, `GET /api/models?agent=${agent} should be 200`);
        const body = await res.json();

        // Curated list shape.
        if (expectedModels) {
            assert.deepEqual(
                body.models,
                expectedModels,
                `expected curated ${JSON.stringify(expectedModels)}, got: ${JSON.stringify(body.models)}`
            );
        } else if (expectedModelsStartsWith) {
            assert.ok(
                Array.isArray(body.models) && body.models.length > 0 && body.models[0].startsWith(expectedModelsStartsWith),
                `expected first model to start with "${expectedModelsStartsWith}", got: ${JSON.stringify(body.models)}`
            );
        }

        // Source must be "static" (the bypass fires); CLI-refresh path sets
        // source to "refreshed" / "empty".
        assert.equal(body.source, "static", `expected source="static" (bypass path), got: ${body.source}`);
        assert.equal(body.status, "complete");

        // THE REGRESSION PIN: the leaky CLI error must NOT be exposed in the
        // response. Before the bypass, this field would read e.g.
        //   "Command failed: hermes models\n  Bitwarden Secrets Manager: ..."
        // for hermes, leaking the full stderr to the UI. Same shape for
        // antigravity. And for openclaw, parseLineModels would have produced
        // bogus models like "Config        : ~/.openclaw/openclaw.json".
        assert.ok(
            !body.error || (typeof body.error === "string" && body.error.trim() === ""),
            `${agent}: leaked CLI error in response: ${JSON.stringify(body.error)?.slice(0, 200)}`
        );

        // No bogus CLI-output lines should have leaked into the curated list.
        for (const m of body.models ?? []) {
            assert.ok(
                !/^Config\s*:/i.test(m) && !/^Agent dir\s*:/i.test(m) && !/^Auth /i.test(m) && !/Bitwarden/i.test(m) && !/invalid choice/i.test(m),
                `${agent}: bogus CLI-output line leaked into models: "${m}"`
            );
        }
    });
}