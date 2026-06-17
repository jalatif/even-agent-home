import { spawn } from "node:child_process";
import { getExposeProvider } from "./registry.js";
import { printQRCode, rawLog } from "../startup/common.js";
function redactPairingUrl(url) {
    return String(url).replace(/([?&]token=)[^&]+/i, "$1[redacted]");
}
function getSelectedExposeProviderName() {
    return process.env.EVEN_TERMINAL_EXPOSE_PROVIDER;
}
function getProviderProgramPathEnvName(provider) {
    return provider.name.toUpperCase() + "_PROGRAM_PATH";
}
function getProviderProgram(provider) {
    return process.env[getProviderProgramPathEnvName(provider)] || provider.program;
}
function attachCleanup(child) {
    const cleanup = () => {
        if (!child.killed)
            child.kill();
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
    });
}
export function startExposeProvider(port, token) {
    const providerName = getSelectedExposeProviderName();
    if (!providerName)
        return;
    const provider = getExposeProvider(providerName);
    if (!provider) {
        console.error(`error: unknown expose provider "${providerName}"`);
        process.exit(1);
    }
    const program = getProviderProgram(provider);
    const programPathEnvName = getProviderProgramPathEnvName(provider);
    const child = spawn(program, provider.buildArgs(port), {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.env.SHELL || process.env.ComSpec || "sh",
    });
    let foundUrl = false;
    let buffer = "";
    const handleOutput = (chunk) => {
        buffer += chunk.toString();
        const parsedUrl = provider.parseUrl(buffer);
        if (!parsedUrl || foundUrl)
            return;
        foundUrl = true;
        const fullUrl = `${parsedUrl}?token=${token}`;
        rawLog("");
        rawLog(`  Public expose (${provider.name}):  ${parsedUrl}`);
        rawLog("");
        rawLog(`  ${redactPairingUrl(fullUrl)}`);
        printQRCode(fullUrl, () => rawLog(""));
    };
    rawLog(`  Starting quick public expose via ${provider.name}...`);
    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("error", (err) => {
        console.error(`  Failed to start ${provider.name}: ${err.message}`);
        console.error(`  Checked program: ${program}`);
        console.error(`  Override with ${programPathEnvName}=... if needed.`);
    });
    child.on("exit", (code) => {
        if (code !== null && code !== 0 && !foundUrl) {
            console.error(`  ${provider.name} exited with code ${code}`);
        }
    });
    attachCleanup(child);
}
