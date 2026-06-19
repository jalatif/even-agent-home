import { pipeline, env } from "@huggingface/transformers";
import path from "node:path";
import os from "node:os";

// ── STT provider configuration ──────────────────────────────────────────
//
// Speech-to-text supports three engines, selected by the backend's
// --stt-provider-url / --stt-provider-key flags (or AGENTHOME_STT_PROVIDER_URL
// / AGENTHOME_STT_PROVIDER_KEY env vars):
//
//   1. BUILT-IN (default): Whisper via @huggingface/transformers, runs in Node
//      via ONNX Runtime (CPU/WASM). Zero external dependencies. Model downloads
//      on first use then cached. No flags needed.
//   2. DEEPGRAM: when the provider URL hostname contains "deepgram.com". Uses
//      `Authorization: Token <key>`, sends a WAV body, reads
//      results.channels[0].alternatives[0].transcript.
//   3. OPENAI-WHISPER: when the URL hostname contains "openai.com". Uses
//      `Authorization: Bearer <key>`, sends multipart/form-data, reads `text`.
//
// The provider type is RESOLVED FROM THE URL — no enum, no separate flag.
// This keeps secrets server-side (the key never reaches the glasses WebView,
// which is distributed to end users). See docs for the URL-sniffing tradeoff.

const BUILT_IN_MODEL = process.env.AGENTHOME_STT_MODEL || "Xenova/whisper-tiny.en";
// PROVIDER_URL / PROVIDER_KEY are read lazily at call time (see activeProvider)
// for the same module-load timing reason: the CLI sets these env vars after
// this module's imports have already executed.

// Cache models under the user's home so a global install keeps the downloaded
// weights across reinstalls and does not fight the OS temp dir being cleaned.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.localModelPath =
    process.env.HF_HOME ||
    process.env.TRANSFORMERS_CACHE ||
    path.join(os.homedir(), ".agent-home", "models");

// Lazy-initialized built-in Whisper pipeline (heavy — loads ONNX encoder+
// decoder into memory). Created on first transcription request so the backend
// boots fast and users who never use voice never pay the cost.
let asrPromise = null;

function getTranscriber() {
    if (!asrPromise) {
        asrPromise = pipeline("automatic-speech-recognition", BUILT_IN_MODEL, {
            // Quantized 8-bit weights: ~3x smaller download and faster CPU
            // inference, with negligible accuracy loss for short voice queries.
            // Specifying dtype explicitly also silences a transformers.js warning.
            dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
        }).catch((err) => {
            asrPromise = null; // allow retry on next request
            throw err;
        });
    }
    return asrPromise;
}

// ── Audio framing ───────────────────────────────────────────────────────
// The glasses stream raw 16-bit little-endian PCM (16kHz mono). HTTP STT
// providers (Deepgram, OpenAI) require a containerized format, so we wrap the
// raw PCM in a 44-byte RIFF/WAVE header. This is a Node port of the
// web/src/audio/wav.ts logic (kept in sync: SAMPLE_RATE=16000, mono, 16-bit).

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function pcmToWav(pcmBytes) {
    const buffer = Buffer.isBuffer(pcmBytes) ? pcmBytes : Buffer.from(pcmBytes);
    const pcmLength = buffer.length;
    const out = Buffer.alloc(44 + pcmLength);
    writeAscii(out, 0, "RIFF");
    out.writeUInt32LE(36 + pcmLength, 4);
    writeAscii(out, 8, "WAVE");
    writeAscii(out, 12, "fmt ");
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20); // PCM format
    out.writeUInt16LE(CHANNELS, 22);
    out.writeUInt32LE(SAMPLE_RATE, 24);
    out.writeUInt32LE((SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8, 28);
    out.writeUInt16LE((CHANNELS * BITS_PER_SAMPLE) / 8, 32);
    out.writeUInt16LE(BITS_PER_SAMPLE, 34);
    writeAscii(out, 36, "data");
    out.writeUInt32LE(pcmLength, 40);
    buffer.copy(out, 44);
    return out;
}

function writeAscii(buf, offset, value) {
    for (let i = 0; i < value.length; i += 1) {
        buf.writeUInt8(value.charCodeAt(i), offset + i);
    }
}

// ── Provider resolution ─────────────────────────────────────────────────
// Resolve the provider from the URL hostname. Deepgram and OpenAI are the two
// supported external providers; everything else (or no URL) is the built-in
// Whisper engine. Tradeoff: a self-hosted Deepgram-compatible server at a
// non-deepgram hostname would fall through to built-in. Documented.
function resolveProvider(url) {
    // Explicit type override wins (handles self-hosted providers whose hostname
    // doesn't match the known vendors).
    const explicit = process.env.AGENTHOME_STT_PROVIDER_TYPE;
    if (explicit === "deepgram" || explicit === "openai-whisper") return explicit;
    // Otherwise sniff from the URL hostname.
    if (!url) return "builtin";
    const lower = url.toLowerCase();
    if (lower.includes("deepgram.com")) return "deepgram";
    if (lower.includes("openai.com")) return "openai-whisper";
    return "builtin";
}

