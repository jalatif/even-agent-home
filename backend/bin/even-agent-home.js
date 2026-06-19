#!/usr/bin/env node

// Non-token settings (PORT, HOST, EVEN_HOST_MODE, ALLOW_QUERY_TOKEN,
// PROJECT_DIR, etc.) are read from the real process environment or the
// matching CLI flags below. The bridge auth token is *not* read from the
// environment — pass it with --token or let the CLI generate one.
import { randomBytes } from "node:crypto";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startServer } from "../src/index.js";

// One-time deprecation warning for users still setting BRIDGE_TOKEN in their
// environment. Helps the migration: tells them what to change.
if (process.env.BRIDGE_TOKEN) {
    console.warn(
        "[even-agent-home] WARNING: BRIDGE_TOKEN environment variable is no longer supported. " +
        "Pass it as a CLI flag instead: --token <secret> (or let the server generate a random one). " +
        "The env var will be ignored."
    );
    delete process.env.BRIDGE_TOKEN;
}

const argv = yargs(hideBin(process.argv))
    .option('token', {
        type: 'string',
        description: 'Bridge auth token clients must send as `Authorization: Bearer <token>`. ' +
                     'If omitted, a random 32-character hex token is generated for this run.',
    })
    .option('host', {
        type: 'string',
        default: process.env.HOST || '0.0.0.0',
        description: 'Host to bind to. Defaults to 0.0.0.0 so the bridge is reachable from the LAN ' +
                     '(e.g. the G2 glasses over Wi-Fi). Pass 127.0.0.1 to bind loopback only.',
    })
    .option('port', {
        type: 'number',
        default: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
        description: 'Port to bind to (default 3456)',
    })
    .option('tailscale', {
        type: 'boolean',
        description: 'Run with tailscale IP. If --host 127.0.0.1 is also passed, upgrade to 0.0.0.0 ' +
                     'so the tailscale interface can actually receive traffic.',
    })
    .option('debug', {
        type: 'boolean',
        description: 'Enable debug logs',
    })
    .option('stt-provider-url', {
        type: 'string',
        description: 'External speech-to-text provider base URL (e.g. https://api.deepgram.com). ' +
                     'The provider is auto-detected from the hostname: deepgram.com → Deepgram, ' +
                     'openai.com → OpenAI Whisper. If omitted, the built-in Whisper engine is used.',
    })
    .option('stt-provider-key', {
        type: 'string',
        description: 'API key for the external STT provider. Kept server-side only — never ' +
                     'sent to the glasses/client. Required when --stt-provider-url is set.',
    })
    .option('stt-provider-type', {
        type: 'string',
        choices: ['deepgram', 'openai-whisper'],
        description: 'Force the STT provider contract explicitly (overrides URL-based ' +
                     'detection). Use this for self-hosted providers whose hostname is not ' +
                     'deepgram.com / openai.com.',
    })
    .help()
    .argv;

if (argv.debug) process.env.DEBUG = "1";

// Thread STT provider config into the environment that stt.js reads from.
// The key NEVER reaches the frontend — it stays in this server process.
if (argv.sttProviderUrl) process.env.AGENTHOME_STT_PROVIDER_URL = argv.sttProviderUrl;
if (argv.sttProviderKey) process.env.AGENTHOME_STT_PROVIDER_KEY = argv.sttProviderKey;
if (argv.sttProviderType) process.env.AGENTHOME_STT_PROVIDER_TYPE = argv.sttProviderType;

if (argv.tailscale) {
    process.env.EVEN_HOST_MODE = "tailscale";
    if (argv.host === '127.0.0.1') {
        argv.host = "0.0.0.0";
    }
}

const token = argv.token || randomBytes(16).toString("hex");
const port = argv.port || 3456;
const host = argv.host;
const allowQueryToken = process.env.ALLOW_QUERY_TOKEN === "1";
const projectDir = process.env.PROJECT_DIR || process.cwd();

try {
    startServer({ token, port, host, allowQueryToken, projectDir });
} catch (err) {
    console.error(`[even-agent-home] ${err.message}`);
    process.exit(1);
}
