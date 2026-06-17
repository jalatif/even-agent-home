import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

function getKey(token) {
    return createHash("sha256").update(token).digest();
}

export function encryptPayload(dataBuffer, token) {
    const key = getKey(token);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    
    let encrypted = cipher.update(dataBuffer);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Format: iv(12) + authTag(16) + encrypted
    const payload = Buffer.concat([iv, authTag, encrypted]);
    return payload.toString("base64");
}

export function decryptPayload(base64String, token) {
    const payload = Buffer.from(base64String, "base64");
    if (payload.length < 28) throw new Error("Invalid payload length");
    
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    
    const key = getKey(token);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted;
}
