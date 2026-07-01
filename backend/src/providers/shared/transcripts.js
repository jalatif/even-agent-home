/**
 * Shared transcript (JSONL) helpers for custom-agent providers.
 *
 * Tier 2 (`type: cli`) custom agents that store per-session JSONL transcripts
 * on disk can reuse these to list sessions and read history, exactly like the
 * built-in `pi`/`oh-my-pi` providers. A custom agent is NOT required to use
 * on-disk transcripts (its `sessionsDir` is optional); these are only used when
 * `sessionsDir` is declared in the config.
 *
 * The directory-naming convention optionally mirrors omp/pi's
 * `getDefaultSessionDirName` (home → `-...`, temp → `-tmp-...`, else legacy
 * `--...--`) via the `cwdEncoder: omp-compat` config flag. Without it, sessions
 * live directly under `<sessionsDir>/*.jsonl` (flat).
 */
import { openSync, readSync, closeSync } from "node:fs";
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/** Resolve symlinks + macOS /private/* normalisation, matching omp's resolveEquivalentPath. */
function resolveEquivalentPath(inputPath) {
    const resolved = resolve(inputPath);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function pathIsWithin(root, candidate) {
    const r = relative(resolveEquivalentPath(root), resolveEquivalentPath(candidate));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function encodeLegacyAbsoluteSessionDirName(cwd) {
    const resolvedCwd = resolve(cwd);
    return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix, root, cwd) {
    const rel = relative(root, cwd).replace(/[/\\:]/g, "-");
    return rel ? (prefix.endsWith("-") ? `${prefix}${rel}` : `${prefix}-${rel}`) : prefix;
}

/**
 * Replicate omp's getDefaultSessionDirName when `encoder === "omp-compat"`:
 * home → `-...`, temp → `-tmp-...`, else legacy `--...--`.
 * Returns "" for no cwd (flat layout under sessionsDir).
 */
export function encodeCwd(cwd, encoder) {
    if (!cwd) return "";
    if (encoder !== "omp-compat") return "";
    const resolvedCwd = resolve(cwd);
    const canonicalCwd = resolveEquivalentPath(resolvedCwd);
    const home = resolveEquivalentPath(homedir());
    const tempRoot = resolveEquivalentPath(tmpdir());
    if (pathIsWithin(home, canonicalCwd)) {
        return encodeRelativeSessionDirName("-", home, canonicalCwd);
    }
    if (pathIsWithin(tempRoot, canonicalCwd)) {
        return encodeRelativeSessionDirName("-tmp", tempRoot, canonicalCwd);
    }
    return encodeLegacyAbsoluteSessionDirName(canonicalCwd);
}

/** Candidate subdirs to scan for a given cwd (the canonical one + legacy form). */
function candidateSubdirs(sessionsDir, cwd, encoder) {
    if (!cwd) return [sessionsDir];
    const encoded = [
        encodeCwd(cwd, encoder),
        encoder === "omp-compat" ? encodeLegacyAbsoluteSessionDirName(resolveEquivalentPath(cwd)) : null,
    ].filter(Boolean);
    return [...new Set(encoded)].map((e) => join(sessionsDir, e));
}

/** List session JSONL files. If cwd given, only that cwd's subdir(s); else all. */
export function listSessionFiles({ sessionsDir, cwd, encoder }) {
    if (!sessionsDir || !existsSync(sessionsDir)) return [];
    if (cwd) {
        const dirs = candidateSubdirs(sessionsDir, cwd, encoder);
        const files = [];
        for (const dir of dirs) {
            if (!existsSync(dir)) continue;
            try {
                if (!statSync(dir).isDirectory()) continue;
                files.push(...readdirSync(dir)
                    .filter((f) => f.endsWith(".jsonl"))
                    .map((f) => join(dir, f)));
            } catch {}
        }
        return files;
    }
    // flat: <sessionsDir>/*.jsonl
    try {
        return readdirSync(sessionsDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => join(sessionsDir, f));
    } catch {
        return [];
    }
}

/** Parse a whole .jsonl file into an array of JSON objects (skipping bad lines). */
export function readSessionJsonl(file) {
    try {
        const text = readFileSync(file, "utf8");
        const out = [];
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                out.push(JSON.parse(trimmed));
            } catch {}
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Read only the first JSON line of a .jsonl session file (the session header).
 * ~100x faster than reading the whole file when building session lists.
 */
export function readSessionHeader(file) {
    try {
        const buf = Buffer.alloc(4096);
        const fd = openSync(file, "r");
        const bytesRead = readSync(fd, buf, 0, 4096, 0);
        closeSync(fd);
        const firstNewline = buf.indexOf(10, 0); // '\n'
        const len = firstNewline >= 0 ? firstNewline : bytesRead;
        const line = buf.toString("utf8", 0, len).trim();
        if (!line) return null;
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** Read the first user text from a session JSONL (best-effort, first 32KB). */
export function firstUserMessageLine(file) {
    try {
        const buf = Buffer.alloc(32768);
        const fd = openSync(file, "r");
        const bytesRead = readSync(fd, buf, 0, 32768, 0);
        closeSync(fd);
        const text = buf.toString("utf8", 0, bytesRead);
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const e = JSON.parse(trimmed);
                const role = e.message?.role || e.role;
                if (role !== "user") continue;
                const content = e.message?.content ?? e.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block && typeof block.text === "string" && block.text.trim()) {
                            return block.text.trim();
                        }
                    }
                } else if (typeof content === "string" && content.trim()) {
                    return content.trim();
                }
            } catch {}
        }
    } catch {}
    return null;
}
