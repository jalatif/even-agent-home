export async function getKey(token: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  
  // Actually, node backend uses simple SHA256 of the token.
  // We need to implement exactly SHA256(token) to match backend.
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', enc.encode(token));
  return window.crypto.subtle.importKey(
    "raw",
    hashBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPayload(data: string, token: string): Promise<string> {
  const key = await getKey(token);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    enc.encode(data)
  );
  
  // AES-GCM output in WebCrypto appends the 16-byte auth tag at the end.
  // Backend expects: iv(12) + authTag(16) + encrypted
  const encryptedArray = new Uint8Array(encryptedBuffer);
  const actualCiphertext = encryptedArray.slice(0, encryptedArray.length - 16);
  const authTag = encryptedArray.slice(encryptedArray.length - 16);
  
  const payload = new Uint8Array(12 + 16 + actualCiphertext.length);
  payload.set(iv, 0);
  payload.set(authTag, 12);
  payload.set(actualCiphertext, 28);
  
  return btoa(String.fromCharCode(...payload));
}

export async function decryptPayload(base64String: string, token: string): Promise<string> {
  const binaryString = atob(base64String);
  const payload = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    payload[i] = binaryString.charCodeAt(i);
  }
  
  if (payload.length < 28) throw new Error("Invalid payload length");
  
  const iv = payload.slice(0, 12);
  const authTag = payload.slice(12, 28);
  const actualCiphertext = payload.slice(28);
  
  // WebCrypto expects: ciphertext + authTag
  const dataToDecrypt = new Uint8Array(actualCiphertext.length + 16);
  dataToDecrypt.set(actualCiphertext, 0);
  dataToDecrypt.set(authTag, actualCiphertext.length);
  
  const key = await getKey(token);
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key,
    dataToDecrypt
  );
  
  const dec = new TextDecoder();
  return dec.decode(decryptedBuffer);
}
