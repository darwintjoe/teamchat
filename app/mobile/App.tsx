import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import { convex } from "./src/lib/convex";
import { secureTokenStorage } from "./src/lib/storage";
import { hasAnyCache } from "./src/lib/cache";
import { COLORS } from "./src/theme";
import { SignInScreen } from "./src/components/SignInScreen";
import { WorkspaceScreen } from "./src/components/WorkspaceScreen";
import { OfflineScreen } from "./src/components/OfflineScreen";

/**
 * Thin mobile client. The local cache is reachable without a session so the newest 100 messages
 * of every opened conversation stay readable after an app restart, including with no network.
 */
function Root() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const [cacheOpen, setCacheOpen] = useState(false);
  const [hasCache, setHasCache] = useState(false);

  useEffect(() => {
    void hasAnyCache().then(setHasCache);
  }, []);

  if (cacheOpen) {
    return (
      <OfflineScreen
        onClose={() => {
          setCacheOpen(false);
          void hasAnyCache().then(setHasCache);
        }}
      />
    );
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.accent} />
        <Text style={styles.loading}>Loading session…</Text>
      </View>
    );
  }

  return isAuthenticated ? (
    <WorkspaceScreen onOpenCache={() => setCacheOpen(true)} />
  ) : (
    <SignInScreen hasCache={hasCache} onOpenCache={() => setCacheOpen(true)} />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ConvexAuthProvider client={convex} storage={secureTokenStorage}>
        <StatusBar style="light" />
        <Root />
      </ConvexAuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.bg,
    gap: 12,
  },
  loading: {
    color: COLORS.muted,
    fontSize: 14,
  },
});
