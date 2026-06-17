import { truncate } from "../summary-format.js";
export function mapCodexItemTypeToToolName(type) {
    switch (type) {
        case "commandExecution": return "Shell";
        case "fileChange": return "FileEdit";
        case "mcpToolCall": return "Mcp";
        case "dynamicToolCall": return "Tool";
        case "webSearch": return "WebSearch";
        case "imageView": return "ImageView";
        case "imageGeneration": return "ImageGeneration";
        case "collabAgentToolCall": return "Agent";
        default: return String(type ?? "Tool");
    }
}
export function summarizeCodexItem(item) {
    const type = String(item?.type ?? "tool");
    if (type === "commandExecution") {
        const cmd = String(item?.command ?? "").trim();
        return cmd ? `Shell ${truncate(cmd, 50)}` : "Shell command";
    }
    if (type === "fileChange") {
        const changes = Array.isArray(item?.changes) ? item.changes.length : 0;
        return changes > 0 ? `FileEdit (${changes} files)` : "FileEdit";
    }
    if (type === "webSearch") {
        const q = String(item?.query ?? "").trim();
        return q ? `Search "${truncate(q, 40)}"` : "Web search";
    }
    return mapCodexItemTypeToToolName(type);
}
export function summarizeCodexRequest(params, method) {
    if (method.includes("commandExecution") || method === "execCommandApproval") {
        const cmd = typeof params?.command === "string"
            ? params.command
            : Array.isArray(params?.command)
                ? params.command.join(" ")
                : "";
        return cmd ? `Shell ${truncate(cmd, 50)}` : "Run command";
    }
    if (method.includes("fileChange") || method === "applyPatchApproval") {
        return "Apply file changes";
    }
    if (method.includes("permissions")) {
        return "Request additional permissions";
    }
    return method;
}
export function mapCodexRequestMethodToToolName(method) {
    if (method.includes("commandExecution") || method === "execCommandApproval")
        return "Shell";
    if (method.includes("fileChange") || method === "applyPatchApproval")
        return "FileEdit";
    if (method.includes("permissions"))
        return "Config";
    if (method.includes("mcp"))
        return "Mcp";
    return "Tool";
}
