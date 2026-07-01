# Custom STT Server Support

Optional, frontend-only feature that lets a user point speech-to-text at a
**custom STT server** of their choice instead of the backend's built-in STT.

> Adapted from the working implementation in the sibling project
> `even-telegram` (TeleGlance). The contract here is intentionally identical so
> the same custom STT server can serve both apps.

---

## TL;DR

In **Settings → last section** (the misc/global options, *not* the per-backend
agent config), there is an **STT Server URL (Optional)** field:

- **Blank (default)** → the app uses the active backend's built-in STT
  (`POST /api/transcribe`, encrypted PCM) — exactly as before. No behavior
  change.
- **Set to a URL** → the app posts the recorded audio directly to that custom
  server's `POST /api/transcribe` as a multipart WAV, with **no encryption and
  no auth headers**. The backend is bypassed for STT entirely.

The setting is **global** (not tied to a specific backend) and persists across
restarts in Even Hub bridge storage under the standalone KV key `sttServerUrl`.

---

## Why a separate format / why no auth

The backend's `/api/transcribe` receives an **encrypted** body
(`{ encryptedPayload: "…" }`, AES-GCM with a key derived from the backend
token) containing `{ audio: [ ...pcm bytes ] }`. A *custom* STT server:

- has **no copy of the backend token**, so it cannot decrypt that payload; and
- is usually a third-party / self-hosted service you point audio at directly.

So the custom-server contract uses **plain `multipart/form-data` with a WAV
file** and **no auth headers**. Only the real backend ever receives the
encrypted channel. This is the same design TeleGlance uses.

---

## Contract a custom STT server must implement

### Request

```
POST  /api/transcribe        (full URL = ${STT_SERVER_URL}/api/transcribe)
Content-Type: multipart/form-data   (set automatically by FormData)
```

| Form field | Type     | Required | Notes                                            |
|------------|----------|----------|--------------------------------------------------|
| `audio`    | WAV file | yes      | 16 kHz, mono, 16-bit little-endian PCM in a WAV  |
|            |          |          | container. Filename is `audio.wav`.              |

No `language` field is sent (this app has no language setting, unlike
TeleGlance). No `Authorization` / `X-AgentHome-*` headers are sent.

### URL normalization

The app accepts the base URL in a few shapes and normalizes to the path above:

| User-entered value                | Resolved request URL                              |
|-----------------------------------|---------------------------------------------------|
| `https://stt.example.com`         | `https://stt.example.com/api/transcribe`          |
| `https://stt.example.com/`        | `https://stt.example.com/api/transcribe`          |
| `https://stt.example.com/api`     | `https://stt.example.com/api/transcribe`          |
| `https://stt.example.com/api/`    | `https://stt.example.com/api/transcribe`          |

(A trailing slash and/or a trailing `/api` are stripped, then `/api/transcribe`
is appended.)

### Response

- **HTTP 200** with JSON body `{"text": "transcribed words here"}`.
  - The app reads **only** `text`. Other fields (`language`, `duration_seconds`,
    …) are ignored if present.
- **Non-2xx** → the app surfaces a readable error to the user on the glasses:
  `Custom STT server error <status>: <body (truncated to 200 chars)>`. The
  server should put a human-readable message in the JSON `detail` (or body).
- **Non-JSON 2xx body** → `Custom STT server returned an invalid (non-JSON)
  response`.
- **Network failure / unreachable** → `Could not reach custom STT server at
  <host>. Check the STT Server URL in Settings.`

---

## Minimal example server (Node/Express)

A reference custom STT server that satisfies the contract:

```js
import express from "express";
import multer from "multer";

const app = express();
const upload = multer();

app.post("/api/transcribe", upload.single("audio"), (req, res) => {
  const wav = req.file?.buffer; // WAV bytes from the multipart `audio` field
  if (!wav) return res.status(400).json({ detail: "missing audio field" });

  // ...run your STT of choice on `wav` (Whisper, Deepgram, etc.)...
  const text = transcribe(wav);

  res.json({ text });
});

app.listen(9000, () => console.log("custom STT on :9000"));
```

