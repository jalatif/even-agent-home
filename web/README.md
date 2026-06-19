# Agent Home Web Client

The `web/` package is the Even Hub client for Agent Home. It contains both the
phone settings UI and the glasses state-machine renderer.

## Responsibilities

- Pair the app with the bridge by storing Backend URL + Secure Token.
- Persist settings through the Even Hub bridge storage API, with browser
  `localStorage` only as a development fallback.
- Let users enable/disable agents and choose per-agent model/thinking settings.
- Render the glasses UI through `EvenHubGlassesBridge`.
- Send voice PCM to the backend `/api/transcribe` endpoint. STT provider
  selection and API keys are backend-only.

## Current Connection Flow

The backend prints a `Connect URL` such as:

```text
http://192.168.6.11:3456?token=...
```

Paste the full URL into Settings. `parseConnectionUrl()` splits it into
`baseUrl` and `token`. QR/camera scanning is intentionally not implemented:
Even Hub plugin WebViews do not expose phone camera capture APIs.

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

`test:unit` covers bridge/storage regressions. `test:simulator` validates the
glasses state-machine and structural render invariants. Backend-integrated
polling behavior is covered by scripts in the repo root, especially
`scripts/test-polling-controller.mjs`.
