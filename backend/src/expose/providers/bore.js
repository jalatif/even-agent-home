const provider = {
    name: "bore",
    program: "bore",
    buildArgs(port) {
        return ["local", String(port), "--to", "bore.pub"];
    },
    parseUrl(output) {
        const match = output.match(/\blistening at\s+bore\.pub:(\d+)\b/i);
        if (!match)
            return undefined;
        return "http://bore.pub:" + match[1];
    },
};
export default provider;
