import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

// Local unlock stub (v0 brief: "local PIN/biometric stub"). This gates the UI on this device only;
// it is NOT authentication and is never sent to the server. The real session is the Convex Auth
// token in secure storage. A device owner who can read the keychain can bypass it.

const PIN_KEY = "teamchat.pin.hash.v1";
const WEB_PIN_KEY = "teamchat.pin.hash.web.v1";

async function readStoredPin(): Promise<string | null> {
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(WEB_PIN_KEY) ?? null;
  return SecureStore.getItemAsync(PIN_KEY);
}

async function writeStoredPin(value: string): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(WEB_PIN_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(PIN_KEY, value);
}

async function removeStoredPin(): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.localStorage?.removeItem(WEB_PIN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(PIN_KEY);
}

export async function hasLocalPin(): Promise<boolean> {
  return (await readStoredPin()) !== null;
}

async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `teamchat-pin:${pin}`,
  );
}

export async function setLocalPin(pin: string): Promise<void> {
  await writeStoredPin(await hashPin(pin));
}

export async function clearLocalPin(): Promise<void> {
  await removeStoredPin();
}

export async function verifyLocalPin(pin: string): Promise<boolean> {
  const stored = await readStoredPin();
  if (stored === null) return true;
  return (await hashPin(pin)) === stored;
}

export async function biometricAvailable(): Promise<boolean> {
  try {
    if (Platform.OS === "web") return false;
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** Stub: asks the OS for biometrics. No credential is checked against the TeamChat account. */
export async function unlockWithBiometrics(): Promise<boolean> {
  try {
    if (Platform.OS === "web") return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock TeamChat",
      cancelLabel: "Use PIN",
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
