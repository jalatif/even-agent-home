import { existsSync } from "node:fs";
import { debugLog } from "../debug.js";
import { mapCodexItemTypeToToolName, mapCodexRequestMethodToToolName, summarizeCodexItem, summarizeCodexRequest, } from "./summarize.js";
import { appendThreadMessage, recordThreadMeta } from "./memory.js";
function defaultCodexCwd() {
    return process.env.PROJECT_DIR || process.cwd();
}
export class CodexSession {
    client;
    emit;
    activeThreadId;
    activeCwd;
    _busy = false;
    currentTurnId;
    turnStartMs = 0;
    runningInputTokens = 0;
    runningOutputTokens = 0;
    statsTimer = null;
    pendingPermissions = [];
    externallyResolvedPermissions = new Map();
    pendingQuestions = [];
    permissionTimeoutMs = 60000;
    questionTimeoutMs = 120000;
    assistantText = "";
    turnStartedAt = 0;
    emittedToolStarts = new Set();
    emittedToolEnds = new Set();
    idResolve = null;
    idPromise = null;
    idReadyCallbacks = [];
    constructor(emit, client, opts) {
        this.emit = emit;
        this.client = client;
        if (opts?.permissionTimeoutMs)
            this.permissionTimeoutMs = opts.permissionTimeoutMs;
        if (opts?.questionTimeoutMs)
            this.questionTimeoutMs = opts.questionTimeoutMs;
    }
    get id() {
        return this.activeThreadId;
    }
    get cwd() {
        return this.activeCwd;
    }
    get busy() {
        return this._busy;
    }
    get alive() {
        return true;
    }
    /** Tracked session status: 'awaiting' if there's an unanswered permission
     *  request or user question, otherwise 'busy'/'idle' based on _busy. */
    get status() {
        if (this.pendingPermissions.length > 0 || this.pendingQuestions.length > 0) {
            return "awaiting";
        }
        return this._busy ? "busy" : "idle";
    }
    get runningStats() {
        return {
            durationMs: this.turnStartMs ? Date.now() - this.turnStartMs : 0,
            inputTokens: this.runningInputTokens,
            outputTokens: this.runningOutputTokens,
        };
    }
    syncObservedStatus(status) {
        if (status === "busy" || status === "awaiting") {
            if (!this._busy) {
                this._busy = true;
                this.turnStartMs = Date.now();
                this.runningInputTokens = 0;
                this.runningOutputTokens = 0;
                this.stopStatsTimer();
                this.statsTimer = setInterval(() => this.emitRunningStats(), 10000);
            }
            return;
        }
        if (status === "idle" && this._busy) {
            this.finishTurn(true, this.assistantText || "");
        }
    }
    waitForId(timeoutMs = 10000) {
        if (this.activeThreadId)
            return Promise.resolve(this.activeThreadId);
        if (!this.idPromise) {
            this.idPromise = new Promise((resolve) => {
                this.idResolve = resolve;
            });
        }
        return Promise.race([
            this.idPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for session ID")), timeoutMs)),
        ]);
    }
    onIdReady(cb) {
        if (this.activeThreadId) {
            cb(this.activeThreadId);
        }
        else {
            this.idReadyCallbacks.push(cb);
        }
    }
    setThreadId(id) {
        if (this.activeThreadId === id)
            return;
        this.activeThreadId = id;
        if (this.idResolve) {
            this.idResolve(id);
            this.idResolve = null;
        }
        for (const cb of this.idReadyCallbacks)
            cb(id);
        this.idReadyCallbacks = [];
    }
    send(msg) {
        this.emit(this.activeThreadId ?? "", msg);
    }
    async start(sessionId, cwd) {
        this.activeThreadId = sessionId;
        const fallbackCwd = defaultCodexCwd();
        let requestedCwd = cwd;
        if (!requestedCwd && sessionId) {
            try {
                const thread = await this.client.threadRead(sessionId, false);
                if (typeof thread?.cwd === "string" && thread.cwd)
                    requestedCwd = thread.cwd;
            }
            catch { }
        }
        requestedCwd ??= fallbackCwd;
        this.activeCwd = existsSync(requestedCwd) ? requestedCwd : fallbackCwd;
        if (this.activeThreadId) {
            this.setThreadId(this.activeThreadId);
            recordThreadMeta(this.activeThreadId, this.activeCwd);
        }
        console.log(`[codex-session] Configured: resume=${sessionId ?? "new"}, cwd=${this.activeCwd}`);
    }
    async run(prompt, model, thinking) {
        if (this._busy) {
            this.send({ type: "error", message: "Codex turn already running" });
            return;
        }
        if (!this.activeCwd)
            await this.start(undefined, defaultCodexCwd());
        const cwd = this.activeCwd ?? defaultCodexCwd();
        
        const configParams = {};
        if (model) configParams.model = model;
        if (thinking && thinking !== "off") configParams.thinking = thinking;

        if (!this.activeThreadId) {
            const thread = await this.client.threadStart({ cwd, ...configParams });
            const newId = String(thread?.id ?? "");
            if (!newId)
                throw new Error("Failed to create Codex thread");
            this.setThreadId(newId);
        }
        else {
            await this.client.threadResume({
                threadId: this.activeThreadId,
                cwd,
                ...configParams
            });
        }
        const threadId = this.activeThreadId;
        recordThreadMeta(threadId, cwd, prompt);
        appendThreadMessage(threadId, "user", prompt);
        this._busy = true;
        this.turnStartMs = Date.now();
        this.runningInputTokens = 0;
        this.runningOutputTokens = 0;
        this.stopStatsTimer();
        this.statsTimer = setInterval(() => this.emitRunningStats(), 10000);
        this.send({ type: "status", state: "busy", sessionId: threadId, provider: "codex" });
        this.assistantText = "";
        this.turnStartedAt = Date.now();
        try {
            const turn = await this.client.turnStart({
                threadId,
                cwd,
                summary: "detailed",
                input: [{ type: "text", text: prompt }],
                ...configParams
            });
            this.currentTurnId = String(turn?.id ?? "");
            if (!this.currentTurnId) {
                this.finishTurn(false, "turn/start returned no turn ID");
                return;
            }
        }
        catch (err) {
            this.finishTurn(false, String(err?.message ?? err ?? "turn/start failed"));
        }
    }
    interrupt() {
        const threadId = this.activeThreadId;
        const turnId = this.currentTurnId;
        if (threadId && turnId) {
            this.client.turnInterrupt(threadId, turnId).catch(() => { });
        }
    }
    async close() {
        this.interrupt();
        this.clearPendingPermissions("deny");
        this.clearPendingQuestions("skip");
    }
    async reset(cwd) {
        await this.close();
        this.activeThreadId = undefined;
        this.activeCwd = cwd;
    }
    respondPermission(_decision) {
        const pending = this.pendingPermissions.shift();
        if (!pending)
            return;
        if (pending.timer)
            clearTimeout(pending.timer);
        const { requestId, method, params } = pending;
        const requestedDecision = _decision === "allowAlways"
            ? "allowAlways"
            : _decision === "allow"
                ? "allow"
                : "deny";
        const decision = normalizeCodexPermissionDecision(method, params, requestedDecision);
        const payload = approvalPayload(method, params, decision);
        this.respondPermissionPayload(requestId, method, decision, payload);
        this.emitPermissionResult(method, params, decision);
        this.emitNextPermissionRequest();
    }
    respondQuestion(_answer) {
        const pending = this.pendingQuestions.shift();
        if (!pending)
            return;
        clearTimeout(pending.timer);
        const { requestId, method, params } = pending;
        const answer = (_answer || "skip").trim();
        this.respondQuestionPayload(requestId, method, params, answer);
    }
    stopStatsTimer() {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
    }
    emitRunningStats() {
        if (!this._busy) {
            this.stopStatsTimer();
            return;
        }
        const stats = this.runningStats;
        this.send({
            type: "running_stats",
            durationMs: stats.durationMs,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
        });
    }
    handleNotification(method, params) {
        const p = params ?? {};
        // turn/started — track turn ID, defer busy until after user_prompt
        if (method === "turn/started") {
            const turn = p.turn ?? {};
            const turnId = String(turn.id ?? "");
            if (turnId)
                this.currentTurnId = turnId;
            this.emittedToolStarts.clear();
            this.emittedToolEnds.clear();
            return;
        }
        if (method === "item/agentMessage/delta") {
            const delta = String(p.delta ?? "");
            if (delta) {
                this.assistantText += delta;
                this.send({ type: "text_delta", text: delta });
            }
            return;
        }
        if (method === "item/started") {
            const item = p.item ?? {};
            if (item.type === "userMessage") {
                const content = Array.isArray(item.content) ? item.content : [];
                const text = content.map((c) => c.text ?? "").join("").trim();
                if (text)
                    this.send({ type: "user_prompt", text });
                if (!this._busy) {
                    this._busy = true;
                    this.turnStartMs = Date.now();
                    this.runningInputTokens = 0;
                    this.runningOutputTokens = 0;
                    this.stopStatsTimer();
                    this.statsTimer = setInterval(() => this.emitRunningStats(), 10000);
                    this.assistantText = "";
                    this.turnStartedAt = Date.now();
                    this.send({ type: "status", state: "busy", sessionId: this.activeThreadId, provider: "codex" });
                }
                return;
            }
            if (item.type === "reasoning") {
                this.send({ type: "status", state: "think_start", sessionId: this.activeThreadId, provider: "codex" });
            }
            else if (item.type === "agentMessage") {
                this.send({ type: "status", state: "text_start", sessionId: this.activeThreadId, provider: "codex" });
            }
            else if (isToolLikeItem(item.type)) {
                this.emitToolStart(item);
            }
            return;
        }
        if (method === "item/completed") {
            const item = p.item ?? {};
            this.emitExternalPermissionResult(item);
            if (item.type === "reasoning") {
                this.send({ type: "status", state: "think_end", sessionId: this.activeThreadId, provider: "codex" });
            }
            else if (item.type === "agentMessage") {
                this.send({ type: "status", state: "text_end", sessionId: this.activeThreadId, provider: "codex" });
            }
            else if (isToolLikeItem(item.type)) {
                this.emitToolEnd(item);
            }
            return;
        }
        if (method === "serverRequest/resolved") {
            this.handleServerRequestResolved(p.requestId);
            return;
        }
        if (method === "error") {
            const err = p.error?.message ?? p.error ?? "";
            console.warn(`[codex-session] error notification on thread ${this.activeThreadId}: ${String(err).slice(0, 200)}`);
            if (err)
                this.send({ type: "error", message: String(err) });
            return;
        }
        if (method === "turn/completed") {
            const turn = p.turn ?? {};
            if (this.currentTurnId && String(turn.id ?? "") !== this.currentTurnId)
                return;
            const status = String(turn.status ?? "");
            const turnErr = String(turn.error?.message ?? "");
            const success = status === "completed";
            const text = status === "interrupted"
                ? "Interrupted by user"
                : this.assistantText ||
                    turnErr ||
                    (success ? "" : "Turn failed");
            // Diagnosability: log the turn outcome so a "no response" symptom
            // can be traced to its cause (failed turn, empty output, error
            // status) rather than guessed at. The skills/changed notifications
            // are NOT this signal — they are benign cache-invalidation noise.
            console.log(`[codex-session] turn/completed thread=${this.activeThreadId} status=${status} textLen=${this.assistantText.length} err=${turnErr ? JSON.stringify(turnErr).slice(0, 120) : "(none)"}`);
            const usage = turn.usage ?? {};
            this.runningInputTokens = (usage.inputTokens ?? usage.input_tokens ?? 0);
            this.runningOutputTokens = (usage.outputTokens ?? usage.output_tokens ?? 0);
            this.finishTurn(success, text);
        }
    }
    handleServerRequest(requestId, method, params) {
        if (method === "item/commandExecution/requestApproval" ||
            method === "item/fileChange/requestApproval" ||
            method === "item/permissions/requestApproval" ||
            method === "execCommandApproval" ||
            method === "applyPatchApproval") {
            // YOLO mode: auto-approve all permission requests
            if (this.yolo) {
                const payload = approvalPayload(method, params, "allow");
                this.client.respondToServerRequest(requestId, payload);
                return;
            }
            const requestKey = String(requestId);
            this.pendingPermissions.push({ requestId, method, params, timer: null, visible: false });
            const toolName = mapCodexRequestMethodToToolName(method);
            console.log(`[codex-session] Permission request: requestId=${requestKey} method=${method} tool=${toolName} summary="${summarizeCodexRequest(params, method)}"`);
            debugLog("codex-session", `permission request ${method}`, toOneLineJson(params ?? {}));
            this.emitNextPermissionRequest();
            return;
        }
        // item/tool/requestUserInput — Codex's equivalent of AskUserQuestion
        // mcpServer/elicitation/request — MCP server asking for user input
        if (method === "item/tool/requestUserInput" ||
            method === "mcpServer/elicitation/request") {
            const requestKey = String(requestId);
            const timer = setTimeout(() => {
                this.autoRespondQuestion(requestKey, "skip");
            }, this.questionTimeoutMs);
            this.pendingQuestions.push({ requestId, method, params, timer });
            const questions = normalizeQuestions(method, params);
            console.log(`[codex-session] User question request: requestId=${requestKey} method=${method} questions=${questions.length}`);
            debugLog("codex-session", `question request ${method}`, toOneLineJson(questions));
            this.send({
                type: "user_question",
                questions,
                toolUseId: String(requestId),
            });
            return;
        }
    }
    handleClientClose(error) {
        this.clearPendingPermissions("deny");
        this.clearPendingQuestions("skip");
        if (this._busy) {
            this.finishTurn(false, this.assistantText || error.message || "Codex process exited");
        }
    }
    finishTurn(success, text) {
        const threadId = this.activeThreadId;
        if (!threadId || !this._busy)
            return;
        if (this.assistantText.trim()) {
            appendThreadMessage(threadId, "assistant", this.assistantText.trim());
        }
        const durationMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
        this.currentTurnId = undefined;
        this._busy = false;
        this.stopStatsTimer();
        this.turnStartedAt = 0;
        this.send({
            type: "result",
            success,
            text,
            sessionId: threadId,
            costUsd: 0,
            turns: 1,
            durationMs,
            inputTokens: this.runningInputTokens,
            outputTokens: this.runningOutputTokens,
            provider: "codex",
        });
        this.send({ type: "status", state: "idle", sessionId: threadId, provider: "codex" });
    }
    clearPendingPermissions(decision) {
        while (this.pendingPermissions.length > 0) {
            const pending = this.pendingPermissions.shift();
            if (pending.timer)
                clearTimeout(pending.timer);
            const payload = approvalPayload(pending.method, pending.params, decision);
            this.respondPermissionPayload(pending.requestId, pending.method, decision, payload);
        }
    }
    clearPendingQuestions(answer) {
        while (this.pendingQuestions.length > 0) {
            const pending = this.pendingQuestions.shift();
            clearTimeout(pending.timer);
            this.respondQuestionPayload(pending.requestId, pending.method, pending.params, answer);
        }
    }
    respondQuestionPayload(requestId, method, params, answer) {
        if (method === "item/tool/requestUserInput") {
            const questions = Array.isArray(params?.questions) ? params.questions : [];
            const parsed = parseQuestionAnswers(questions, answer);
            this.client.respondToServerRequest(requestId, { answers: parsed.rpcAnswers });
            this.send({ type: "question_answer", answers: parsed.displayAnswers });
            return;
        }
        if (method === "mcpServer/elicitation/request") {
            this.client.respondToServerRequest(requestId, {
                action: answer === "skip" ? "decline" : "accept",
                content: null,
            });
            return;
        }
        this.client.respondToServerRequest(requestId, { action: "decline" });
    }
    autoRespondPermission(toolUseId, decision) {
        const idx = this.pendingPermissions.findIndex((pending) => String(pending.requestId) === toolUseId);
        if (idx === -1)
            return;
        const pending = this.pendingPermissions.splice(idx, 1)[0];
        if (pending.timer)
            clearTimeout(pending.timer);
        const payload = approvalPayload(pending.method, pending.params, decision);
        this.respondPermissionPayload(pending.requestId, pending.method, decision, payload);
        this.emitPermissionResult(pending.method, pending.params, decision);
        this.emitNextPermissionRequest();
    }
    respondPermissionPayload(requestId, method, decision, payload) {
        const log = toOneLineJson({
            requestId,
            method,
            decision,
            payload,
        });
        console.log(`[codex-session] Permission response to app-server: ${log}`);
        debugLog("codex-session", "permission response payload", log);
        this.client.respondToServerRequest(requestId, payload);
    }
    handleServerRequestResolved(requestId) {
        const idx = this.pendingPermissions.findIndex((pending) => String(pending.requestId) === String(requestId));
        if (idx === -1)
            return;
        const pending = this.pendingPermissions.splice(idx, 1)[0];
        if (pending.timer)
            clearTimeout(pending.timer);
        const itemId = typeof pending.params?.itemId === "string" ? pending.params.itemId : "";
        if (itemId) {
            this.externallyResolvedPermissions.set(itemId, {
                method: pending.method,
                params: pending.params,
            });
            return;
        }
        this.emitNextPermissionRequest();
    }
    emitExternalPermissionResult(item) {
        const itemId = typeof item?.id === "string" ? item.id : "";
        if (!itemId)
            return;
        const resolved = this.externallyResolvedPermissions.get(itemId);
        if (!resolved)
            return;
        this.externallyResolvedPermissions.delete(itemId);
        this.send({
            type: "permission_result",
            toolName: mapCodexRequestMethodToToolName(resolved.method),
            summary: summarizeCodexRequest(resolved.params, resolved.method),
            decision: item?.status === "declined" ? "denied" : "allowed",
        });
        this.emitNextPermissionRequest();
    }
    emitNextPermissionRequest() {
        const pending = this.pendingPermissions[0];
        if (!pending || pending.visible)
            return;
        pending.visible = true;
        pending.timer = setTimeout(() => {
            this.autoRespondPermission(String(pending.requestId), "deny");
        }, this.permissionTimeoutMs);
        const description = summarizeCodexRequest(pending.params, pending.method);
        this.send({
            type: "permission_request",
            toolName: mapCodexRequestMethodToToolName(pending.method),
            description,
            detail: extractRequestDetail(pending.params),
            toolUseId: String(pending.requestId),
            options: buildCodexPermissionOptions(pending.method, pending.params, description),
            suggestions: buildCodexPermissionSuggestions(pending.method, pending.params),
        });
    }
    emitToolStart(item) {
        const toolId = String(item?.id ?? "");
        if (toolId && this.emittedToolStarts.has(toolId))
            return;
        if (toolId)
            this.emittedToolStarts.add(toolId);
        this.send({
            type: "tool_start",
            name: mapCodexItemTypeToToolName(item.type),
            toolId,
        });
    }
    emitToolEnd(item) {
        const toolId = String(item?.id ?? "");
        if (toolId && this.emittedToolEnds.has(toolId))
            return;
        if (toolId)
            this.emittedToolEnds.add(toolId);
        this.send({
            type: "tool_end",
            name: mapCodexItemTypeToToolName(item.type),
            toolId,
            summary: summarizeCodexItem(item),
            detail: extractItemDetail(item),
        });
    }
    emitPermissionResult(method, params, decision) {
        this.send({
            type: "permission_result",
            toolName: mapCodexRequestMethodToToolName(method),
            summary: summarizeCodexRequest(params, method),
            decision: decision === "allowAlways" ? "always"
                : decision === "allow" ? "allowed"
                    : "denied",
        });
    }
    autoRespondQuestion(toolUseId, answer) {
        const idx = this.pendingQuestions.findIndex((pending) => String(pending.requestId) === toolUseId);
        if (idx === -1)
            return;
        const pending = this.pendingQuestions.splice(idx, 1)[0];
        clearTimeout(pending.timer);
        this.respondQuestionPayload(pending.requestId, pending.method, pending.params, answer);
    }
}
// ── Helpers ──────────────────────────────────────────────
function toOneLineJson(value, maxLen = 1500) {
    try {
        const text = JSON.stringify(value);
        if (!text)
            return String(value);
        return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    }
    catch {
        return String(value);
    }
}
function isToolLikeItem(type) {
    if (typeof type !== "string")
        return false;
    return (type === "commandExecution" ||
        type === "fileChange" ||
        type === "mcpToolCall" ||
        type === "dynamicToolCall" ||
        type === "webSearch" ||
        type === "imageView" ||
        type === "imageGeneration" ||
        type === "collabAgentToolCall");
}
function extractItemDetail(item) {
    const type = String(item?.type ?? "");
    if (type === "commandExecution") {
        const input = {};
        if (item.command)
            input.command = item.command;
        if (item.cwd)
            input.cwd = item.cwd;
        const parts = [];
        if (item.aggregatedOutput)
            parts.push(String(item.aggregatedOutput));
        if (item.exitCode !== undefined)
            parts.push(`exit code: ${item.exitCode}`);
        return { input, output: parts.join("\n") || undefined };
    }
    if (type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const input = {
            files: changes.map((c) => ({ path: c.path, kind: c.kind })),
        };
        const diffs = changes.map((c) => c.diff).filter(Boolean);
        return { input, output: diffs.join("\n") || undefined };
    }
    if (type === "mcpToolCall") {
        const input = {};
        if (item.server)
            input.server = item.server;
        if (item.tool)
            input.tool = item.tool;
        if (item.arguments)
            input.arguments = item.arguments;
        return { input, output: item.result ? String(item.result) : undefined };
    }
    return undefined;
}
export function buildCodexPermissionOptions(method, params, description) {
    if (method === "item/commandExecution/requestApproval") {
        return buildCodexCommandPermissionOptions(params);
    }
    const options = [
        { text: "Yes", key: "allow" },
    ];
    if (canCodexAllowAlways(method, params)) {
        options.push({ text: describeCodexAlwaysOption(method, params, description), key: "allowAlways" });
    }
    options.push({ text: "No", key: "deny" });
    return options;
}
function buildCodexCommandPermissionOptions(params) {
    const networkApprovalContext = params?.networkApprovalContext ?? params?.network_approval_context;
    const additionalPermissions = params?.additionalPermissions ?? params?.additional_permissions;
    const availableDecisions = effectiveCodexCommandDecisions(params);
    const options = [];
    for (const decision of availableDecisions) {
        if (decision === "accept") {
            pushCodexPermissionOption(options, {
                text: networkApprovalContext ? "Yes, just this once" : "Yes, proceed",
                key: "allow",
            });
            continue;
        }
        if (decision === "acceptForSession") {
            pushCodexPermissionOption(options, {
                text: networkApprovalContext
                    ? "Yes, and allow this host for this conversation"
                    : additionalPermissions
                        ? "Yes, and allow these permissions for this session"
                        : "Yes, and don't ask again for this command in this session",
                key: "allowAlways",
            });
            continue;
        }
        const execpolicyAmendment = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
        if (execpolicyAmendment) {
            const renderedPrefix = renderCodexCommandPrefix(execpolicyAmendment);
            if (!renderedPrefix.includes("\n") && !renderedPrefix.includes("\r")) {
                pushCodexPermissionOption(options, {
                    text: `Yes, and don't ask again for commands that start with ${quoteInline(renderedPrefix)}`,
                    key: "allowAlways",
                });
            }
            continue;
        }
        const networkAmendment = decision?.applyNetworkPolicyAmendment?.network_policy_amendment;
        if (networkAmendment) {
            if (networkAmendment?.action === "deny") {
                pushCodexPermissionOption(options, { text: "No, and block this host in the future", key: "deny" });
            }
            else {
                pushCodexPermissionOption(options, { text: "Yes, and allow this host in the future", key: "allowAlways" });
            }
            continue;
        }
        if (decision === "decline") {
            pushCodexPermissionOption(options, { text: "No, continue without running it", key: "deny" });
            continue;
        }
        if (decision === "cancel") {
            pushCodexPermissionOption(options, { text: "No, and tell Codex what to do differently", key: "deny" });
        }
    }
    return options.length > 0 ? options : [
        { text: "Yes, proceed", key: "allow" },
        { text: "No, and tell Codex what to do differently", key: "deny" },
    ];
}
function pushCodexPermissionOption(options, option) {
    if (!options.some((existing) => existing.key === option.key)) {
        options.push(option);
    }
}
function buildCodexPermissionSuggestions(method, params) {
    if (method === "item/commandExecution/requestApproval") {
        const suggestions = [];
        if (Array.isArray(params?.availableDecisions)) {
            suggestions.push({ type: "availableDecisions", decisions: params.availableDecisions });
        }
        const execpolicyAmendment = params?.proposedExecPolicyAmendment ?? params?.proposedExecpolicyAmendment;
        if (execpolicyAmendment) {
            suggestions.push({ type: "proposedExecpolicyAmendment", amendment: execpolicyAmendment });
        }
        if (Array.isArray(params?.proposedNetworkPolicyAmendments)) {
            suggestions.push({ type: "proposedNetworkPolicyAmendments", amendments: params.proposedNetworkPolicyAmendments });
        }
        return suggestions.length > 0 ? suggestions : null;
    }
    if (method === "item/fileChange/requestApproval") {
        return params?.grantRoot ? [{ type: "grantRoot", root: params.grantRoot }] : null;
    }
    if (method === "item/permissions/requestApproval") {
        return [{ type: "permissions", permissions: params?.permissions ?? {} }];
    }
    return null;
}
function canCodexAllowAlways(method, params) {
    if (method === "item/permissions/requestApproval")
        return true;
    if (method === "item/commandExecution/requestApproval") {
        return effectiveCodexCommandDecisions(params).some((decision) => decision === "acceptForSession" ||
            Boolean(decision?.acceptWithExecpolicyAmendment) ||
            Boolean(decision?.applyNetworkPolicyAmendment));
    }
    if (method === "item/fileChange/requestApproval")
        return true;
    return method === "execCommandApproval" || method === "applyPatchApproval";
}
function describeCodexAlwaysOption(method, params, placeholderText) {
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
        const execpolicyAmendment = extractCodexExecpolicyAmendment(params);
        if (execpolicyAmendment) {
            return `Yes, and don't ask again for command rule ${quoteInline(formatCodexRule(execpolicyAmendment))}`;
        }
        const networkAmendment = extractCodexNetworkPolicyAmendment(params);
        if (networkAmendment) {
            return `Yes, and remember network access ${quoteInline(formatCodexNetworkAmendment(networkAmendment))}`;
        }
        return "Yes, and don't ask again for similar commands this session";
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
        return params?.grantRoot
            ? `Yes, and allow file changes under ${quoteInline(params.grantRoot)} this session`
            : "Yes, and allow file changes for this session";
    }
    if (method === "item/permissions/requestApproval") {
        return `Yes, and allow ${describeCodexPermissions(params?.permissions)} for this session`;
    }
    return placeholderText;
}
function extractCodexExecpolicyAmendment(params) {
    const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : [];
    for (const decision of available) {
        const amendment = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
        if (amendment)
            return amendment;
    }
    return params?.proposedExecPolicyAmendment ?? params?.proposedExecpolicyAmendment;
}
function extractCodexNetworkPolicyAmendment(params) {
    const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : [];
    for (const decision of available) {
        const amendment = decision?.applyNetworkPolicyAmendment?.network_policy_amendment;
        if (amendment)
            return amendment;
    }
    const amendments = Array.isArray(params?.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments
        : [];
    return amendments[0];
}
function formatCodexRule(rule) {
    return renderCodexCommandPrefix(rule);
}
function renderCodexCommandPrefix(command) {
    const parts = Array.isArray(command) ? command.map((part) => String(part)) : [String(command)];
    const shellScript = extractCodexShellScript(parts);
    return shellScript ?? shellEscapeCommand(parts);
}
function extractCodexShellScript(command) {
    if (command.length < 3)
        return null;
    const shell = command[0]?.split(/[\\/]/g).pop();
    if (shell !== "bash" && shell !== "zsh")
        return null;
    const scriptIndex = command.findIndex((part, idx) => idx > 0 && (part === "-c" || part === "-lc"));
    if (scriptIndex === -1 || scriptIndex + 1 >= command.length)
        return null;
    return command[scriptIndex + 1] ?? null;
}
function shellEscapeCommand(command) {
    return command.map(shellEscapeArg).join(" ");
}
function shellEscapeArg(arg) {
    if (arg === "")
        return "''";
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg))
        return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