Point the app at `http://<host>:9000` and it will POST to
`http://<host>:9000/api/transcribe`.

> The custom server is responsible for its own STT provider and any API keys.
> Those keys live in the custom server, not in Agent Home — this is the whole
> point of the override (keep provider secrets off the glasses *and* out of the
> Agent Home backend).

---

## Where it lives in the code

| Concern                         | File                                                                 |
|---------------------------------|----------------------------------------------------------------------|
| Global setting store            | `web/src/sttSettings.ts` (`getSttServerUrl` / `hydrateSttServerUrl` / `setSttServerUrl`) |
| The branch + custom-path fetch  | `web/src/api.ts` → `AgentHomeApi.transcribeAudio` (+ `transcribeAudioCustom`) |
| WAV builder (reused)            | `web/src/audio/wav.ts` → `pcmChunksToWav`                            |
| Settings UI + state + save      | `web/src/App.tsx` (last settings section, `handleSaveConfig`, both hydration passes) |
| Persistence key                 | `sttServerUrl` (standalone KV key via `web/src/storage.ts`; not part of the `backends` registry) |
| Tests                           | `web/test/sttSettings.test.ts`, `web/test/transcribe.test.ts`        |

### How the branch works (`web/src/api.ts`)

```ts
async transcribeAudio(pcmData: Uint8Array): Promise<string> {
  const customUrl = getSttServerUrl().trim()
  if (customUrl) {
    // multipart WAV, no encryption, no auth
    return await this.transcribeAudioCustom(pcmData, customUrl)
  }
  // default: backend's encrypted PCM channel (unchanged)
  const data = await this.fetchEncrypted(`${this.apiBaseUrl}/transcribe`, {
    method: 'POST',
    body: JSON.stringify({ audio: Array.from(pcmData) }),
  })
  return data.text || ''
}
```

`getSttServerUrl()` reads an in-memory cache synchronously (no `await` on the
transcription hot path). It is hydrated on startup and after the bridge KV store
becomes available, the same two-pass hydration pattern the backend connection
config uses.

---

## Relationship to the backend STT flags

The backend still has its **own** STT provider configuration (unchanged):

- `--stt-provider-url` / `--stt-provider-key` / `--stt-provider-type`
  (`AGENTHOME_STT_PROVIDER_URL` / `…_KEY` / `…_TYPE`)
- selects built-in Whisper vs. Deepgram vs. OpenAI Whisper **server-side**

These two mechanisms are **independent** and stack like this:

| `sttServerUrl` set? | Backend `--stt-provider-*` | Where STT runs                          |
|---------------------|----------------------------|-----------------------------------------|
| blank               | unset                      | Backend: built-in Whisper               |
| blank               | deepgram/openai            | Backend: proxies to that provider        |
| **set**             | (ignored by STT request)   | **Custom server** (backend is bypassed) |

When `sttServerUrl` is set, the backend's `/api/transcribe` is simply never
called for STT. The backend flags remain useful for the default/no-override
case and for any other client that uses the backend directly.

---

## Scope / limitations (current implementation)

- **Frontend-only.** No backend changes; the custom STT server is an external
  process you run yourself.
- **Global, not per-backend.** One custom STT URL applies regardless of which
  backend is active. (The existing per-backend prefs — yolo, debug, scroll —
  stay per-backend.)
- **No encryption/auth to the custom server** by design (it has no token). Put
  the custom server on a trusted network or behind your own auth proxy if
  needed — the app sends nothing secret, only audio bytes.
- **WAV only.** The contract sends a WAV container; raw PCM is not supported on
  this path (the backend's encrypted path still uses raw PCM arrays internally).
- **Saved on "Save Settings" click** (matches TeleGlance), not per-keystroke.
