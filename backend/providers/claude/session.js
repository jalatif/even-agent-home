import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { summarizeClaudeToolCall } from "./summarize.js";
import { debugLog } from "../debug.js";
function buildClaudePermissionOptions(suggestions, description) {
    const options = [
        { text: "Yes", key: "allow" },
    ];
    const alwaysText = describeClaudePermissionSuggestions(suggestions, description);
    if (alwaysText) {
        options.push({ text: alwaysText, key: "allowAlways" });
    }
    options.push({ text: "No", key: "deny" });
    return options;
}
function describeClaudePermissionSuggestions(suggestions, placeholderText) {
    const first = suggestions?.[0];
    if (!first)
        return null;
    if (first.type === "addDirectories" && Array.isArray(first.directories) && first.directories.length > 0) {
        return `Yes, and always allow access to ${joinQuoted(first.directories)} ${describeClaudeDestination(first.destination)}`;
    }
    if ((first.type === "addRules" || first.type === "replaceRules") && Array.isArray(first.rules) && first.rules.length > 0) {
        const rule = first.rules[0] ?? {};
        const toolName = String(rule.toolName ?? "this tool");
        const ruleContent = typeof rule.ruleContent === "string" && rule.ruleContent.trim()
            ? ` rule ${quoteInline(rule.ruleContent.trim())}`
            : "";
        const behavior = typeof first.behavior === "string" ? first.behavior : "allow";
        return `Yes, and always ${behavior} ${toolName}${ruleContent} ${describeClaudeDestination(first.destination)}`;
    }
    if (first.type === "setMode" && typeof first.mode === "string") {
        return `Yes, and use ${quoteInline(first.mode)} permission mode ${describeClaudeDestination(first.destination)}`;
    }
    return suggestions?.length ? placeholderText : null;
}
function describeClaudeDestination(destination) {
    switch (destination) {
        case "session": return "for this session";
        case "projectSettings": return "for this project";
        case "localSettings": return "in local settings";
        case "userSettings": return "in user settings";
        case "cliArg": return "from CLI settings";
        default: return "for this project";
    }
}
function quoteInline(value) {
    return `\`${String(value)}\``;
}
function joinQuoted(values) {
    return values.map((value) => quoteInline(value)).join(", ");
}
// ── ClaudeSession ─────────────────────────────────────────
export class ClaudeSession {
    sessionId;
    lockedCwd;
    emit;
    _busy = false;
    busyEmitted = false;
    turnStartMs = 0;
    runningInputTokens = 0;
    runningOutputTokens = 0;
    currentMsgOutputTokens = 0;
    statsTimer = null;
    queryHandle = null;
    runningQuery = null;
    pendingPermissions = [];
    pendingQuestions = [];
    alwaysAllowedTools = new Set();
    pendingToolCalls = new Map();
    /** Tracks the type of the currently-open content block ("thinking" | "text" | null). */
    currentBlockType = null;
    idResolve = null;
    idPromise = null;
    idReadyCallbacks = [];
    promptQueue = [];
    constructor(emit) {
        this.emit = emit;
    }
    get id() {
        return this.sessionId;
    }
    get cwd() {
        return this.lockedCwd;
    }
    get busy() {
        return this._busy;
    }
    get alive() {
        return !!this.sessionId;
    }
    /** Tracked session status: 'awaiting' if there's an unanswered permission
     *  request or user question, otherwise 'busy'/'idle' based on _busy. */
    get status() {
        if (this.pendingPermissions.length > 0 || this.pendingQuestions.length > 0) {
            return "awaiting";
        }
        return this._busy ? "busy" : "idle";
    }
    waitForId(timeoutMs = 10000) {
        if (this.sessionId)
            return Promise.resolve(this.sessionId);
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
        if (this.sessionId) {
            cb(this.sessionId);
        }
        else {
            this.idReadyCallbacks.push(cb);
        }
    }
    setSessionId(id) {
        // Don't overwrite an existing session ID. SDK hook messages (e.g.
        // SessionStart:resume) carry their own ephemeral session_id which would
        // otherwise clobber the real conversation session ID.
        if (this.sessionId)
            return;
        this.sessionId = id;
        if (this.idResolve) {
            this.idResolve(id);
            this.idResolve = null;
        }
        for (const cb of this.idReadyCallbacks)
            cb(id);
        this.idReadyCallbacks = [];
    }
    get runningStats() {
        return {
            durationMs: this.turnStartMs ? Date.now() - this.turnStartMs : 0,
            inputTokens: this.runningInputTokens,
            outputTokens: this.runningOutputTokens + this.currentMsgOutputTokens,
        };
    }
    send(msg) {
        this.emit(this.sessionId ?? "", msg);
    }
    /**
     * Wait for a user response with timeout and SDK abort signal as fallbacks.
     * Multiple requests can be pending (e.g. subagents); resolved FIFO.
     */
    waitForUser(queue, signal, timeoutMs, defaultValue) {
        return new Promise((resolve) => {
            let settled = false;
            const entry = (value) => finish(value);
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                const idx = queue.indexOf(entry);
                if (idx !== -1)
                    queue.splice(idx, 1);
                resolve(value);
            };
            const timer = setTimeout(() => finish(defaultValue), timeoutMs);
            const onAbort = () => finish(defaultValue);
            signal.addEventListener("abort", onAbort, { once: true });
            queue.push(entry);
        });
    }
    respondPermission(decision) {
        this.pendingPermissions.shift()?.({
            allow: decision === "allow" || decision === "allowAlways",
            allowAlways: decision === "allowAlways",
        });
    }
    respondQuestion(answer) {
        this.pendingQuestions.shift()?.(answer);
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
    async start(sessionId, cwd) {
        await this.close();
        if (sessionId) {
            this.setSessionId(sessionId);
        }
        else {
            this.sessionId = undefined;
        }
        const requestedCwd = cwd ?? process.cwd();
        if (existsSync(requestedCwd)) {
            this.lockedCwd = requestedCwd;
        }
        else if (sessionId) {
            console.warn(`[session] CWD "${requestedCwd}" not found for session ${sessionId}, will attempt resume anyway`);
            this.lockedCwd = requestedCwd;
        }
        else {
            this.lockedCwd = process.cwd();
            console.warn(`[session] CWD "${requestedCwd}" not found, falling back to "${this.lockedCwd}"`);
        }
        console.log(`[session] Session configured: resume=${sessionId ?? "new"}, cwd=${this.lockedCwd}`);
    }
    async run(prompt) {
        console.log(`[session] run: alive=${this.alive}, busy=${this._busy}`);
        if (this._busy) {
            throw new Error("Session is busy");
        }
        this._busy = true;
        this.busyEmitted = false;
        this.currentBlockType = null;
        this.turnStartMs = Date.now();
        this.runningInputTokens = 0;
        this.runningOutputTokens = 0;
        this.currentMsgOutputTokens = 0;
        this.stopStatsTimer();
        this.statsTimer = setInterval(() => this.emitRunningStats(), 10000);
        console.log(`[session] Launching query: resume=${this.sessionId ?? "new"}, cwd=${this.lockedCwd}`);
        const q = query({
            prompt,
            options: {
                resume: this.sessionId,
                cwd: this.lockedCwd,
                model: "claude-opus-4-6",
                allowedTools: [
                    "Read", "Edit", "Glob", "Grep", "Agent",
                    "WebSearch", "WebFetch",
                    "TaskOutput", "ExitPlanMode",
                    "ListMcpResources", "ReadMcpResource",
                ],
                permissionMode: "acceptEdits",
                canUseTool: (toolName, input, opts) => this.handleCanUseTool(toolName, input, opts),
                hooks: {
                    Notification: [{
                            hooks: [
                                async (input, _toolUseID, _options) => {
                                    const title = (input.title || "Notice");
                                    const message = (input.message || "");
                                    console.log(`[session] Notification: ${title} — ${message}`);
                                    this.send({
                                        type: "notification",
                                        title,
                                        message,
                                    });
                                    return {};
                                }
                            ]
                        }],
                },
                includePartialMessages: true,
                maxTurns: 50,
                settingSources: ["user", "project"],
                stderr: (data) => {
                    const trimmed = data.trim();
                    if (trimmed)
                        console.error(`[cli stderr] ${trimmed}`);
                },
            },
        });
        this.queryHandle = q;
        this.runningQuery = (async () => {
            try {
                for await (const msg of q) {
                    this.processAndEmit(msg);
                }
            }
            catch (err) {
                if (err.name !== "AbortError") {
                    console.error(`[session] query error: ${err.message}`);
                    this.send({ type: "error", message: err.message });
                }
            }
            finally {
                console.log("[session] Query process ended, cleaning up");
                this._busy = false;
                this.queryHandle = null;
                this.stopStatsTimer();
                if (this.promptQueue.length > 0) {
                    this.dispatchNext();
                }
                else {
                    this.send({
                        type: "status",
                        state: "idle",
                        sessionId: this.sessionId,
                    });
                }
            }
        })();
    }
    /** Queue a prompt to run when the session becomes idle. */
    enqueue(prompt) {
        this.promptQueue.push(prompt);
        console.log(`[session] Enqueued prompt (queue size: ${this.promptQueue.length})`);
    }
    dispatchNext() {
        if (this.promptQueue.length === 0 || this._busy)
            return;
        const next = this.promptQueue.shift();
        console.log(`[session] Dispatching queued prompt (remaining: ${this.promptQueue.length})`);
        this.run(next).catch((err) => {
            console.error(`[session] Failed to dispatch queued prompt: ${err.message}`);
        });
    }
    interrupt() {
        this.queryHandle?.interrupt().catch(() => { });
    }
    async close() {
        const had = { query: !!this.queryHandle, running: !!this.runningQuery };
        console.log(`[session] close: session=${this.sessionId ?? "none"} had=${JSON.stringify(had)}`);
        this.stopStatsTimer();
        this.pendingPermissions.length = 0;
        this.pendingQuestions.length = 0;
        this.promptQueue.length = 0;
        if (this.queryHandle) {
            this.queryHandle.close();
            this.queryHandle = null;
        }
        if (this.runningQuery) {
            await this.runningQuery.catch(() => { });
            this.runningQuery = null;
        }
        this._busy = false;
        this.alwaysAllowedTools.clear();
        console.log("[session] close: done");
    }
    async reset(cwd) {
        await this.close();
        this.sessionId = undefined;
        this.lockedCwd = cwd;
    }
    // ── Tool handlers ──────────────────────────────────
    async handleCanUseTool(toolName, input, options) {
        console.log(`[session] canUseTool: ${toolName}`);
        if (toolName === "AskUserQuestion") {
            return this.handleAskUserQuestion(input, options.toolUseID, options.signal);
        }
        if (this.alwaysAllowedTools.has(toolName)) {
            console.log(`[session] Auto-approve (allowAlways): ${toolName}`);
            return { behavior: "allow", updatedInput: input };
        }
        const PERMISSION_TOOLS = new Set(["KillShell", "Config", "Mcp", "RemoteTrigger"]);
        if (PERMISSION_TOOLS.has(toolName)) {
            return this.handlePermissionConfirm(toolName, input, options.toolUseID, options.signal, options.suggestions);
        }
        if (toolName === "Bash") {
            const cmd = String(input.command || "").trim();
            if (/^\s*(ls|cat|head|tail|wc|pwd|echo|printf|date|whoami|which|where|type|file|stat|du|df|env|printenv|uname|hostname|id|git\s+(status|log|diff|branch|show|remote|rev-parse))\b/.test(cmd)) {
                return { behavior: "allow", updatedInput: input };
            }
            return this.handlePermissionConfirm(toolName, input, options.toolUseID, options.signal, options.suggestions);
        }
        if (toolName === "TodoWrite") {
            const todos = input.todos || [];
            const total = todos.length;
            const completed = todos.filter((t) => t.status === "completed").length;
            const active = todos.find((t) => t.status === "in_progress");
            const current = active
                ? active.content || active.activeForm || ""
                : completed === total && total > 0
                    ? "All done"
                    : "";
            if (total > 0) {
                this.send({
                    type: "task_progress",
                    completed,
                    total,
                    current,
                });
            }
            return { behavior: "allow", updatedInput: input };
        }
        if (toolName === "TaskUpdate") {
            const status = input.status;
            const subject = input.subject || input.description || "";
            if (status && subject) {
                console.log(`[session] TaskUpdate: ${status} "${subject}"`);
            }
            return { behavior: "allow", updatedInput: input };
        }
        console.log(`[session] canUseTool auto-approve: ${toolName} input_keys=${Object.keys(input).join(",")}`);
        return { behavior: "allow", updatedInput: input };
    }
    async handleAskUserQuestion(toolInput, toolUseID, signal) {
        const questions = toolInput.questions || [];
        console.log(`[session] User question request: toolUseId=${toolUseID} questions=${questions.length}`);
        debugLog("claude-session", "question request", JSON.stringify(questions));
        this.send({
            type: "user_question",
            questions: questions.map((q) => ({
                question: q.question || "",
                header: q.header || "",
                options: (q.options || []).map((o) => ({
                    label: o.label || "",
                    description: o.description || "",
                    preview: o.preview || "",
                })),
            })),
            toolUseId: toolUseID,
        });
        const answer = await this.waitForUser(this.pendingQuestions, signal, 120000, "skip");
        let answers = {};
        try {
            answers = JSON.parse(answer);
        }
        catch {
            for (const q of questions) {
                answers[q.question || q.header || ""] = answer;
            }
        }
        this.send({ type: "question_answer", answers });
        return {
            behavior: "allow",
            updatedInput: {
                questions: toolInput.questions,
                answers,
            },
        };
    }
    async handlePermissionConfirm(toolName, toolInput, toolUseID, signal, suggestions) {
        const description = summarizeClaudeToolCall(toolName, toolInput);
        let detail = "";
        if (toolInput.command)
            detail = String(toolInput.command).slice(0, 200);
        else if (toolInput.file_path)
            detail = String(toolInput.file_path).slice(0, 200);
        else if (toolInput.url)
            detail = String(toolInput.url).slice(0, 200);
        else if (toolInput.prompt)
            detail = String(toolInput.prompt).slice(0, 200);
        else if (toolInput.query)
            detail = String(toolInput.query).slice(0, 200);
        else if (toolInput.content)
            detail = String(toolInput.content).slice(0, 100) + "...";
        console.log(`[session] Permission request: ${toolName} desc="${description}" detail="${detail.slice(0, 80)}"`);
        debugLog("claude-session", `permission request ${toolName}`, JSON.stringify({
            toolName,
            toolUseID,
            description,
            detail,
            suggestions: suggestions ?? null,
            toolInput,
        }));
        const permissionOptions = buildClaudePermissionOptions(suggestions, description);
        this.send({
            type: "permission_request",
            toolName,
            description,
            detail,
            toolUseId: toolUseID,
            options: permissionOptions,
            suggestions: suggestions ?? null,
        });
        const result = await this.waitForUser(this.pendingPermissions, signal, 60000, { allow: false, allowAlways: false });
        let sdkDecision;
        if (result.allowAlways) {
            this.alwaysAllowedTools.add(toolName);
            sdkDecision = "always";
        }
        else if (result.allow) {
            sdkDecision = "allowed";
        }
        else {
            sdkDecision = "denied";
        }
        this.send({
            type: "permission_result",
            toolName,
            summary: description,
            decision: sdkDecision,
        });
        if (result.allow) {
            return {
                behavior: "allow",
                updatedInput: toolInput,
                updatedPermissions: result.allowAlways ? suggestions : undefined,
            };
        }
        return { behavior: "deny", message: "Denied by user" };
    }
    // ── Message processing ─────────────────────────────
    processAndEmit(msg) {
        debugLog("claude-sdk", JSON.stringify(msg));
        if ("session_id" in msg && msg.session_id) {
            this.setSessionId(msg.session_id);
        }
        // First message of the query — session ID is now known, emit busy
        if (!this.busyEmitted) {
            this.busyEmitted = true;
            this.send({ type: "status", state: "busy", sessionId: this.sessionId });
        }
        switch (msg.type) {
            case "stream_event":
                this.processStreamEvent(msg);
                break;
            case "assistant":
                this.processAssistant(msg);
                break;
            case "user":
                this.processUser(msg);
                break;
            case "result":
                this.emitResult(msg);
                break;
            case "system":
                this.processSystem(msg);
                break;
        }
    }
    processSystem(msg) {
        const m = msg;
        if (m.subtype === "api_retry") {
            const attempt = m.attempt ?? 0;
            const maxRetries = m.max_retries ?? 0;
            const delayMs = m.retry_delay_ms ?? 0;
            const status = m.error_status;
            console.log(`[session] API retry: attempt=${attempt}/${maxRetries} delay=${delayMs}ms status=${status}`);
            this.send({
                type: "notification",
                title: "API Retry",
                message: `Retrying (${attempt}/${maxRetries})${status ? `, HTTP ${status}` : ""}...`,
            });
        }
    }
    processStreamEvent(msg) {
        if (msg.type !== "stream_event")
            return;
        const event = msg.event;
        if (!event)
            return;
        // Track content block start/stop and emit sub-status events
        if (event.type === "content_block_start") {
            const blockType = event.content_block?.type;
            if (blockType === "thinking" || blockType === "text") {
                this.currentBlockType = blockType;
                const state = blockType === "thinking" ? "think_start" : "text_start";
                this.send({ type: "status", state, sessionId: this.sessionId });
            }
        }
        if (event.type === "content_block_stop" && this.currentBlockType) {
            const state = this.currentBlockType === "thinking" ? "think_end" : "text_end";
            this.currentBlockType = null;
            this.send({ type: "status", state, sessionId: this.sessionId });
        }
        if (event.type === "content_block_delta" &&
            event.delta?.type === "text_delta") {
            this.send({ type: "text_delta", text: event.delta.text });
        }
        if (event.type === "content_block_start" &&
            event.content_block?.type === "tool_use") {
            this.send({
                type: "tool_start",
                name: event.content_block.name,
                toolId: event.content_block.id,
            });
        }
        if (event.type === "message_start" && event.message?.usage) {
            this.runningOutputTokens += this.currentMsgOutputTokens;
            this.currentMsgOutputTokens = 0;
            const usage = event.message.usage;
            const input = usage.input_tokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? 0;
            const cacheCreate = usage.cache_creation_input_tokens ?? 0;
            this.runningInputTokens += input + cacheRead + cacheCreate;
            console.log(`[session] API call tokens: input=${input} cache_read=${cacheRead} cache_create=${cacheCreate} total_in=${input + cacheRead + cacheCreate} (running: in=${this.runningInputTokens} out=${this.runningOutputTokens})`);
        }
        if (event.type === "message_delta" && event.usage) {
            this.currentMsgOutputTokens = event.usage.output_tokens ?? 0;
        }
    }
    processAssistant(msg) {
        if (msg.type !== "assistant")
            return;
        const content = msg.message?.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (block.type === "tool_use") {
                this.pendingToolCalls.set(block.id, {
                    name: block.name,
                    input: block.input,
                });
            }
        }
    }
    processUser(msg) {
        if (msg.type !== "user")
            return;
        const content = msg.message?.content;
        if (!Array.isArray(content))
            return;
        for (const block of content) {
            if (block.type === "tool_result") {
                const toolId = block.tool_use_id;
                const pending = this.pendingToolCalls.get(toolId);
                if (!pending)
                    continue;
                this.pendingToolCalls.delete(toolId);
                let output;
                if (typeof block.content === "string") {
                    output = block.content;
                }
                else if (Array.isArray(block.content)) {
                    output = block.content
                        .filter((b) => b.type === "text")
                        .map((b) => b.text)
                        .join("\n");
                }
                this.send({
                    type: "tool_end",
                    name: pending.name,
                    toolId,
                    summary: summarizeClaudeToolCall(pending.name, pending.input),
                    detail: {
                        input: pending.input,
                        output,
                    },
                });
            }
        }
    }
    emitResult(msg) {
        const r = msg;
        this.stopStatsTimer();
        let inputTokens = 0;
        let outputTokens = 0;
        if (r.modelUsage) {
            for (const m of Object.values(r.modelUsage)) {
                inputTokens += m.inputTokens ?? 0;
                outputTokens += m.outputTokens ?? 0;
            }
        }
        let resultText = r.result ?? "";
        if (r.subtype !== "success") {
            const errors = r.errors?.join("\n") ?? "";
            console.error(`[session] Result error: subtype=${r.subtype} terminal_reason=${r.terminal_reason} errors=${JSON.stringify(r.errors)}`);
            // User-initiated interrupt: SDK signals via subtype=error_during_execution
            // + terminal_reason=aborted_streaming. Use a clean message.
            if (r.subtype === "error_during_execution" && r.terminal_reason === "aborted_streaming") {
                resultText = "Interrupted by user";
            }
            else
                switch (r.subtype) {
                    case "error_max_turns":
                        resultText = errors || `Reached max turns limit (${r.num_turns ?? 0} turns). Try breaking the task into smaller steps.`;
                        break;
                    case "error_max_budget_usd":
                        resultText = errors || "Session budget exhausted.";
                        break;
                    default:
                        resultText = errors;
                        break;
                }
        }
        console.log(`[session] Result: subtype=${r.subtype} turns=${r.num_turns ?? 0} cost=$${(r.total_cost_usd ?? 0).toFixed(4)} input=${inputTokens} output=${outputTokens}`);
        this.send({
            type: "result",
            success: r.subtype === "success",
            text: resultText,
            sessionId: r.session_id ?? this.sessionId ?? "",
            costUsd: r.total_cost_usd ?? 0,
            provider: "claude",
            turns: r.num_turns ?? 0,
            durationMs: r.duration_ms ?? 0,
            inputTokens,
            outputTokens,
        });
        // idle is emitted by the finally block when the query process ends
    }
}
