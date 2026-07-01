/**
 * Unit tests for the custom-agent config loader + seeder
 * (backend/src/providers/loader.js).
 *
 * The CRITICAL test here is the zero-config guarantee: with seeding enabled and
 * no user config, the loader must seed its template (which parses to []) and
 * return ZERO agents — proving built-ins are never affected by the loader's
 * mere presence. This is the regression guard for requirement #1.
 *
 * All tests run in an isolated temp HOME so ~/.agent-home is never touched.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test builds a fresh temp HOME and sets it before importing the loader,
// because the loader reads os.homedir() at call time (good — we can reuse one
// import but point HOME at a fresh dir per test). We import lazily inside a
// helper so env is set first.

function freshHome() {
    const home = mkdtempSync(join(tmpdir(), "agent-loader-"));
    process.env.HOME = home;
    // On macOS os.homedir() derives from the passwd entry, not $HOME, when
    // $HOME is unset — but when $HOME IS set it's respected. Force it.
    return home;
}

async function loadLoader() {
    // Re-import fresh each time so module-level state (none currently, but
    // defensive) doesn't bleed across tests. Node caches ESM modules by URL,
    // but the loader reads env/home at call time, so a shared import is fine.
    return import("../backend/src/providers/loader.js");
}

function setConfig(home, content) {
    const dir = join(home, ".agent-home");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agents.yaml"), content, "utf8");
}

test("zero-config: seeds template + returns 0 agents (requirement #1)", async () => {
    const home = freshHome();
    delete process.env.AGENTHOME_AGENTS_NO_SEED;
    const { loadCustomAgentConfigs } = await loadLoader();

    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 0, "fresh seed must yield zero agents");
    assert.ok(existsSync(join(home, ".agent-home", "agents.yaml")), "agents.yaml must be seeded");
    assert.ok(existsSync(join(home, ".agent-home", "README.md")), "README.md must be seeded");

    // The seeded README must be the real guide, not the tiny fallback.
    const readme = readFileSync(join(home, ".agent-home", "README.md"), "utf8");
    assert.match(readme, /Custom Agents Guide/, "seeded README must be the full guide");
});

test("zero-config: AGENTHOME_AGENTS_NO_SEED=1 writes nothing", async () => {
    const home = freshHome();
    process.env.AGENTHOME_AGENTS_NO_SEED = "1";
    const { loadCustomAgentConfigs } = await loadLoader();

    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 0);
    assert.ok(!existsSync(join(home, ".agent-home")), "no files must be written when seeding disabled");
    delete process.env.AGENTHOME_AGENTS_NO_SEED;
});

test("idempotent: seeding does not clobber an existing config", async () => {
    const home = freshHome();
    const { loadCustomAgentConfigs } = await loadLoader();
    // Pre-write a real config the user authored.
    setConfig(home, "agents:\n  - name: mine\n    type: gateway\n    gatewayUrl: http://h:1\n    model: m\n");

    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 1);
    assert.equal(cfgs[0].name, "mine");
    // The user's file must be unchanged (not overwritten by the template).
    const after = readFileSync(join(home, ".agent-home", "agents.yaml"), "utf8");
    assert.match(after, /name: mine/);
    assert.doesNotMatch(after, /Add your own agents here/);
});

test("loads a valid Tier 1 (gateway) entry", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: ollama-local
    type: gateway
    gatewayUrl: http://127.0.0.1:11434
    model: llama3.1
    models: [llama3.1, qwen2.5]
`);
    const { loadCustomAgentConfigs } = await loadLoader();
    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 1);
    assert.equal(cfgs[0].type, "gateway");
    assert.equal(cfgs[0].gatewayUrl, "http://127.0.0.1:11434");
    assert.deepEqual(cfgs[0].models, ["llama3.1", "qwen2.5"]);
    assert.equal(cfgs[0].binGate, null);
});

test("loads a valid Tier 2 (cli) entry with events map", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: my-cli
    type: cli
    bin: mycli
    args: ["-p", "{{text}}"]
    sessionFlag: ["--session", "{{sessionId}}"]
    model: m1
    events:
      sessionId: "session.id"
      textDelta: { type: "message_update", value: "assistantMessageEvent.delta" }
      resultMarkers: [turn_end]
`);
    const { loadCustomAgentConfigs } = await loadLoader();
    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 1);
    assert.equal(cfgs[0].type, "cli");
    assert.equal(cfgs[0].bin, "mycli");
    assert.deepEqual(cfgs[0].args, ["-p", "{{text}}"]);
    assert.equal(cfgs[0].events.textDelta.type, "message_update");
    assert.deepEqual(cfgs[0].events.resultMarkers, ["turn_end"]);
});

test("loads a valid Tier 3 (module) entry", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: my-mod
    type: module
    module: /abs/path/to/provider.js
    options: { pollMs: 2000 }
`);
    const { loadCustomAgentConfigs } = await loadLoader();
    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 1);
    assert.equal(cfgs[0].type, "module");
    assert.equal(cfgs[0].module, "/abs/path/to/provider.js");
    assert.equal(cfgs[0].options.pollMs, 2000);
});

test("skips an entry whose name collides with a built-in", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: pi
    type: gateway
    gatewayUrl: http://h:1
    model: m
  - name: real-custom
    type: gateway
    gatewayUrl: http://h:2
    model: m
`);
    const { loadCustomAgentConfigs, getBuiltinAgentNames } = await loadLoader();
    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 1, "colliding entry skipped, valid one kept");
    assert.equal(cfgs[0].name, "real-custom");
    assert.ok(getBuiltinAgentNames().has("pi"));
});

test("skips an entry with an invalid name", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: Bad Name With Spaces
    type: gateway
    gatewayUrl: http://h:1
    model: m
`);
    const { loadCustomAgentConfigs } = await loadLoader();
    assert.equal(loadCustomAgentConfigs().length, 0);
});

test("skips a gateway entry missing required fields", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: no-url
    type: gateway
    model: m
  - name: bad-url
    type: gateway
    gatewayUrl: not-a-url
    model: m
  - name: no-model
    type: gateway
    gatewayUrl: http://h:1
`);
    const { loadCustomAgentConfigs } = await loadLoader();
    assert.equal(loadCustomAgentConfigs().length, 0, "all three invalid entries skipped");
});

test("skips a cli entry missing args or events", async () => {
    const home = freshHome();
    setConfig(home, `
agents:
  - name: no-args
    type: cli
    bin: m
    events: { resultMarkers: [x] }
  - name: no-events
    type: cli
    bin: m
    args: ["{{text}}"]
`);
    const { loadCustomAgentConfigs } = await loadLoader();
    assert.equal(loadCustomAgentConfigs().length, 0);
});

test("bad YAML parses to [] (fail-soft, never throws)", async () => {
    const home = freshHome();
    setConfig(home, "agents: [this is : : not valid yaml ::::");
    const { loadCustomAgentConfigs } = await loadLoader();
    assert.equal(loadCustomAgentConfigs().length, 0);
});

test("JSON config via $AGENTHOME_AGENTS_CONFIG works", async () => {
    const home = freshHome();
    const dir = join(home, "configs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agents.json"), JSON.stringify({
        agents: [{ name: "j", type: "gateway", gatewayUrl: "http://h:1", model: "m" }],
    }));
    process.env.AGENTHOME_AGENTS_CONFIG = join(dir, "agents.json");
    const { loadCustomAgentConfigs } = await loadLoader();
    const cfgs = loadCustomAgentConfigs();
    assert.equal(cfgs.length, 1);
    assert.equal(cfgs[0].name, "j");
    delete process.env.AGENTHOME_AGENTS_CONFIG;
});

test("factoryForType dispatches by type", async () => {
    const { factoryForType } = await loadLoader();
    const emit = () => {};
    const gw = factoryForType({ name: "g", type: "gateway", gatewayUrl: "http://h:1", model: "m" }, emit);
    const cli = factoryForType({ name: "c", type: "cli", bin: "x", args: ["{{text}}"], events: {} }, emit);
    const modFactory = factoryForType({ name: "mo", type: "module", module: "/nonexistent/x.js" }, emit);
    assert.equal(typeof gw, "function");
    assert.equal(typeof cli, "function");
    assert.equal(typeof modFactory, "function");
    // gateway + cli are sync factories yielding a provider directly.
    assert.ok(gw() && typeof gw().prompt === "function", "gateway factory yields a provider");
    assert.ok(cli() && typeof cli().prompt === "function", "cli factory yields a provider");
    // module factory is async (dynamic import) and rejects for a missing file.
    // Call it ONCE and await the rejection so no unhandled rejection leaks.
    const modPromise = modFactory();
    assert.ok(modPromise instanceof Promise, "module factory returns a Promise");
    await assert.rejects(() => modPromise, /failed to import module/);
});
