import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { TokenStorage } from "@convex-dev/auth/react";

/**
 * Convex Auth token storage. On React Native the default browser storage does not exist; the
 * tokens live in the OS keychain/keystore via expo-secure-store. This is what makes the 30-day
 * session survive an app restart. Expo web is supported only for local smoke testing — it falls
 * back to localStorage, so treat the web target as a development aid, not a shipping client.
 */
const webStorage: TokenStorage = {
  getItem: (key) => globalThis.localStorage?.getItem(key),
  setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
  removeItem: (key) => globalThis.localStorage?.removeItem(key),
};

export const secureTokenStorage: TokenStorage =
  Platform.OS === "web"
    ? webStorage
    : {
        getItem: (key) => SecureStore.getItemAsync(key),
        setItem: (key, value) => SecureStore.setItemAsync(key, value),
        removeItem: (key) => SecureStore.deleteItemAsync(key),
      };
