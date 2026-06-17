import { createWriteStream } from "node:fs";
import { format } from "node:util";
const methods = ["log", "info", "warn", "error", "debug"];
let installed = false;
let fileStream = null;
function ts() {
    return new Date().toLocaleString("sv");
}
function getLogFilePath() {
    const i = process.argv.indexOf("--log-file");
    return i >= 0 ? process.argv[i + 1] : undefined;
}
/** Write directly to log file only (bypass console). Used by debugLog to
 *  always capture verbose output in the log file regardless of VERBOSE flag. */
export function writeToLogFile(...args) {
    if (fileStream)
        fileStream.write(format(`[${ts()}]`, ...args) + "\n");
}
/** Monkey-patch console.* to prepend an ISO timestamp. If --log-file is on
 *  argv, also tee every line to that file. */
export function installTimestampLogging() {
    if (installed)
        return;
    installed = true;
    const logFile = getLogFilePath();
    if (logFile) {
        try {
            fileStream = createWriteStream(logFile, { flags: "a" });
            console.log(`[server] Logging to ${logFile}`);
        }
        catch (err) {
            console.error(`error: failed to open log file ${logFile}: ${err.message}`);
        }
    }
    for (const m of methods) {
        const orig = console[m].bind(console);
        console[m] = (...args) => {
            const stamp = `[${ts()}]`;
            orig(stamp, ...args);
            if (fileStream)
                fileStream.write(format(stamp, ...args) + "\n");
        };
    }
}
