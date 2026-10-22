// Local PIN / biometric unlock — the v0 stub required by the auth wrapper build item.
//
// DELIBERATELY SERVER-FREE. This is a local device gate, not a second factor: the Convex session
// is the only credential that authenticates anything, and the PIN merely re-opens the local UI
// after the app is backgrounded. Nothing about the PIN is ever sent to or stored on the server.
//
// Both thin clients implement the same small contract against local storage only:
//     setLocalPin(pin)   → salted SHA-256 stored locally
//     verifyLocalPin(pin) → boolean
//     enableBiometric()  → stub: marks the local flag (platform check in the client)
//     isLocked()/lock()/unlock()
//
// Web: localStorage key below. Mobile: expo-secure-store (see app/mobile/lib/localUnlock.ts —
// same functions, different storage).
//
// This is a stub in the honest sense: biometrics do not yet gate a keychain-held credential,
// and a reinstall clears the gate. It exists so the UX flow is real and testable in v0.

export const LOCAL_UNLOCK_STORAGE_KEY = "teamchat.localUnlock.v1";

export type LocalUnlockRecord =
  | { mode: "pin"; salt: string; hash: string }
  | { mode: "biometric" };
