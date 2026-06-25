import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";

const mainPort = parseInt(process.env.PORT || "3456", 10);
export const CODEX_APP_SERVER_PORT = parseInt(
    process.env.CODEX_APP_SERVER_PORT || (mainPort === 8765 ? "8766" : "8765"),
    10
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
function getShellOption() {
    return process.env.SHELL || process.env.ComSpec || "sh";
}
export function getLanAddress() {
    const nets = networkInterfaces();
    for (const ifaces of Object.values(nets)) {
        for (const iface of ifaces ?? []) {
            if (iface.family === "IPv4" && !iface.internal)
                return iface.address;
        }
    }
}
function getTailscaleIp() {
    const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/tailscale"];
    for (const bin of candidates) {
        try {
            const out = execSync(`${bin} ip -4`, {
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 3000,
                shell: getShellOption(),
            }).toString().trim();
            const first = out.split("\n")[0]?.trim();
            if (first) return first;
        } catch {}
    }
    return undefined;
}
function getInterfaceIp(name) {
    const ifaces = networkInterfaces()[name];
    if (!ifaces)
        return undefined;
    for (const iface of ifaces) {
        if (iface.family === "IPv4")
            return iface.address;
    }
    return undefined;
}
/** Resolve host based on EVEN_HOST_MODE / EVEN_HOST_INTERFACE; exits on failure. */
export function resolveHost() {
    const mode = process.env.EVEN_HOST_MODE;
    if (mode === "tailscale") {
        const ip = getTailscaleIp();
        if (!ip) {
            console.error("error: failed to get Tailscale IPv4 address (is `tailscale` installed and running?)");
            process.exit(1);
        }
        return { label: "Tailscale", address: ip };
    }
    if (mode === "interface") {
        const name = process.env.EVEN_HOST_INTERFACE ?? "";
        if (!name) {
            console.error("error: --interface requires a name");
            process.exit(1);
        }
        const ip = getInterfaceIp(name);
        if (!ip) {
            console.error(`error: failed to get IPv4 address for interface "${name}"`);
            process.exit(1);
        }
        return { label: name, address: ip };
    }
    return { label: "LAN", address: getLanAddress() ?? "" };
}
export function truncPath(p, max) {
    if (p.length <= max)
        return p;
    return "..." + p.slice(-(max - 3));
}
function detectColorLevel() {
    const { TERM, COLORTERM } = process.env;
    if (!process.stdout.isTTY)
        return "none";
    if (TERM === "dumb")
        return "none";
    if (COLORTERM === "truecolor" || COLORTERM === "24bit")
        return "truecolor";
    if (TERM && /-256(color)?$/i.test(TERM))
        return "ansi256";
    if (TERM && /color|xterm|screen|vt100|ansi|cygwin|linux/i.test(TERM))
        return "basic";
    return "none";
}
function wrapQrColors(code, level) {
    let bg;
    let fg;
    switch (level) {
        case "truecolor":
            bg = "\x1b[48;2;0;0;0m";
            fg = "\x1b[38;2;255;255;255m";
            break;
        case "ansi256":
            bg = "\x1b[48;5;16m";
            fg = "\x1b[38;5;231m";
            break;
        case "basic":
            bg = "\x1b[40m";
            fg = "\x1b[37m";
            break;
        case "none":
            return code;
    }
    const reset = "\x1b[0m";
    const lines = code.split("\n");
    while (lines.length && lines[0].trim() === "")
        lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "")
        lines.pop();
    return lines
        .map((line, i) => {
        const prefix = i === 0 && /^\u2584+$/.test(line) ? fg : `${bg}${fg}`;
        return `${prefix}${line}${reset}`;
    })
        .join("\n");
}
/** Write directly to stdout, bypassing the timestamp-patched console.log.
 *  Use this for visual output (banners, QR codes) that must not be prefixed. */
