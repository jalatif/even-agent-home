const provider = {
    name: "pinggy",
    program: "ssh",
    buildArgs(port) {
        return ["-o", "StrictHostKeyChecking=no", "-p", "443", "-R0:localhost:" + String(port), "a.pinggy.io"];
    },
    parseUrl(output) {
        const httpsMatch = output.match(/https:\/\/[^\s]+\.pinggy(?:-free)?\.link/);
        if (httpsMatch)
            return httpsMatch[0];
        const httpMatch = output.match(/http:\/\/[^\s]+\.pinggy(?:-free)?\.link/);
        return httpMatch?.[0];
    },
};
export default provider;
