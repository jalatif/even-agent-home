import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

async function fetchWithRetry(url, options, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            await setTimeout(1000);
        }
    }
}

async function runTest() {
    console.log("[Test] Starting even-agent-home backend...");
    const backend = spawn("node", ["bin/even-agent-home.js", "--token", "my_super_secret_persistent_token_123"], {
        cwd: join(process.cwd(), "backend"),
        env: { ...process.env, PORT: "3456", HOST: "127.0.0.1" }
    });

    let backendReady = false;
    backend.stdout.on("data", (data) => {
        if (data.toString().includes("Agent Home v") || data.toString().includes("Token:")) {
            backendReady = true;
        }
    });
    backend.stderr.on("data", (d) => console.error(`[backend] ${d}`));

    // Wait for backend to be ready
    for (let i = 0; i < 20; i++) {
        if (backendReady) break;
        await setTimeout(500);
    }
    if (!backendReady) {
        console.error("Backend failed to start");
        backend.kill();
        process.exit(1);
    }

    console.log("[Test] Spawning external 'omp' process...");
    const omp = spawn("omp", ["prompt", "Tell me a joke", "--mode", "json"], {
        cwd: join(process.cwd(), "backend"),
        env: { ...process.env }
    });
    
    // We need to wait a moment for omp to write the initial JSONL file.
    await setTimeout(3000);

    let sessionId = null;
    let foundBusy = false;
    let foundThinking = false;

    try {
        console.log("[Test] Fetching /api/sessions?agent=oh-my-pi");
        const sessionsRes = await fetchWithRetry("http://127.0.0.1:3456/api/sessions?agent=oh-my-pi", {
            headers: { "Authorization": "Bearer my_super_secret_persistent_token_123" }
        });
        
        // Find the most recent session
        const session = sessionsRes.sessions[0];
        if (!session) {
            throw new Error("No oh-my-pi sessions found");
        }
        sessionId = session.id;
        console.log(`[Test] Found session: ${sessionId}, state: ${session.state}`);
        
        if (session.state === "busy") {
            foundBusy = true;
            console.log("✅ Session correctly reported as busy");
        } else {
            console.log("❌ Session reported as idle, but it should be busy");
        }

        console.log(`[Test] Fetching /api/history for ${sessionId}`);
        const historyRes = await fetchWithRetry(`http://127.0.0.1:3456/api/history?agent=oh-my-pi&sessionId=${sessionId}`, {
            headers: { "Authorization": "Bearer my_super_secret_persistent_token_123" }
        });
        
        const lastMsg = historyRes.history[historyRes.history.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
            console.log(`[Test] Last message: ${lastMsg.text}`);
            if (lastMsg.text.includes("Thinking...") || lastMsg.text.length > 0) {
                foundThinking = true;
                console.log("✅ History correctly includes partial thinking/text");
            }
        } else {
            console.log("❌ History did not include an assistant message with partial text");
        }

    } catch (e) {
        console.error("Test error:", e);
    } finally {
        console.log("[Test] Cleaning up processes...");
        omp.kill("SIGKILL");
        backend.kill("SIGKILL");
        
        if (foundBusy && foundThinking) {
            console.log("✅ ALL TESTS PASSED");
            process.exit(0);
        } else {
            console.log("❌ TESTS FAILED");
            process.exit(1);
        }
    }
}

runTest().catch(console.error);
