# Agent Home

A bridge server and glasses client that put multi-provider AI agents on the
[Even Realities G2](https://www.evenrealities.com) smart glasses. Talk to
your coding agents on the go, get streaming responses in your field of view,
issue follow-ups by voice or text — without taking out your phone.

```
   Even G2 glasses  ──WiFi──▶  Agent Home bridge  ──stdio/WS──▶  AI agent
    (web client)                  (backend)                      (claude, codex, …)
```

The glasses-side app and the bridge server live in this repo as two packages
that ship and evolve together. The bridge is also published to npm as
[`even-agent-home`](https://www.npmjs.com/package/even-agent-home) for one-line
install.

## Quick start

### 1. Install and run the bridge

```bash
npm install -g even-agent-home
even-agent-home --token my-secret --port 3456
```

The CLI prints a banner with a `Connect URL` like
`http://192.168.6.11:3456?token=...`.

### 2. Connect from the glasses app

Sideload `app.json` to your G2 (see [Even Hub docs](https://docs.evenrealities.com))
to install the Agent Home client. Open the app, go to **Settings** and paste the
full `Connect URL` into the Backend URL field. The settings UI auto-splits it
into `baseUrl` + `token`.

The settings are persisted through the Even Hub bridge storage API, so a restart
of the app does not require re-entering the URL or token. QR scanning is not part
of the current app because Even Hub plugin WebViews do not expose the phone
camera to `getUserMedia`.

See [`backend/README.md`](./backend/README.md) for the full bridge
documentation (env vars, API surface, supported agents, encryption wire
format).

## Repository layout

```
.
├── app.json              Even Hub app manifest (package id, permissions, network whitelist)
├── backend/              Bridge server — published to npm as `even-agent-home`
│   ├── bin/              CLI entry point
│   ├── src/              Server (Express + WebSocket) and provider implementations
│   │   └── <provider>/   One folder per agent (claude/, codex/, opencode/, …)
│   ├── README.md         Backend-specific docs
│   ├── LICENSE           MIT license for the npm package
│   └── package.json
├── web/                  Glasses-side SPA (Vite + React + TypeScript)
│   ├── src/              App source (App.tsx, controller, bridge, audio, crypto)
│   ├── public/           Static assets (icons, favicon)
│   ├── test/             Simulator golden tests
│   └── package.json
├── docs/                 Project documentation
│   ├── architecture.md   System design
│   ├── ui_invariants.md  Frontend structural rules
│   ├── TESTING_PLAN.md   Test strategy
│   ├── PROJECT_LEARNINGS.md  Engineering notes
│   └── TODO_TASKS.md     Upcoming work
└── scripts/              Integration tests
    ├── test-harness.mjs        Backend spawn + prompt tests
    ├── fuzzy-test.mjs          Layout / structural fuzzing
    ├── simulator-flow.mjs      End-to-end UI flow tests
    ├── test-controller-state.mjs
    ├── test-controller-races.mjs
    ├── test-polling-controller.mjs
    ├── test-frontend-flow.mjs
    ├── test-provider-contracts.mjs
    ├── test-send-message.mjs
    ├── test-cutoff.mjs
    ├── test-yolo-harness.mjs
    ├── test-yolo-mode.mjs
    ├── test_models_harness.js
    ├── test_omp_external.mjs
    ├── upload.mjs
    ├── configure-tailscale.mjs
    └── start-backend.sh
```

## Supported agents

Each agent is launched via its own CLI tool that must be on `$PATH` for that
provider to work. Missing tools are reported in the startup logs and the
corresponding provider is disabled — the bridge still starts and the other
agents continue to work.

| Agent | External tool |
| --- | --- |
| `claude` | bundled (`@anthropic-ai/claude-agent-sdk`) |
| `codex` | `codex app-server` |
| `opencode` | `opencode` |
| `hermes` | bundled |
| `openclaw` | `openclaw` + Gateway HTTP chat endpoint |
| `antigravity` | `agy` |
| `oh-my-pi` | `omp` |
| `pi` | `pi` |

You can also add **your own agents** via a config file — no code changes. Three
tiers: `gateway` (OpenAI-compatible endpoint), `cli` (a streaming-JSONL CLI),
or `module` (a small JS file for bespoke tools). A template + guide are seeded
to `~/.agent-home/` on first start. See `docs/custom-agents-guide.md` and
`backend/README.md` → "Custom agents".

## Development

### Backend

```bash
cd backend
npm install
npx even-agent-home --token dev-token
```

(`npm start` runs `node src/index.js` directly, which now throws because
the server module requires a token to be passed in — always go through the
CLI.)

### Web

```bash
cd web
npm install
npm run dev
```

The web app boots into a "please configure" state until you connect a backend.
Open the app via the printed **Connect URL** (e.g. `http://192.168.x.x:8765?token=...`),
or enter the **Backend URL** + **Token** manually in Settings → Connect.

### Running the integration tests

Each test script in `scripts/` is standalone and uses `node` (no test
runner required). The controller-state and controller-races tests spawn
the bridge themselves and require a working `code` / `opencode` / etc.
binary on `$PATH` for the provider-specific variants.

```bash
node scripts/test-controller-state.mjs
node scripts/fuzzy-test.mjs
node scripts/simulator-flow.mjs
```

## Security

- The bridge auth token is **only** accepted via the `--token` CLI flag (or
  generated for you on every start). The legacy `BRIDGE_TOKEN` env var is
  no longer supported and will print a deprecation warning if set.
- The bridge defaults to binding on `0.0.0.0` so the glasses on the same
  LAN can reach it. Pass `--host 127.0.0.1` to bind loopback only when on
  untrusted networks.
- Request/response bodies can be encrypted with AES-256-GCM keyed off the
  bridge token — set `X-AgentHome-Encrypted: 1` and wrap the body as
  `{"encryptedPayload": "<base64>"}`. See `src/crypto.js` for the wire
  format.

## License

MIT — see [backend/LICENSE](./backend/LICENSE).

## Links

- npm package: [even-agent-home](https://www.npmjs.com/package/even-agent-home)
- Even Realities: [evenrealities.com](https://www.evenrealities.com)
