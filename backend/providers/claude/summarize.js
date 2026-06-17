import { fileName, truncate } from "../summary-format.js";
/**
 * Summarize Claude SDK tool calls for glasses display.
 * Style: concise, single-line labels like VS Code Claude Code sidebar.
 */
export function summarizeClaudeToolCall(toolName, input) {
    switch (toolName) {
        case "Bash": {
            // Prefer Claude's short description, fall back to the command if needed.
            const description = truncate(input.description ?? input.command ?? "command", 50);
            return `Bash ${description}`;
        }
        case "Read": {
            // "Read api.ts (lines 200-250)"
            const name = fileName(input.file_path);
            const offset = input.offset;
            const limit = input.limit;
            if (offset !== undefined && limit !== undefined)
                return `Read ${name} (lines ${offset}-${offset + limit})`;
            if (limit !== undefined)
                return `Read ${name} (${limit} lines)`;
            return `Read ${name}`;
        }
        case "Edit": {
            // "Edit api.ts +15 lines"
            const name = fileName(input.file_path);
            const newStr = input.new_string;
            const oldStr = input.old_string;
            const added = newStr ? newStr.split("\n").length : 0;
            const removed = oldStr ? oldStr.split("\n").length : 0;
            const delta = added - removed;
            if (delta > 0)
                return `Edit ${name} +${delta} lines`;
            if (delta < 0)
                return `Edit ${name} ${delta} lines`;
            return `Edit ${name} ~${added} lines`;
        }
        case "Write": {
            // "Write api.ts (120 lines)"
            const name = fileName(input.file_path);
            const lines = input.content ? input.content.split("\n").length : 0;
            return `Write ${name} (${lines} lines)`;
        }
        case "Glob":
            return `Glob ${truncate(input.pattern, 40)}`;
        case "Grep":
            return `Grep "${truncate(input.pattern, 25)}"`;
        case "Agent":
            return `Agent ${truncate(input.description ?? "", 40)}`;
        case "Skill":
            return `Skill ${truncate(String(input.skill ?? input.name ?? ""), 40)}`.trim();
        case "TodoWrite":
            return "TodoWrite update tasks";
        case "WebSearch":
            return `Search "${truncate(input.query ?? "", 30)}"`;
        case "WebFetch":
            return `Fetch ${truncate(input.url ?? "", 40)}`;
        case "ToolSearch":
            return `ToolSearch ${truncate(input.query, 40)}`;
        case "KillShell":
            return `Kill process ${input.pid ?? ""}`.trim();
        case "Config":
            return `Config ${input.action ?? ""} ${truncate(String(input.key ?? ""), 30)}`.trim();
        case "Mcp":
            return `MCP ${input.server_name ?? ""}.${truncate(String(input.tool_name ?? ""), 30)}`;
        case "RemoteTrigger":
            return `Trigger ${input.action ?? "manage"}`;
        case "NotebookEdit":
            return `NotebookEdit ${input.command ?? "edit"}`;
        case "ExitPlanMode":
            return "ExitPlanMode";
        case "ListMcpResources":
            return "ListMcpResources";
        case "ReadMcpResource":
            return `ReadMcpResource ${truncate(String(input.uri ?? ""), 40)}`;
        case "TaskOutput":
            return `Agent ${truncate(String(input.task_id ?? ""), 30)}`.trim();
        case "TaskCreate":
            return `Agent ${truncate(String(input.subject ?? input.description ?? ""), 40)}`;
        case "TaskUpdate":
            return `Agent ${truncate(String(input.subject ?? ""), 40)} ${input.status ?? ""}`.trim();
        case "TaskGet":
        case "TaskList":
        case "TaskStop":
            return `Agent ${toolName.replace("Task", "").toLowerCase()}`;
        case "AskUserQuestion":
            return "AskUserQuestion";
        default: {
            // Rename any Task-prefixed tools to "Agent" for glasses display.
            const displayName = toolName.startsWith("Task") ? "Agent" : toolName;
            const detail = input.subject || input.description || input.content || input.taskId || input.action || "";
            return detail ? `${displayName} ${truncate(String(detail), 40)}` : displayName;
        }
    }
}
