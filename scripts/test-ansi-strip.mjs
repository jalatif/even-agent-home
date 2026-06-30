/**
 * Repro test for the "pi/oh-my-pi stderr corrupts the host shell" bug.
 *
 * Symptom: pi (a TUI app) emits raw terminal control codes on stderr — Kitty
 * keyboard-protocol push (`ESC[99;5:1u`), DEC private mode (`ESC[?7u`),
 * device-status responses (`ESC[?62;22c`). The providers re-emit stderr to the
 * host terminal via console.log/console.error. The old classic-CSI-only strip
 * regex `/\x1b\[[0-9;]*[A-Za-z]/g` did NOT match those private-mode/kitty
 * sequences, so they leaked through and put the host shell into an irrecoverable
 * raw-mode state (echo/cursor break → shell needs kill+restart).
 *
 * This test asserts the shared stripAnsi() helper (used by both providers'
 * stderr handlers) removes ALL of them, so no raw ESC byte survives to be
 * echoed into the host terminal.
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const stripPath = pathToFileURL(join(repoRoot, "backend", "src", "shared", "ansi.js"));

const { stripAnsi } = await import(stripPath.href);

let pass = 0;
function ok(name, got, want) {
    assert.equal(got, want, `${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    pass++;
}

// 1. Classic SGR / color (the old regex handled these).
ok("classic SGR reset", stripAnsi("\x1b[0m"), "");
ok("classic color", stripAnsi("\x1b[31;1mred\x1b[0m"), "red");

// 2. Kitty keyboard protocol push — the actual byte that corrupts the host
//    terminal by pushing it into raw/Unicode-input mode. Old regex left it.
ok("kitty keyboard push", stripAnsi("\x1b[99;5:1u"), "");
ok("kitty push with text around", stripAnsi("before\x1b[99;5:1uafter"), "beforeafter");

// 3. DEC private mode set/reset + device-status response (DA2) — pi banner.
ok("DEC private mode reset", stripAnsi("\x1b[?7u"), "");
ok("DEC private mode set", stripAnsi("\x1b[?25h"), "");
ok("DA2 device status response", stripAnsi("\x1b[?62;22c"), "");

// 4. > prefix kitty sequence.
ok("kitty > prefix", stripAnsi("\x1b[>1u"), "");

// 5. A realistic pi stderr banner line containing mixed sequences + text — the
//    benign-log path must reduce it to just the human text, no control bytes.
const banner = "\x1b[?7u  pi  \x1b[?62;22c\x1b[0m v1.2.3";
ok("pi banner mixed", stripAnsi(banner), "  pi   v1.2.3");

// 6. The OLD (buggy) regex result for the kitty push, to document the regression:
//    the classic regex left it intact. stripAnsi must NOT.
const OLD_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;
assert.equal("\x1b[99;5:1u".replace(OLD_REGEX, ""), "\x1b[99;5:1u", "sanity: old regex leaves kitty push (documents the bug)");
assert.equal(stripAnsi("\x1b[99;5:1u"), "", "stripAnsi removes it (the fix)");
pass++;

// 7. No raw ESC (0x1b) or other non-tab control bytes survive.
for (const sample of ["\x1b[99;5:1u", "\x1b[?7u", "\x1b[?62;22c", "\x1b]0;title\x07"]) {
    const out = stripAnsi(sample);
    assert.ok(!out.includes("\x1b"), `raw ESC survived for ${JSON.stringify(sample)} -> ${JSON.stringify(out)}`);
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(out), `control byte survived for ${JSON.stringify(sample)} -> ${JSON.stringify(out)}`);
    pass++;
}

// 8. Empty / falsy input is safe.
ok("empty string", stripAnsi(""), "");
ok("null", stripAnsi(null), "");

// 9. Plain text with no escapes is untouched.
ok("plain text", stripAnsi("hello world"), "hello world");
ok("text with newlines", stripAnsi("a\nb\nc"), "a\nb\nc");

console.log(`[ansi-strip] ${pass} assertions passed`);
