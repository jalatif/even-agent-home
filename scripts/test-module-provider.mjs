/**
 * Integration test for the Tier 3 module-provider hook
 * (backend/src/providers/module.js).
 *
 * Points a `type: module` config at a fixture JS module that exports
 * `createProvider(emit, options)`, and asserts:
 *   - the dynamic import succeeds and the factory is called
 *   - the returned provider's prompt streams deltas + result
 *   - the wrapper backfills the optional no-op methods
 *   - a module missing createProvider is rejected with a clear message
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createModuleProvider } from "../backend/src/providers/module.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOOD_MODULE = join(here, "fixtures", "mock-module-provider.mjs");

test("module: imports, calls factory, streams deltas + result", async () => {
    const events = [];
    const emit = (sid, msg) => events.push(msg);
    const cfg = { name: "mock-module-agent", type: "module", module: GOOD_MODULE, options: { name: "mock-module-agent" } };

    const provider = await createModuleProvider(cfg, emit);
    const result = await provider.prompt("s1", "hi", "/tmp");

    assert.equal(result.provider, "mock-module-agent");
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text);
    assert.deepEqual(deltas, ["mock ", "reply"]);
    const resultEv = events.find((e) => e.type === "result");
    assert.equal(resultEv.success, true);
    assert.equal(resultEv.text, "mock reply");
});

test("module: wrapper backfills optional no-op methods", async () => {
    // The fixture deliberately omits respondPermission/respondQuestion/getInfo/
    // getSessionStatus. The wrapper must add no-op stubs so core.js can call them.
    const provider = await createModuleProvider(
        { name: "m", type: "module", module: GOOD_MODULE },
        () => {}
    );
    assert.equal(typeof provider.respondPermission, "function");
    assert.equal(typeof provider.respondQuestion, "function");
    assert.equal(typeof provider.getInfo, "function");
    assert.equal(typeof provider.getSessionStatus, "function");
    assert.equal(provider.getSessionStatus("any"), "idle");
    assert.doesNotThrow(() => provider.respondPermission("s", "yes"));
    assert.doesNotThrow(() => provider.dispose());
    const info = provider.getInfo();
    assert.equal(info.provider, "m");
});

test("module: missing createProvider export is rejected", async () => {
    // Use this very test file as the "module" — it has no createProvider export.
    const selfPath = fileURLToPath(import.meta.url);
    const cfg = { name: "bad", type: "module", module: selfPath };
    await assert.rejects(
        () => createModuleProvider(cfg, () => {}),
        /must export "createProvider\(emit, options\)"/
    );
});

test("module: provider missing a required method is rejected", async () => {
    // A fixture shape that returns an incomplete provider. Build it inline via
    // a data: URL so we don't need another fixture file.
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mod-incomplete-"));
    const file = join(dir, "incomplete.mjs");
    writeFileSync(file, `export function createProvider(emit, options){ return { prompt(){} }; }\n`);
    const cfg = { name: "incomplete", type: "module", module: file };
    await assert.rejects(
        () => createModuleProvider(cfg, () => {}),
        /missing required method/
    );
});

test("module: nonexistent module path is rejected", async () => {
    const cfg = { name: "missing", type: "module", module: "/nonexistent/path/to/provider.js" };
    await assert.rejects(
        () => createModuleProvider(cfg, () => {}),
        /failed to import module/
    );
});
