# even-agent-home

The backend bridge for **Agent Home** — connects multi-provider AI agents (Claude, Codex, OpenCode, Hermes, Antigravity, oh-my-pi) to the [Even Realities](https://www.evenrealities.com) G2 smart glasses client over a local HTTP/WS bridge.

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
```

On first start (and on every start where `--token` is not passed) the server generates a random 32-character hex token and prints a connect URL containing it, e.g.:

```
Connect URL: http://192.168.6.11:3456?token=abc123...
```

Paste that URL (or scan the QR code printed alongside it) into the Agent Home glasses client → Settings → Quick Connect. The token is required for every API request and is the only credential the bridge uses.

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

See `--help` for the CLI equivalents.

## Supported agents

Each agent is launched via its own CLI tool that must be on `$PATH` for the corresponding provider to work. Missing tools are reported as `[<provider>] ERROR` in the startup logs and that provider is simply unavailable — the server still starts and the other agents continue to work.

| Agent | External tool |
| --- | --- |
| `claude` | `@anthropic-ai/claude-agent-sdk` (npm) — no external binary |
| `codex` | `codex app-server` |
| `opencode` | `opencode` |
| `hermes` | bundled (no external dep) |
| `antigravity` | `gemini` |
| `oh-my-pi` | bundled |
| `pi` | bundled |

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
  "model": "claude-3-5-sonnet-20241022",
  "thinking": "low",
  "yolo": false
}
```

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
