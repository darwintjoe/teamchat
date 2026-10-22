// Public identifiers. `_id` never crosses an API boundary (hard rule); every client-facing
// function speaks publicId strings like `grp_ab12cd34ef56`.

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 12 base-36 chars ≈ 62 bits of entropy; collision retries are not needed at v0 volumes. */
export function newPublicId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

/** 32 random bytes, base64url. Used for invite links — the raw token exists only in the link. */
export function newSecretToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
