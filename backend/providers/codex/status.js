export function codexThreadStatus(thread) {
    const statusType = String(thread?.status?.type ?? thread?.status ?? "");
    if (statusType === "active")
        return "busy";
    if (statusType === "waitingOnApproval" || statusType === "waitingOnUserInput")
        return "awaiting";
    if (statusType === "idle" || statusType === "completed" || statusType === "archived")
        return "idle";
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    if (turns.length === 0)
        return "idle";
    return turns[turns.length - 1]?.completedAt != null ? "idle" : "busy";
}
