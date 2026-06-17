import { writeToLogFile } from "./logger.js";
export function debugLog(tag, ...args) {
    if (process.env.VERBOSE === "1") {
        console.log(`[${tag}]`, ...args);
    }
    else {
        writeToLogFile(`[${tag}]`, ...args);
    }
}
