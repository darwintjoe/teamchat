// Crypto helpers. All of these run in the default Convex V8 runtime via WebCrypto.
//
// Envelope encryption for `byosCredentials` (lives only here and in `storage/creds.ts`):
//   master key (env TEAMCHAT_MASTER_KEY, base64, 32 bytes, version 1)
//     └─ wraps a random 32-byte data key (AES-GCM, iv1, 16-byte tag ⇒ 48 bytes)
//          └─ encrypts the credential JSON (AES-GCM, iv2, 16-byte tag)
//   stored ciphertext = base64(iv1 | wrappedDek | iv2 | payload)

const KEY_VERSION = 1;

function masterKeyBytes(): Uint8Array {
  const raw = process.env.TEAMCHAT_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "TEAMCHAT_MASTER_KEY is not set on this deployment. " +
        "Generate 32 random bytes, base64-encode them, and `npx convex env set TEAMCHAT_MASTER_KEY <value>`.",
    );
  }
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 32) {
    throw new Error("TEAMCHAT_MASTER_KEY must decode to exactly 32 bytes.");
  }
  return bytes;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  // `new Uint8Array(raw)` normalises to an ArrayBuffer-backed view (TS 5.7+ BufferSource).
  return await crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptSecret(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
  const kek = await importAesKey(masterKeyBytes());
  const dekRaw = new Uint8Array(32);
  crypto.getRandomValues(dekRaw);
  const iv1 = new Uint8Array(12);
  crypto.getRandomValues(iv1);
  const iv2 = new Uint8Array(12);
  crypto.getRandomValues(iv2);
  const wrappedDek = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv1 }, kek, dekRaw),
  );
  const dek = await importAesKey(dekRaw);
  const payload = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv2 },
      dek,
      new TextEncoder().encode(plaintext),
    ),
  );
  return { ciphertext: toBase64(concat(iv1, wrappedDek, iv2, payload)), keyVersion: KEY_VERSION };
}

export async function decryptSecret(ciphertext: string, keyVersion: number): Promise<string> {
  if (keyVersion !== KEY_VERSION) {
    throw new Error(`Unsupported master key version ${keyVersion}; this build knows version ${KEY_VERSION}.`);
  }
  const all = fromBase64(ciphertext);
  const iv1 = all.slice(0, 12);
  const wrappedDek = all.slice(12, 60);
  const iv2 = all.slice(60, 72);
  const payload = all.slice(72);
  const kek = await importAesKey(masterKeyBytes());
  let dekRaw: Uint8Array;
  try {
    dekRaw = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv1 }, kek, wrappedDek),
    );
  } catch {
    throw new Error("Could not unwrap the data key: wrong master key or corrupt ciphertext.");
  }
  const dek = await importAesKey(dekRaw);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv2 }, dek, payload);
  return new TextDecoder().decode(plaintext);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
