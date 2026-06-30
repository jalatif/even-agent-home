# even-agent-home

The backend bridge for **Agent Home** — connects multi-provider AI agents (Claude, Codex, OpenCode, Hermes, Antigravity, pi, oh-my-pi, openclaw) to the [Even Realities](https://www.evenrealities.com) G2 smart glasses client over a local HTTP/WS bridge.

This is the server half. The glasses-side web app lives in the parent repository at [`web/`](../web).

## Install

```bash
npm install -g even-agent-home
```

…or run on demand with `npx`:

```bash
npx even-agent-home
```

## Usage

```bash
even-agent-home                      # default: 0.0.0.0:3456, random token generated
even-agent-home --host 127.0.0.1     # bind loopback only (e.g. when paired with --tailscale)
even-agent-home --token my-secret    # set a known bridge auth token
even-agent-home --port 8765          # custom port
even-agent-home --tailscale          # bind to Tailscale IP (LAN-reachable)
even-agent-home --debug              # verbose logs

# Speech-to-text (voice input). Built-in Whisper is used by default — no flags needed.
# To use an external provider instead (key stays server-side, never reaches the glasses):
even-agent-home \
  --stt-provider-url https://api.deepgram.com \
  --stt-provider-key <your-deepgram-key>
even-agent-home \
  --stt-provider-url https://api.openai.com \
  --stt-provider-key <your-openai-key>
```

On first start (and on every start where `--token` is not passed) the server generates a random 32-character hex token and prints a connect URL containing it, e.g.:

```
Connect URL: http://192.168.6.11:3456?token=abc123...
```

Paste that URL into the Agent Home glasses client → Settings. The settings UI
auto-splits full `?token=` URLs into Backend URL + Secure Token. The token is
required for every API request and is the only credential the bridge uses.

The banner still prints a QR code for terminal convenience, but the current
Even Hub WebView client does not scan it: phone camera access is not exposed to
plugin WebViews.

> **Note:** the auth token is **only** accepted via the `--token` CLI flag (or generated for you). The legacy `BRIDGE_TOKEN` environment variable is no longer supported and will produce a deprecation warning if set.

## Environment

The bridge auth token is **not** read from the environment — pass it with `--token` or let the CLI generate one. All other settings below are read from the real process environment (or their matching CLI flags).

| `PORT` | `3456` | Port to listen on (overridden by `--port`) |
| `HOST` | `0.0.0.0` | Interface to bind. Defaults to all interfaces so the bridge is reachable from the LAN (e.g. G2 glasses on the same Wi-Fi). Pass `127.0.0.1` to bind loopback only — auth (the `--token`) is still required, but the wider bind does increase the surface area for attackers on the same network. |
| `ALLOW_QUERY_TOKEN` | `0` | If `1`, also accept `?token=…` on the query string (used by the web client) |
| `EVEN_HOST_MODE` | auto | `tailscale` to bind to the Tailscale interface |
| `EVEN_HOST_INTERFACE` | auto | Specific network interface to bind to |
| `EVEN_TERMINAL_NAME` | unset | Friendly name printed in the banner / QR code |
| `CODEX_APP_SERVER_PORT` | `8765` (or `8766` if `PORT=8765`) | Port the Codex app-server listens on |
| `DEBUG` | `0` | If `1`, enable verbose logging |
| `TEST_MODE` | `0` | If `1`, disable the auth check (used by the integration tests only) |
| `PROJECT_DIR` | `process.cwd()` | CWD printed in the startup banner |
| `AGENTHOME_STT_PROVIDER_URL` | unset | Base URL of an external speech-to-text provider (e.g. `https://api.deepgram.com`). When unset, the built-in Whisper engine is used. Provider type is auto-detected from the hostname. |
| `AGENTHOME_STT_PROVIDER_KEY` | unset | API key for the external STT provider. **Kept server-side only** — never sent to the glasses client. Required when `AGENTHOME_STT_PROVIDER_URL` is set. |
| `AGENTHOME_STT_PROVIDER_TYPE` | unset | Force the STT provider contract explicitly (`deepgram` \| `openai-whisper`). Overrides hostname detection — use for self-hosted providers whose URL is not `deepgram.com` / `openai.com`. |
| `AGENTHOME_STT_MODEL` | `Xenova/whisper-small.en` | Whisper model for the **built-in** engine only (ignored when an external provider is configured). Default `small.en` (~130MB, better accuracy in noise/accents, ~1.6-2s/turn). Use `Xenova/whisper-tiny.en` for speed (~40MB, ~0.3s/turn, weaker accuracy). |

See `--help` for the CLI equivalents.

## Supported agents

Each agent is launched via its own CLI tool that must be on `$PATH` for the corresponding provider to work. Missing tools are reported as `[<provider>] ERROR` in the startup logs and that provider is simply unavailable — the server still starts and the other agents continue to work.

| Agent | External tool |
| --- | --- |
| `claude` | `@anthropic-ai/claude-agent-sdk` (npm) — no external binary |
| `codex` | `codex app-server` |
| `opencode` | `opencode` |
| `hermes` | bundled (no external dep) |
| `openclaw` | `openclaw` + Gateway HTTP chat endpoint |
| `antigravity` | `gemini` |
| `oh-my-pi` | bundled |
| `pi` | bundled |

## Speech-to-text (voice input)

Voice queries are transcribed server-side by `/api/transcribe`. The engine is selected by the backend's `--stt-provider-url` / `--stt-provider-key` flags (or the matching `AGENTHOME_STT_PROVIDER_*` env vars) — the frontend knows nothing about STT providers and just ships raw PCM to the bridge.

| Provider | When | Auth | Request | Response path |
| --- | --- | --- | --- | --- |
| **Built-in Whisper** (default) | no `--stt-provider-url` | — | runs `@huggingface/transformers` in Node (CPU/WASM) | — |
| **Deepgram** | URL hostname contains `deepgram.com` (or `--stt-provider-type deepgram`) | `Authorization: Token <key>` | WAV body, `model=nova-3&smart_format=true` | `results.channels[0].alternatives[0].transcript` |
| **OpenAI Whisper** | URL hostname contains `openai.com` (or `--stt-provider-type openai-whisper`) | `Authorization: Bearer <key>` | multipart form (`whisper-1`) | `text` |

**Provider type is auto-detected from the URL hostname.** Pass `--stt-provider-type deepgram|openai-whisper` to force it for a self-hosted provider whose hostname doesn't match (e.g. a local Whisper server).

> **Security:** the provider API key is **server-side only**. It lives in the backend process and is never sent to the glasses client (which is distributed to end users). This follows Deepgram's and OpenAI's own guidance — client-side keys are forbidden and, for Deepgram, browser/WebView calls are also CORS-blocked. The contract test (`scripts/test-stt-contract.mjs`) asserts the key never appears in the response to `/api/transcribe`.

**Built-in engine notes:** zero external dependencies — no `ffmpeg`, no Python. The Whisper model (`Xenova/whisper-small.en`, ~130MB quantized) downloads from HuggingFace on first voice use, then caches under `~/.agent-home/models/` (override with `HF_HOME`/`AGENTHOME_STT_MODEL`). Only the first-ever query needs network; the rest run offline. The pipeline is lazy-loaded, so the backend boots fast and users who never use voice pay no cost. Trade `AGENTHOME_STT_MODEL=Xenova/whisper-tiny.en` for faster turns (~0.3s vs ~2s) at lower accuracy.

## API surface

The server speaks JSON over HTTP and SSE. All routes are mounted under `/api`. Examples:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3456/api/agents
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3456/api/sessions?agent=claude"
curl -N -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3456/api/events?sessionId=<id>&needReplay=true"
```

POST `/api/prompt`:

```json
{
  "provider": "claude",
  "sessionId": "<id or omit to start new>",
  "text": "Summarize this conversation",
  "model": "claude-opus-4-8",
  "thinking": "low",
  "yolo": false
}
```

### Model-selection notes

- `pi` accepts the model selected by the client, but the provider normalizes
  unqualified model aliases through `~/.pi/agent/models.json` before spawning
  the CLI. For example, a saved/client value of `minimax-m3` is launched as the
  configured provider-qualified id such as `litellm/minimax-m3`. This prevents
  pi from accidentally resolving a custom LiteLLM model to a built-in provider
  with different credentials.
- `oh-my-pi` and `pi` clear stale per-session errors at the start/end of later
  successful turns, so `/api/status` does not keep reporting an old provider
  failure after the next response succeeds.

## Encryption

The web client encrypts request/response bodies with AES-256-GCM using a key derived from the bridge token. To opt in, send:

- `X-AgentHome-Auth: <token>` (header)
- `X-AgentHome-Encrypted: 1` (header)

## Development

Run from source:

```bash
cd backend
npm install
npx even-agent-home --token dev-token
```

(`npm start` runs `node src/index.js` directly, which now throws because the server module requires a token to be passed in — always go through the CLI.)

The server hot-reloads on restart but does not watch files — kill and re-run after edits.
