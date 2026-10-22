import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../lib/convex";
import { errorMessage } from "../lib/errors";
import { COLORS, radius } from "../theme";
import { DemoBanner } from "./DemoBanner";

type Step = "email" | "code";

export function SignInScreen({
  hasCache,
  onOpenCache,
}: {
  hasCache: boolean;
  onOpenCache: () => void;
}) {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<Step>("email");
  const [emailInput, setEmailInput] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = emailInput.trim().toLowerCase();
  const echo = useQuery(
    api.auth.demo.getEchoedCode,
    step === "code" && email !== "" ? { email } : "skip",
  );

  async function requestCode() {
    if (email === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn("email", { email });
      setStep("code");
      setCode("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (code.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signIn("email", { email, code: code.trim() });
      if (result.signingIn) return; // auth state flips and this screen unmounts
      setError("That code was not accepted. Request a new one.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <DemoBanner />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text style={styles.logo}>TeamChat</Text>
            <Text style={styles.sub}>
              {step === "email"
                ? "Sign in with a one-time code. New here? Entering an email creates an active account."
                : `Enter the demo code for ${email}.`}
            </Text>

            {step === "email" ? (
              <View style={styles.form}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={emailInput}
                  onChangeText={setEmailInput}
                  placeholder="you@example.com"
                  placeholderTextColor={COLORS.muted}
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  editable={!busy}
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.primary,
                    (pressed || busy || email === "") && styles.dim,
                  ]}
                  onPress={() => void requestCode()}
                  disabled={busy || email === ""}
                >
                  {busy ? (
                    <ActivityIndicator color={COLORS.accentInk} />
                  ) : (
                    <Text style={styles.primaryText}>Send code</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <View style={styles.form}>
                <View style={styles.echoBox}>
                  {echo !== undefined && echo !== null ? (
                    <>
                      <Text style={styles.echoLabel}>
                        Demo build — the “emailed” code is
                      </Text>
                      <Text style={styles.echoCode}>{echo.code}</Text>
                      <View style={styles.echoRow}>
                        <Pressable onPress={() => setCode(echo.code)}>
                          <Text style={styles.link}>Fill it in</Text>
                        </Pressable>
                        <Text style={styles.hint}>
                          expires {new Date(echo.expiresAt).toLocaleTimeString()}
                        </Text>
                      </View>
                    </>
                  ) : (
                    <Text style={styles.hint}>
                      Waiting for the demo code to appear… (it is generated server-side when the
                      email “sends”)
                    </Text>
                  )}
                </View>

                <Text style={styles.label}>One-time code</Text>
                <TextInput
                  style={styles.input}
                  value={code}
                  onChangeText={setCode}
                  placeholder="123456"
                  placeholderTextColor={COLORS.muted}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  editable={!busy}
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.primary,
                    (pressed || busy || code.trim() === "") && styles.dim,
                  ]}
                  onPress={() => void verifyCode()}
                  disabled={busy || code.trim() === ""}
                >
                  {busy ? (
                    <ActivityIndicator color={COLORS.accentInk} />
                  ) : (
                    <Text style={styles.primaryText}>Verify & sign in</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.secondary}
                  onPress={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                  }}
                  disabled={busy}
                >
                  <Text style={styles.secondaryText}>Change email</Text>
                </Pressable>
                <Text style={styles.hint}>
                  Codes are single-use and expire after 3 minutes. This session lasts 30 days of
                  inactivity.
                </Text>
              </View>
            )}

            {error !== null ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          {hasCache ? (
            <Pressable style={styles.cacheButton} onPress={onOpenCache}>
              <Text style={styles.cacheTitle}>Read cached messages</Text>
              <Text style={styles.cacheSub}>
                The newest 100 messages per conversation are stored on this device and can be read
                without a network or a session.
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
    gap: 16,
  },
  card: {
    backgroundColor: COLORS.panel,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 20,
  },
  logo: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  sub: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    marginBottom: 18,
  },
  form: { gap: 8 },
  label: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 4,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
  },
  primary: {
    backgroundColor: COLORS.accent,
    borderRadius: radius.sm,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  dim: { opacity: 0.55 },
  primaryText: {
    color: COLORS.accentInk,
    fontWeight: "700",
    fontSize: 14,
  },
  secondary: {
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryText: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  echoBox: {
    backgroundColor: COLORS.panel2,
    borderColor: COLORS.warnBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 4,
    gap: 4,
  },
  echoLabel: { color: COLORS.warnText, fontSize: 12 },
  echoCode: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: 5,
    marginVertical: 2,
  },
  echoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  link: { color: COLORS.accent, fontSize: 13, fontWeight: "600" },
  hint: { color: COLORS.muted, fontSize: 12, lineHeight: 17 },
  error: {
    color: COLORS.danger,
    fontSize: 12.5,
    marginTop: 12,
  },
  cacheButton: {
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    backgroundColor: COLORS.panel,
    gap: 3,
  },
  cacheTitle: { color: COLORS.ok, fontSize: 14, fontWeight: "700" },
  cacheSub: { color: COLORS.muted, fontSize: 12, lineHeight: 17 },
});
