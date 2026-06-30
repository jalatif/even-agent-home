import express from "express";
import cors from "cors";
import eventsRouter from "./routes/events.js";
import coreRouter, { codexClient, shutdownProviders, startModelRefreshAll } from "./routes/core.js";
import { printServerBanner, startCodexAppServer, stopCodexAppServer } from "./startup/common.js";
import { installTimestampLogging } from "./logger.js";
import { encryptPayload, decryptPayload } from "./crypto.js";
import { debugLog } from "./debug.js";

function redactUrl(value) {
    return String(value).replace(/([?&]token=)[^&]+/gi, "$1[redacted]");
}

/**
 * Start the Agent Home bridge server.
 *
 * The bridge auth token is **required** and is passed in via the config
 * object. There is no environment-variable fallback — generating or
 * loading the token is the CLI's job (see bin/even-agent-home.js).
 *
 * @param {object} config
 * @param {string} config.token         Required. Shared secret clients must send as `Authorization: Bearer <token>`.
 * @param {number} [config.port=3456]
 * @param {string} [config.host="0.0.0.0"] Interface to bind. Pass 127.0.0.1 to bind loopback only.
 * @param {boolean} [config.allowQueryToken=false] Accept `?token=…` on the query string (used by the web client).
 * @param {string} [config.projectDir]  CWD printed in the startup banner. Defaults to process.cwd().
 */
export function startServer({ token, port = 3456, host = "0.0.0.0", allowQueryToken = false, projectDir } = {}) {
    if (typeof token !== "string" || token.length === 0) {
        throw new Error("startServer: `token` is required and must be a non-empty string. The CLI should pass --token <secret> or generate one.");
    }

    const app = express();
    app.use(cors());

    app.use((req, res, next) => {
        const startedAt = process.hrtime.bigint();
        res.on("finish", () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            const msg = `[${req.ip}] ${res.statusCode} ${req.method} ${redactUrl(req.originalUrl)} ${durationMs.toFixed(1)}ms`;
            if (req.originalUrl.startsWith("/api/status") || req.originalUrl.startsWith("/api/history") || req.originalUrl.startsWith("/api/sessions")) {
                debugLog("http", msg);
            } else {
                console.log(msg);
            }
        });
        next();
    });
    app.use(express.json({ limit: "10mb" }));

    app.use((req, res, next) => {
        // Intercept res.json to encrypt if requested
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (req.headers["x-agenthome-encrypted"] === "1" && typeof body === "object") {
                const encryptedBody = encryptPayload(Buffer.from(JSON.stringify(body), "utf8"), token);
                res.setHeader("X-AgentHome-Encrypted", "1");
                return originalJson({ encryptedPayload: encryptedBody });
            }
            return originalJson(body);
        };

        // Decrypt incoming payload if encrypted
        if (req.headers["x-agenthome-encrypted"] === "1" && req.body && req.body.encryptedPayload) {
            try {
                const decryptedBuffer = decryptPayload(req.body.encryptedPayload, token);
                req.body = JSON.parse(decryptedBuffer.toString("utf8"));
            } catch (e) {
                console.error(`[auth] Payload decryption failed: ${e.message}`);
                return res.status(400).json({ error: "Payload decryption failed" });
            }
        }
        next();
    });

    // Auth middleware. `TEST_MODE=1` is an internal escape hatch for the
    // integration tests; the CLI does not expose it.
    function auth(req, res, next) {
        if (process.env.TEST_MODE === "1") return next();
        const header = req.headers.authorization || req.headers['x-agenthome-auth'];
        const queryToken = allowQueryToken ? req.query.token : undefined;
        const provided = header?.startsWith("Bearer ") ? header.slice(7) : (header || queryToken);
        if (provided !== token) {
            console.warn(`[auth] 401 ${req.method} ${redactUrl(req.url)} (ip=${req.ip})`);
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        next();
    }

    app.use("/api", auth, eventsRouter);
    app.use("/api", auth, coreRouter);

    app.listen(port, host, async () => {
        printServerBanner(port, token, projectDir || process.cwd(), true);

        // Always start codex app server so it's ready when requested
        const codexAppServerStarted = await startCodexAppServer();
        if (codexAppServerStarted) {
            codexClient.connect().catch((err) => {
                console.error(`[codex] Failed to connect to app-server: ${err.message}`);
            });
        }
        startModelRefreshAll();

        installTimestampLogging();
    });

    let shuttingDown = false;
    async function shutdownAndExit(code) {
        if (shuttingDown) return;
        shuttingDown = true;
        await shutdownProviders();
        stopCodexAppServer();
        process.exit(code);
    }

    process.on("exit", () => stopCodexAppServer());
    process.on("SIGINT", () => { shutdownAndExit(0); });
    process.on("SIGTERM", () => { shutdownAndExit(0); });

    // Fatal errors MUST crash and let a supervisor (launchd/systemd/pm2) restart
    // the process. After an uncaught exception the process state is undefined
    // (partially-mutated maps, half-written streams, leaked handles), so
    // continuing to serve requests produces a "zombie server": SSE streams
    // hang, sessions wedge busy, child-process tables leak. Logging-only
    // handlers also disable Node's default exit-on-unhandled-rejection (v15+).
    // Route both through the existing graceful-shutdown path so providers are
    // disposed and the app-server is stopped before exiting with a non-zero code.
    process.on("uncaughtException", (err) => {
        console.error(`[server] UNCAUGHT EXCEPTION (shutting down): ${err.message}\n${err.stack}`);
        shutdownAndExit(1);
    });
    process.on("unhandledRejection", (reason) => {
        console.error(`[server] UNHANDLED REJECTION (shutting down): ${reason}`);
        shutdownAndExit(1);
    });
}

// Re-export so the CLI / tests can call startServer({ token, ... }) without
// importing the deeply-nested path.
export default startServer;
