export function isBlacklistedMessage(text) {
    if (typeof text !== 'string') return true;
    const trimmed = text.trim();
    // Filter out empty strings, single dots, multiple dots, etc.
    if (!trimmed) return true;
    if (/^\.+$/.test(trimmed)) return true;
    return false;
}

export function filterHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.filter(msg => !isBlacklistedMessage(msg.text));
}
