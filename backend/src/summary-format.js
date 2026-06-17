export function fileName(filePath) {
    if (!filePath)
        return "file";
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
}
export function truncate(value, max) {
    const text = oneLine(value);
    if (!text)
        return "";
    return text.length > max ? text.slice(0, max) + "..." : text;
}
export function oneLine(value) {
    if (value === null || value === undefined)
        return "";
    return String(value).replace(/\s+/g, " ").trim();
}
