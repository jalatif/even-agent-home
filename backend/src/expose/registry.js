import bore from "./providers/bore.js";
import pinggy from "./providers/pinggy.js";
const providers = [pinggy, bore];
function ensureValidExposeProviders(list) {
    for (const provider of list) {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(provider.name)) {
            console.error(`[expose] invalid provider name "${provider.name}". Provider names must start with a letter and then contain only letters or digits.`);
            process.exit(1);
        }
    }
}
ensureValidExposeProviders(providers);
export function getExposeProviders() {
    return providers.slice();
}
export function getExposeProviderNames() {
    return providers.map((provider) => provider.name);
}
export function getExposeProvider(name) {
    return providers.find((provider) => provider.name === name);
}