export function rawLog(msg = "") {
    process.stdout.write(msg + "\n");
}
function redactPairingUrl(url) {
    return String(url).replace(/([?&]token=)[^&]+/i, "$1[redacted]");
}
export function printQRCode(str, afterCb) {
    const level = detectColorLevel();
    qrcodeTerminal.generate(str, { small: true }, (code) => {
        rawLog(wrapQrColors(code, level));
        if (afterCb)
            afterCb();
    });
}
let codexAppServerProcess = null;
function isPortTakenError(text) {
    return /\bEADDRINUSE\b|address already in use|addrinuse/i.test(text);
}
function canBindLocalPort(port) {
    return new Promise((resolve) => {
        const server = createServer();
        let settled = false;
        const done = (available) => {
            if (settled)
                return;
            settled = true;
            server.close(() => resolve(available));
        };
        server.once("error", (err) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
                return;
            }
            console.error(`[codex] WARN: Failed to bind-check port ${port}: ${err.message}`);
            resolve(false);
        });
        server.once("listening", () => done(true));
        server.listen(port, "127.0.0.1");
    });
}
export async function startCodexAppServer() {
    const listenUrl = `ws://127.0.0.1:${CODEX_APP_SERVER_PORT}`;
    if (!(await canBindLocalPort(CODEX_APP_SERVER_PORT))) {
        // Port is in use — likely a leftover process from a previous
        // non-graceful shutdown. Try to identify and kill it so we
        // don't force the user to manually find and restart.
        try {
            const pidStr = execSync(`lsof -ti :${CODEX_APP_SERVER_PORT}`, { encoding: "utf8" }).trim();
            const pid = Number(pidStr.split('\n')[0]); // take first PID if multiple
            if (pid && !isNaN(pid)) {
                // Safety check: only kill if this is actually a codex app-server,
                // not some other process that happened to bind the port.
                let procName = "";
                try {
                    procName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf8" }).trim();
                } catch {}
                const isCodex = /codex|app-server/i.test(procName);
                if (isCodex) {
                    console.error(`[codex] Port ${CODEX_APP_SERVER_PORT} in use by PID ${pid} (${procName || "unknown"}). Reclaiming stale app-server…`);
                    try { process.kill(pid, "SIGTERM"); } catch {}
                    // Wait up to 2s for the port to release
                    for (let i = 0; i < 20; i++) {
                        await new Promise(r => setTimeout(r, 100));
                        if (await canBindLocalPort(CODEX_APP_SERVER_PORT)) break;
                    }
                    if (await canBindLocalPort(CODEX_APP_SERVER_PORT)) {
                        console.error(`[codex] Port ${CODEX_APP_SERVER_PORT} freed — continuing.`);
                    } else {
                        console.error(`[codex] Port ${CODEX_APP_SERVER_PORT} still in use after SIGTERM. Try SIGKILL.`);
                        try { process.kill(pid, "SIGKILL"); } catch {}
                        await new Promise(r => setTimeout(r, 500));
                    }
                } else {
                    console.error(`[codex] Port ${CODEX_APP_SERVER_PORT} in use by PID ${pid} (${procName || "unknown"}) — NOT a codex process. Will not reclaim.`);
                }
            }
        } catch (lsofErr) {
            // lsof failed — possibly no lsof on this system, or the process
            // holding the port is foreign. Fall through to the original error.
        }
        if (!(await canBindLocalPort(CODEX_APP_SERVER_PORT))) {
            console.error(`[codex] ERROR: Port ${CODEX_APP_SERVER_PORT} appears to be in use. Set CODEX_APP_SERVER_PORT to another port and restart.`);
            console.error(`[codex] ERROR: Codex app-server was not started.`);
            return false;
        }
    }
    return new Promise((resolve) => {
        let resolved = false;
        let started = false;
        const done = () => { if (!resolved) {
            resolved = true;
            resolve(started);
        } };
        let stderrText = "";
        let printedPortHint = false;
        const printPortHint = (text) => {
            if (printedPortHint || !isPortTakenError(text))
                return;
            printedPortHint = true;
            console.error(`[codex] ERROR: Port ${CODEX_APP_SERVER_PORT} appears to be in use. Set CODEX_APP_SERVER_PORT to another port and restart.`);
        };
        let child;
        try {
            const shellOpt = getShellOption();
            child = spawn(`codex app-server --listen ${listenUrl}`, {
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                shell: shellOpt,
            });
        }
        catch (err) {
            console.error(`[codex] ERROR: Failed to spawn codex app-server: ${err.message}`);
            console.error(`[codex] ERROR: Codex provider will not work in this environment.`);
            done();
            return;
        }
        child.on("error", (err) => {
            console.error(`[codex] ERROR: Failed to start codex app-server: ${err.message}`);
            printPortHint(err.message);
            console.error(`[codex] ERROR: Codex provider will not work in this environment.`);
            codexAppServerProcess = null;
            done();
        });
        child.on("close", (code) => {
            if (code !== null && code !== 0) {
                console.error(`[codex] ERROR: codex app-server exited with code ${code}`);
                printPortHint(stderrText);
            }
            codexAppServerProcess = null;
            done();
        });
        child.stderr?.on("data", (data) => {
            const text = data.toString().trim();
            if (text) {
                stderrText += `${text}\n`;
                if (process.env.DEBUG === "1") {
                    console.log(`[codex-app-server] ${text}`);
                }
                printPortHint(text);
                // app-server prints "listening on:" to stderr when ready
                if (text.includes("listening on:")) {
                    started = true;
                    done();
                }
            }
        });
        child.stdout?.on("data", (data) => {
            const text = data.toString().trim();
            if (text && process.env.DEBUG === "1") {
                console.log(`[codex-app-server] ${text}`);
            }
        });
        codexAppServerProcess = child;
        if (process.env.DEBUG === "1") {
            console.log(`[codex] app-server starting on ${listenUrl}`);
        }
        // Fallback timeout in case we miss the ready signal
        setTimeout(done, 5000);
    });
}
export function stopCodexAppServer() {
    if (codexAppServerProcess) {
        codexAppServerProcess.kill();
        codexAppServerProcess = null;
    }
}
export function printServerBanner(port, token, cwd, printQr) {
    const host = resolveHost();
    const name = process.env.EVEN_TERMINAL_NAME ?? "";
    const labelWidth = Math.max("Local".length, "Token".length, "Name".length, "CWD".length, host.label.length);
    const pad = (s) => s.padEnd(labelWidth);
    const logo = [
        "   ██████   ",
        "  ██    ██  ",
        "  ████████  ",
        "  ██    ██  ",
        "  ██    ██  ",
    ];
    const info = [
        `Agent Home v${pkg.version}`,
        name ? `${pad("Name")}:  ${name}` : "",
        `${pad("Local")}:  http://localhost:${port}`,
        host.address ? `${pad(host.label)}:  http://${host.address}:${port}` : "",
        `${pad("Token")}:  ${token.slice(0, 8)}...${token.slice(-4)}`,
        `${pad("CWD")}:  ${truncPath(cwd, 40)}`,
        "",
        "",
    ];
    const gap = "     ";
    rawLog("");
    for (let i = 0; i < Math.max(logo.length, info.length); i++) {
        const logoLine = (logo[i] ?? "").padEnd(12);
        rawLog(`  ${logoLine}${gap}${info[i] ?? ""}`);
    }
    rawLog("");
    rawLog("  Connect your AI agents to G2 glasses");
    rawLog("  " + "\u2500".repeat(61));
    rawLog("");
    const params = new URLSearchParams({ token });
    if (name)
        params.set("name", name);
    const address = host.address || "localhost";
    const url = `http://${address}:${port}?${params.toString()}`;
    if (printQr && host.address) {
        // Print the full connect URL (unredacted) so the user can copy-paste
        // it into Agent Home when the camera is unavailable and the QR
        // code in the terminal cannot be scanned.
        rawLog(`  Connect URL: ${url}`);
        printQRCode(url, () => rawLog(""));
    } else {
        // No QR (e.g. localhost-only or QR disabled) — still print the
        // connect URL so it is copyable.
        rawLog(`  Connect URL: ${url}`);
    }
}
