/**
 * Tier 3 — bespoke provider module hook.
 *
 * For CLIs/tools that a declarative config cannot describe (background daemons
 * that need polling, session discovery by filesystem mtime, SQLite session
 * stores, batched non-streaming output, custom markup, … — see the built-in
 * `opencode` and `antigravity` providers for examples). The user writes a small
 * ES module that implements the provider contract and points `module:` at it.
 *
 * The module MUST export `createProvider(emit, options)` returning the standard
 * provider object (the same 10-method surface every built-in provider returns).
 * This wrapper dynamically `import()`s it, calls the factory, and validates the
 * returned object has the required methods.
 *
 * `import()` is async, but `providerFactories` factories are called lazily by
 * `getProviderInstance` (core.js) and memoized. To keep that call site simple
 * and synchronous, this factory loads the module eagerly (await on first call)
 * and returns the resolved provider instance.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const REQUIRED_METHODS = ["prompt", "listSessions", "getHistory", "getStatus", "interrupt"];

export async function createModuleProvider(config, emit) {
    const modulePath = resolve(config.module);
    const options = config.options || {};
    const name = config.name;

    let mod;
    try {
        mod = await import(pathToFileURL(modulePath).href);
    } catch (err) {
        throw new Error(`Custom agent "${name}": failed to import module ${modulePath}: ${err.message}`);
    }

    const factory = mod.createProvider || mod.default;
    if (typeof factory !== "function") {
        throw new Error(
            `Custom agent "${name}": module ${modulePath} must export "createProvider(emit, options)" (a named export) or be a default-export function.`
        );
    }

    let provider;
    try {
        provider = factory(emit, options);
    } catch (err) {
        throw new Error(`Custom agent "${name}": createProvider() threw: ${err.message}`);
    }

    if (!provider || typeof provider !== "object") {
        throw new Error(`Custom agent "${name}": createProvider() must return a provider object.`);
    }

    // Validate the required surface so a half-implemented module fails loudly at
    // first use with a clear message rather than a confusing "not a function" later.
    const missing = REQUIRED_METHODS.filter((m) => typeof provider[m] !== "function");
    if (missing.length) {
        throw new Error(
            `Custom agent "${name}": module's provider is missing required method(s): ${missing.join(", ")}. See docs/custom-agents-guide.md → Tier 3 for the contract.`
        );
    }

    // Backfill optional no-op stubs so core.js route handlers can call them freely.
    if (typeof provider.getSessionStatus !== "function") provider.getSessionStatus = () => "idle";
    if (typeof provider.getInfo !== "function") {
        provider.getInfo = () => ({ account: { email: name, organization: name }, model: name, version: "module", provider: name });
    }
    if (typeof provider.respondPermission !== "function") provider.respondPermission = () => {};
    if (typeof provider.respondQuestion !== "function") provider.respondQuestion = () => {};
    if (typeof provider.dispose !== "function") provider.dispose = () => {};

    return provider;
}
