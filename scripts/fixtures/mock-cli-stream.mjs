#!/usr/bin/env node
/**
 * Mock CLI for test-cli-provider.mjs. Emits the pi/oh-my-pi JSONL event
 * dialect on stdout: a session event, a few text deltas, then a turn_end.
 * No arguments are required; ignores stdin.
 */
const events = [
    { type: "session", id: "mock-session-001", timestamp: new Date().toISOString(), cwd: "/tmp", title: "" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } },
    { type: "turn_end" },
];
for (const e of events) {
    process.stdout.write(JSON.stringify(e) + "\n");
}