// Resolved lazily at call time (NOT module load). The CLI parses args and sets
// AGENTHOME_STT_PROVIDER_* env vars AFTER this module's top-level imports run
// (bin → index.js → core.js → stt.js), so caching the provider at import time
// would always see an empty env. Reading it per-call is correct and cheap.
function activeProvider() {
    return resolveProvider(process.env.AGENTHOME_STT_PROVIDER_URL || "");
}

// ── External provider transcription ────────────────────────────────────

async function transcribeWithDeepgram(pcmData) {
    const wav = pcmToWav(pcmData);
    const providerUrl = process.env.AGENTHOME_STT_PROVIDER_URL || "";
    const providerKey = process.env.AGENTHOME_STT_PROVIDER_KEY || "";
    const base = providerUrl.replace(/\/+$/, "");
    const url = `${base}/v1/listen?model=nova-3&smart_format=true&language=en&punctuate=true`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Token ${providerKey}`,
            "Content-Type": "audio/wav",
        },
        body: wav,
    });
    const data = await parseJson(res);
    if (!res.ok) {
        throw providerError("Deepgram", res, data);
    }
    const transcript =
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return transcript.trim();
}

async function transcribeWithOpenAI(pcmData) {
    const wav = pcmToWav(pcmData);
    const providerUrl = process.env.AGENTHOME_STT_PROVIDER_URL || "";
    const providerKey = process.env.AGENTHOME_STT_PROVIDER_KEY || "";
    const base = providerUrl.replace(/\/+$/, "");
    const url = `${base}/v1/audio/transcriptions`;
    const form = new FormData();
    // OpenAI expects the audio under a "file" field with a filename.
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("model", "whisper-1");
    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${providerKey}` },
        body: form,
    });
    const data = await parseJson(res);
    if (!res.ok) {
        throw providerError("OpenAI Whisper", res, data);
    }
    return String(data?.text ?? "").trim();
}

async function parseJson(res) {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

function providerError(name, res, data) {
    const apiMsg =
        (data?.err_msg && String(data.err_msg)) ||
        (Array.isArray(data?.errors) && data.errors[0]?.message) ||
        (typeof data?.error === "string" && data.error) ||
        res.statusText;
    return Object.assign(
        new Error(`Speech transcription failed: ${name} returned ${res.status}${apiMsg ? ` — ${apiMsg}` : ""}`),
        { statusCode: 502 },
    );
}

// ── Built-in (Whisper) transcription ───────────────────────────────────

function pcmS16ToFloat32(pcmBytes) {
    const buffer = Buffer.isBuffer(pcmBytes) ? pcmBytes : Buffer.from(pcmBytes);
    const sampleCount = Math.floor(buffer.length / 2);
    const view = new DataView(buffer.buffer, buffer.byteOffset, sampleCount * 2);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        float32[i] = view.getInt16(i * 2, true) / 32768;
    }
    return float32;
}

async function transcribeBuiltin(pcmData) {
    const float32 = pcmS16ToFloat32(pcmData);
    if (float32.length < 8000) return "(inaudible)"; // ~0.5s at 16kHz
    try {
        const transcriber = await getTranscriber();
        const output = await transcriber(float32, {
            return_timestamps: false,
            chunk_length_s: 30,
            stride_length_s: 5,
        });
        return String(output?.text ?? "").trim() || "(inaudible)";
    } catch (err) {
        const message = err?.message || String(err);
        console.warn("[STT] built-in transcription failed:", message);
        const isFetchError = /fetch|network|ECONN|ENOTFOUND|getaddrinfo|Failed to fetch/i.test(message);
        const friendly = isFetchError
            ? `Speech transcription failed: could not download the Whisper model. Ensure the device has internet access on first use (the model is then cached offline). [${message}]`
            : `Speech transcription failed: ${message}`;
        throw Object.assign(new Error(friendly), { statusCode: 503 });
    }
}

// ── Public entry ────────────────────────────────────────────────────────

export async function transcribeAudio(pcmData) {
    if (!pcmData || pcmData.length === 0) return "No audio provided";

    const provider = activeProvider();
    if (provider === "deepgram") return transcribeWithDeepgram(pcmData);
    if (provider === "openai-whisper") return transcribeWithOpenAI(pcmData);
    return transcribeBuiltin(pcmData);
}
