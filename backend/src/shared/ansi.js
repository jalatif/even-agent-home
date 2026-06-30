/**
 * Strip terminal escape sequences from a string.
 *
 * Provider CLIs (notably `pi`, a TUI app) emit raw terminal control codes on
 * stderr — classic CSI SGR (`ESC[0m`), but also Kitty keyboard-protocol push
 * (`ESC[99;5:1u`), DEC private-mode (`ESC[?7u`), and device-status responses
 * (`ESC[?62;22c`). If those bytes are re-emitted to the host terminal via
 * console.log/console.error, they corrupt the host shell (Kitty push leaves it
 * in raw mode: echo/cursor break until the shell is killed + restarted).
 *
 * The classic-CSI-only regex `/\x1b\[[0-9;]*[A-Za-z]/g` that the providers used
 * does NOT match the private-mode / kitty sequences, so they leaked through.
 * This covers:
 *   - CSI with optional private `?`/`>` prefix and `:`-separated params
 *     (Kitty keyboard protocol: `ESC[99;5:1u`, `ESC[>1u`)
 *   - DEC private mode set/reset (`ESC[?7h`, `ESC[?7l`, `ESC[?62;22c`)
 *   - Classic SGR/color (`ESC[0m`, `ESC[31;1m`)
 *   - Other Fe escapes (cursor movement, erase, scroll)
 *   - Standalone ESC + single-char (osc/string terminators, `ESC\`, `ESC=`)
 *   - OSC sequences (`ESC]...BEL` / `ESC]...ST`)
 *
 * After stripping, collapse any leftover control bytes (NUL, BEL, etc.) that
 * could still confuse a terminal.
 */
const ANSI_OR_CONTROL = [
    // OSC: ESC ] ... (BEL or ST=ESC \)
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
    // CSI: ESC [ ? > 0-9;: <=>?` digits/params, then a final byte (0x40-0x7e).
    //   Covers classic SGR, Kitty keyboard protocol, DEC private mode, DA responses.
    /\x1b\[[?>]?[0-9;:]*[ -\/]*[0-9;:]*[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,
    // Other Fe sequences: ESC + one of @A-Z[\]^_`{|}~ (e.g. ESC M, ESC 7)
    /\x1b[\x40-\x5f]/g,
    // Lone ESC + single trailing char (ESC=, ESC>, ESC\, etc.)
    /\x1b./g,
].map((re) => new RegExp(re.source, re.flags));

export function stripAnsi(input) {
    if (!input) return "";
    let out = input;
    for (const re of ANSI_OR_CONTROL) out = out.replace(re, "");
    // Collapse remaining non-tab control chars (BEL, NUL, etc.) that ANSI
    // stripping can leave behind from partially-matched sequences.
    return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
