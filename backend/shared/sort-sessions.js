const SORTED_SESSIONS_ENABLED = process.env.SORTED_SESSIONS === "1";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Check whether sorted-sessions mode is active.
 * Evaluated once at import time from the SORTED_SESSIONS env var.
 */
export function sortedSessionsEnabled() {
    return SORTED_SESSIONS_ENABLED;
}

/**
 * Sort sessions with named (titled) sessions younger than 7 days first,
 * followed by everything else, both groups ordered newest first.
 * This is a no-op when sorted-sessions mode is disabled.
 *
 * @param {{ id: string, title?: string, timestamp?: string }[]} sessions
 * @returns {typeof sessions}
 */
export function sortSessionList(sessions) {
    if (!SORTED_SESSIONS_ENABLED || sessions.length < 2) return sessions;

    const now = Date.now();
    return sessions.sort((a, b) => {
        const aTime = new Date(a.timestamp || 0).getTime();
        const bTime = new Date(b.timestamp || 0).getTime();
        const aRecentNamed = a.title && (now - aTime < SEVEN_DAYS_MS) ? 0 : 1;
        const bRecentNamed = b.title && (now - bTime < SEVEN_DAYS_MS) ? 0 : 1;
        if (aRecentNamed !== bRecentNamed) return aRecentNamed - bRecentNamed;
        return bTime - aTime;
    });
}
