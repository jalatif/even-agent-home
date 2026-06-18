import { execFile } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Note: This expects faster-whisper (e.g. whisper-ctranslate2 or similar CLI)
// to be installed on the system. For a production deployment, use a dedicated
// STT microservice.

export async function transcribeAudio(pcmData) {
    // pcmData is an array of bytes
    if (!pcmData || pcmData.length === 0) {
        return "No audio provided";
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-home-stt-"));
    const pcmPath = path.join(tmpDir, "audio.pcm");
    const wavPath = path.join(tmpDir, "audio.wav");

    try {
        await fs.writeFile(pcmPath, Buffer.from(pcmData));

        await execFileAsync("ffmpeg", [
            "-f", "s16le",
            "-ar", "16000",
            "-ac", "1",
            "-i", pcmPath,
            wavPath,
            "-y",
        ], { timeout: 15000 });

        const { stdout } = await execFileAsync("whisper-ctranslate2", [
            wavPath,
            "--model", "small.en",
            "--output_format", "txt",
            "--output_dir", tmpDir,
        ], { cwd: tmpDir, timeout: 120000 });

        const txtPath = path.join(tmpDir, path.basename(wavPath, '.wav') + '.txt');
        const text = await fs.readFile(txtPath, 'utf8').catch(() => stdout);
        
        return text.trim() || "(inaudible)";
    } catch (err) {
        console.warn("[STT] transcription failed:", err.message);
        throw Object.assign(new Error("Speech transcription failed. Verify ffmpeg and whisper-ctranslate2 are installed."), {
            cause: err,
            statusCode: 503,
        });
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}
