# Agent Home Web Client

The `web/` package is the Even Hub client for Agent Home. It contains both the
phone settings UI and the glasses state-machine renderer.

## Responsibilities

- Manage **multiple backends** in a registry: each backend is a name + Backend
  URL/port + Secure Token + per-backend agent config + per-backend app prefs.
  One backend is **active** at a time (= last connected); the app boots onto it.
- Persist the registry through the Even Hub bridge storage API (single KV key
  `backends`), with browser `localStorage` only as a development fallback.
- Let users connect / switch / edit / remove backends from Settings, and
  enable/disable agents + choose per-agent model/thinking for the active backend.
- Render the glasses UI through `EvenHubGlassesBridge`.
- Send voice PCM to the backend `/api/transcribe` endpoint. STT provider
  selection and API keys are backend-only.

## Multi-Backend Connection Flow

The backend prints a `Connect URL` such as:

```text
http://192.168.6.11:3456?token=...
```

In Settings, **Connect New Backend** opens a modal with Name + Connection +
Token fields. The Connection field accepts either the full URL above (auto-split
into `baseUrl` + `token` via `parseConnectionUrl()`) **or** a plain `host:port`
with the token entered separately. Connecting a backend makes it active. The
Backends list shows all connected backends; clicking another one switches to it
immediately and re-connects. The last-connected backend auto-connects on startup.
Existing single-backend installs are auto-imported as one named backend on
upgrade. QR/camera scanning is intentionally not implemented: Even Hub plugin
WebViews do not expose phone camera capture APIs.

See `docs/superpowers/specs/2026-06-28-multi-backend-design.md` for the full
design.

## Model Defaults

`App.tsx` owns the first-paint and persisted model-selection policy:

- Claude defaults to `claude-opus-4-8`.
- Codex defaults to `gpt-5.5`.
- Stale saved Claude model ids that are no longer in the live backend model list
  are treated as invalid and reset to `claude-opus-4-8`.
- The native `<select>` is given the selected fallback option immediately, so it
  cannot visually fall back to `Default` while the async model list is loading.

## Tests

```bash
npm run build
npm run test:unit
npm run test:simulator
```

`test:unit` covers bridge/storage regressions and the multi-backend registry
(`test/backends.test.ts`). `test:simulator` validates the glasses state-machine
and structural render invariants. Backend-integrated polling behavior is covered
by scripts in the repo root, especially `scripts/test-polling-controller.mjs`.
