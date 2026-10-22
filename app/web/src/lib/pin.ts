// Local unlock stub (v0 brief: "local PIN/biometric stub"). This is a convenience lock on this
// browser only — it is NOT authentication and is not verified server-side. Anyone with devtools
// access to this profile can bypass it; the real session is the Convex Auth token.

const HASH_KEY = "teamchat.pinHash.v1";
const UNLOCKED_KEY = "teamchat.unlocked.v1";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`teamchat-pin:${input}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hasLocalPin(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(HASH_KEY) !== null;
}

export async function setLocalPin(pin: string): Promise<void> {
  window.localStorage.setItem(HASH_KEY, await sha256Hex(pin));
  window.sessionStorage.setItem(UNLOCKED_KEY, "1");
}

export function clearLocalPin(): void {
  window.localStorage.removeItem(HASH_KEY);
  window.sessionStorage.removeItem(UNLOCKED_KEY);
}

export async function verifyLocalPin(pin: string): Promise<boolean> {
  const stored = window.localStorage.getItem(HASH_KEY);
  if (stored === null) return true;
  return (await sha256Hex(pin)) === stored;
}

export function markUnlocked(): void {
  window.sessionStorage.setItem(UNLOCKED_KEY, "1");
}

/** Re-lock this tab (clears the per-session unlock flag; the PIN itself stays stored). */
export function lockLocal(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(UNLOCKED_KEY);
}

export function isUnlockedThisSession(): boolean {
  return typeof window !== "undefined" && window.sessionStorage.getItem(UNLOCKED_KEY) === "1";
}

/** Stub: reports whether the platform has a biometric authenticator (no credential is checked). */
export async function platformBiometricAvailable(): Promise<boolean> {
  try {
    const pk = window.PublicKeyCredential;
    if (pk === undefined) return false;
    return await pk.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}