function formatCodexNetworkAmendment(amendment) {
    if (typeof amendment === "string")
        return amendment;
    if (amendment && typeof amendment === "object") {
        const host = String(amendment.host ?? amendment.domain ?? amendment.url ?? "network");
        const action = amendment.action ? ` ${String(amendment.action)}` : "";
        return `${host}${action}`;
    }
    return String(amendment);
}
function describeCodexPermissions(permissions) {
    const parts = [];
    const fileSystem = permissions?.fileSystem ?? permissions?.filesystem;
    const write = fileSystem?.write;
    if (Array.isArray(write) && write.length > 0) {
        parts.push(`write access to ${write.map((path) => quoteInline(path)).join(", ")}`);
    }
    const read = fileSystem?.read;
    if (Array.isArray(read) && read.length > 0) {
        parts.push(`read access to ${read.map((path) => quoteInline(path)).join(", ")}`);
    }
    if (permissions?.network?.enabled === true) {
        parts.push("network access");
    }
    return parts.length > 0 ? parts.join(" and ") : "requested permissions";
}
function quoteInline(value) {
    return `\`${String(value)}\``;
}
function normalizeCodexPermissionDecision(method, params, requested) {
    const offered = new Set(buildCodexPermissionOptions(method, params, "").map((option) => option.key));
    if (offered.has(requested))
        return requested;
    if (requested === "allowAlways" && offered.has("allow"))
        return "allow";
    if (offered.has("deny"))
        return "deny";
    return offered.has("allow") ? "allow" : "deny";
}
export function approvalPayload(method, params, decision) {
    const requested = decision === "allowAlways"
        ? "allowAlways"
        : decision === "allow"
            ? "allow"
            : "deny";
    const normalized = normalizeCodexPermissionDecision(method, params, requested);
    // codex app-server approval responses:
    // - command/file approvals use result.decision: accept | acceptForSession | decline/cancel
    // - request_permissions uses result.permissions plus optional result.scope.
    if (method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval") {
        const sessionDecision = method === "item/commandExecution/requestApproval"
            ? commandAllowAlwaysDecision(params)
            : "acceptForSession";
        return {
            decision: normalized === "allowAlways" ? sessionDecision
                : normalized === "allow" ? "accept"
                    : method === "item/commandExecution/requestApproval" ? commandDenyDecision(params)
                        : "cancel",
        };
    }
    if (method === "item/permissions/requestApproval") {
        return normalized === "deny"
            ? { permissions: {} }
            : {
                permissions: params?.permissions ?? {},
                scope: normalized === "allowAlways" ? "session" : "turn",
            };
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
        return {
            decision: normalized === "allowAlways" ? "approved_for_session"
                : normalized === "allow" ? "approved"
                    : "denied",
        };
    }
    return { decision: normalized === "deny" ? "decline" : "accept" };
}
function commandAllowAlwaysDecision(params) {
    const available = effectiveCodexCommandDecisions(params);
    for (const decision of available) {
        if (decision === "acceptForSession")
            return "acceptForSession";
        if (decision?.acceptWithExecpolicyAmendment) {
            const amendment = decision.acceptWithExecpolicyAmendment.execpolicy_amendment;
            const renderedPrefix = renderCodexCommandPrefix(amendment);
            if (!renderedPrefix.includes("\n") && !renderedPrefix.includes("\r"))
                return decision;
        }
        const networkAmendment = decision?.applyNetworkPolicyAmendment?.network_policy_amendment;
        if (networkAmendment?.action !== "deny" && decision?.applyNetworkPolicyAmendment)
            return decision;
    }
    const execpolicyAmendment = params?.proposedExecPolicyAmendment ?? params?.proposedExecpolicyAmendment;
    if (execpolicyAmendment) {
        return {
            acceptWithExecpolicyAmendment: {
                execpolicy_amendment: execpolicyAmendment,
            },
        };
    }
    const networkPolicyAmendments = Array.isArray(params?.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments
        : [];
    if (networkPolicyAmendments.length === 1) {
        return {
            applyNetworkPolicyAmendment: {
                network_policy_amendment: networkPolicyAmendments[0],
            },
        };
    }
    return "acceptForSession";
}
function commandDenyDecision(params) {
    const available = effectiveCodexCommandDecisions(params);
    const networkDeny = available.find((decision) => decision?.applyNetworkPolicyAmendment?.network_policy_amendment?.action === "deny");
    if (networkDeny)
        return networkDeny;
    if (available.includes("decline"))
        return "decline";
    if (available.includes("cancel"))
        return "cancel";
    return "decline";
}
function effectiveCodexCommandDecisions(params) {
    if (Array.isArray(params?.availableDecisions))
        return params.availableDecisions;
    const networkApprovalContext = params?.networkApprovalContext ?? params?.network_approval_context;
    const additionalPermissions = params?.additionalPermissions ?? params?.additional_permissions;
    const proposedExecpolicyAmendment = params?.proposedExecPolicyAmendment ?? params?.proposedExecpolicyAmendment;
    const proposedNetworkPolicyAmendments = Array.isArray(params?.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments
        : [];
    if (networkApprovalContext) {
        const decisions = ["accept", "acceptForSession"];
        for (const amendment of proposedNetworkPolicyAmendments) {
            if (amendment?.action === "allow") {
                decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
                break;
            }
        }
        decisions.push("cancel");
        return decisions;
    }
    if (additionalPermissions)
        return ["accept", "cancel"];
    const decisions = ["accept"];
    if (proposedExecpolicyAmendment) {
        decisions.push({
            acceptWithExecpolicyAmendment: {
                execpolicy_amendment: proposedExecpolicyAmendment,
            },
        });
    }
    decisions.push("cancel");
    return decisions;
}
function extractRequestDetail(params) {
    const cmd = typeof params?.command === "string"
        ? params.command
        : Array.isArray(params?.command)
            ? params.command.join(" ")
            : "";
    if (cmd)
        return cmd.slice(0, 200);
    if (typeof params?.reason === "string" && params.reason.trim()) {
        return params.reason.slice(0, 200);
    }
    if (typeof params?.cwd === "string" && params.cwd.trim()) {
        return params.cwd.slice(0, 200);
    }
    return "";
}
// Based on official codex app-server-protocol schemas:
// ToolRequestUserInputParams: { questions: [{ id, question, header, options?: [{ label, description }] }] }
// McpServerElicitationRequestParams: { message, ... }
function normalizeQuestions(method, params) {
    if (method === "item/tool/requestUserInput") {
        const qs = Array.isArray(params?.questions) ? params.questions : [];
        return qs.map((q) => ({
            question: String(q?.question ?? ""),
            header: String(q?.header ?? ""),
            options: Array.isArray(q?.options)
                ? q.options.map((o) => ({
                    label: String(o?.label ?? ""),
                    description: String(o?.description ?? ""),
                    preview: "",
                }))
                : [],
        }));
    }
    if (method === "mcpServer/elicitation/request") {
        return [
            {
                question: String(params?.message ?? "MCP server asks for input"),
                header: "MCP Input",
                options: [
                    { label: "accept", description: "Provide acceptance", preview: "" },
                    { label: "decline", description: "Decline request", preview: "" },
                ],
            },
        ];
    }
    return [];
}
function parseQuestionAnswers(questions, answer) {
    const rpcAnswers = {};
    const displayAnswers = {};
    let parsedAnswer = null;
    if (answer && answer !== "skip") {
        try {
            const parsed = JSON.parse(answer);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                parsedAnswer = parsed;
            }
        }
        catch {
            parsedAnswer = null;
        }
    }
    const split = answer
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    for (let i = 0; i < questions.length; i++) {
        const question = questions[i] ?? {};
        const qid = String(question.id ?? `q${i + 1}`);
        const displayKey = String(question.question ?? question.header ?? qid);
        const value = extractAnswerValue(parsedAnswer, question, qid, displayKey);
        const normalized = value ?? split[i] ?? split[0] ?? "skip";
        rpcAnswers[qid] = { answers: [normalized] };
        displayAnswers[displayKey] = normalized;
    }
    return { rpcAnswers, displayAnswers };
}
function extractAnswerValue(parsedAnswer, question, qid, displayKey) {
    if (!parsedAnswer)
        return null;
    const direct = parsedAnswer[qid] ??
        parsedAnswer[displayKey] ??
        parsedAnswer[String(question?.header ?? "")];
    return normalizeAnswerValue(direct);
}
function normalizeAnswerValue(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed || null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const normalized = normalizeAnswerValue(item);
            if (normalized)
                return normalized;
        }
        return null;
    }
    if (value && typeof value === "object") {
        const maybeAnswers = value.answers;
        if (Array.isArray(maybeAnswers) && maybeAnswers.length > 0) {
            return normalizeAnswerValue(maybeAnswers[0]);
        }
        const maybeAnswer = value.answer;
        return normalizeAnswerValue(maybeAnswer);
    }
    return null;
}
