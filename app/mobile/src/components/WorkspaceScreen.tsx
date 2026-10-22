import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../lib/convex";
import type { Conversation } from "../lib/cache";
import { errorMessage } from "../lib/errors";
import { formatShort } from "../lib/format";
import {
  biometricAvailable,
  clearLocalPin,
  hasLocalPin,
  setLocalPin,
  unlockWithBiometrics,
  verifyLocalPin,
} from "../lib/pin";
import { COLORS, radius } from "../theme";
import { DemoBanner } from "./DemoBanner";
import { ConversationScreen } from "./ConversationScreen";

type ConversationRow = {
  kind: "group" | "dm";
  publicId: string | null;
  peerPublicId: string | null;
  peerName: string | null;
  name: string;
  path: string | null;
  orgPublicId: string | null;
  role: "owner" | "manager" | "member";
  lastMessageAt: number;
  lastReadAt: number | null;
};

type Selection = {
  conversation: Conversation;
  label: string;
  groupPath: string | null;
  orgPublicId: string | null;
};

function rowAddress(row: ConversationRow): Conversation | null {
  if (row.kind === "group" && row.publicId !== null) {
    return { kind: "group", publicId: row.publicId };
  }
  if (row.kind === "dm" && row.peerPublicId !== null) {
    return { kind: "dm", peerPublicId: row.peerPublicId };
  }
  return null;
}

function ConversationRowItem({
  row,
  onOpen,
}: {
  row: ConversationRow;
  onOpen: () => void;
}) {
  const conversation = rowAddress(row);
  const unreadArgs =
    conversation === null
      ? ("skip" as const)
      : conversation.kind === "group" && row.path !== null
        ? { conversation, groupPath: row.path }
        : { conversation };
  const unread = useQuery(api.unread.hasUnread, unreadArgs);

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => {
        if (conversation !== null) onOpen();
      }}
      disabled={conversation === null}
    >
      <View style={styles.flex}>
        <Text style={styles.rowName} numberOfLines={1}>
          {row.kind === "dm" ? "DM · " : ""}
          {row.name}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {row.kind === "group" ? row.path : "Direct message"}
          {row.lastMessageAt > 0 ? ` · ${formatShort(row.lastMessageAt)}` : ""}
        </Text>
      </View>
      {unread === true ? <View style={styles.unreadDot} accessibilityLabel="Unread" /> : null}
    </Pressable>
  );
}

/** Thin mobile workspace: the same flow as web — sessions, groups, live messages, photos, cache. */
export function WorkspaceScreen({ onOpenCache }: { onOpenCache: () => void }) {
  const { signOut } = useAuthActions();
  const me = useQuery(api.users.me);
  const conversations = useQuery(api.groups.listMine);

  const [selected, setSelected] = useState<Selection | null>(null);

  const [pinSet, setPinSet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [pinDraft, setPinDraft] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [biometric, setBiometric] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([hasLocalPin(), biometricAvailable()]).then(([hasPin, hasBiometric]) => {
      if (cancelled) return;
      setPinSet(hasPin);
      setBiometric(hasBiometric);
      if (hasPin) setLocked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = (conversations ?? []) as ConversationRow[];

  function openRow(row: ConversationRow) {
    const conversation = rowAddress(row);
    if (conversation === null) return;
    setSelected({
      conversation,
      label: row.kind === "dm" ? (row.peerName ?? row.name) : row.name,
      groupPath: row.kind === "group" ? row.path : null,
      orgPublicId: row.kind === "group" ? row.orgPublicId : null,
    });
  }

  async function savePin() {
    const value = pinDraft.trim();
    if (value.length < 4) {
      setPinError("Use at least 4 characters");
      return;
    }
    setBusy(true);
    setPinError(null);
    try {
      await setLocalPin(value);
      setPinDraft("");
      setPinSet(true);
      setLocked(false);
      setPinModal(false);
    } catch (caught) {
      setPinError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (selected !== null) {
    return (
      <ConversationScreen
        conversation={selected.conversation}
        label={selected.label}
        groupPath={selected.groupPath}
        orgPublicId={selected.orgPublicId}
        myPublicId={me?.publicId ?? ""}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <DemoBanner />

      <View style={styles.topBar}>
        <View style={styles.flex}>
          <Text style={styles.logo}>
            TeamChat <Text style={styles.logoBadge}>v0</Text>
          </Text>
          <Text style={styles.user} numberOfLines={1}>
            {me?.name ?? "…"} · {me?.email ?? ""}
          </Text>
        </View>
        <Pressable style={styles.topButton} onPress={onOpenCache}>
          <Text style={styles.topButtonText}>Cache</Text>
        </Pressable>
        <Pressable
          style={styles.topButton}
          onPress={() => {
            setPinDraft("");
            setPinError(null);
            setPinModal(true);
          }}
        >
          <Text style={styles.topButtonText}>{pinSet ? "PIN ✓" : "PIN"}</Text>
        </Pressable>
        <Pressable style={styles.topButton} onPress={() => void signOut()}>
          <Text style={styles.topButtonText}>Out</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>Conversations</Text>
        <Text style={styles.count}>{rows.length}</Text>
      </View>

      {conversations === undefined ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.accent} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) =>
            row.kind === "group" ? `g:${row.publicId}` : `d:${row.peerPublicId}`
          }
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ConversationRowItem row={item} onOpen={() => openRow(item)} />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No conversations yet. Create a group from the web client, or join an organisation
              with an invite there. This mobile client is the thin read/send surface.
            </Text>
          }
        />
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Live page: last 15 messages. Older history loads on demand. Newest 100 messages per
          conversation are cached on this device for offline reading.
        </Text>
      </View>

      <Modal visible={locked} transparent animationType="fade" onRequestClose={() => {}}>
        <LockOverlay
          biometric={biometric}
          onUnlocked={() => setLocked(false)}
          onSignOut={() => void signOut()}
        />
      </Modal>

      <Modal
        visible={pinModal}
        transparent
        animationType="fade"
        onRequestClose={() => setPinModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Local unlock</Text>
            <Text style={styles.modalHint}>
              This PIN gates the UI on this device only. It is not authentication, is never sent
              to the server, and does not replace the Convex session.
            </Text>
            {pinSet ? (
              <>
                <Pressable
                  style={styles.primary}
                  onPress={() => {
                    setPinModal(false);
                    setLocked(true);
                  }}
                >
                  <Text style={styles.primaryText}>Lock now</Text>
                </Pressable>
                <Pressable
                  style={styles.secondary}
                  onPress={() => {
                    void clearLocalPin().then(() => {
                      setPinSet(false);
                      setPinDraft("");
                      setPinModal(false);
                    });
                  }}
                >
                  <Text style={styles.secondaryText}>Remove PIN</Text>
                </Pressable>
              </>
            ) : (
              <>
                <TextInput
                  style={styles.pinInput}
                  value={pinDraft}
                  onChangeText={setPinDraft}
                  placeholder="Set a PIN (min 4 characters)"
                  placeholderTextColor={COLORS.muted}
                  secureTextEntry
                  editable={!busy}
                />
                <Pressable
                  style={[styles.primary, busy && styles.dim]}
                  onPress={() => void savePin()}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={COLORS.accentInk} size="small" />
                  ) : (
                    <Text style={styles.primaryText}>Set PIN</Text>
                  )}
                </Pressable>
              </>
            )}
            {pinError !== null ? <Text style={styles.error}>{pinError}</Text> : null}
            {biometric ? (
              <Text style={styles.modalHint}>
                This device has enrolled biometrics. Unlock asks the OS for a fingerprint/face
                check as a stub; no credential is tied to your TeamChat account.
              </Text>
            ) : null}
            <Pressable style={styles.secondary} onPress={() => setPinModal(false)}>
              <Text style={styles.secondaryText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function LockOverlay({
  biometric,
  onUnlocked,
  onSignOut,
}: {
  biometric: boolean;
  onUnlocked: () => void;
  onSignOut: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function tryPin() {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (await verifyLocalPin(pin.trim())) {
      onUnlocked();
    } else {
      setError("Wrong PIN");
    }
    setBusy(false);
  }

  async function tryBiometric() {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (await unlockWithBiometrics()) onUnlocked();
    else setError("Biometric check was not completed");
    setBusy(false);
  }

  return (
    <View style={styles.modalBackdrop}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Locked</Text>
        <Text style={styles.modalHint}>
          Local UI gate only — the Convex session is unchanged. Anyone with access to this
          device's keychain can bypass it.
        </Text>
        <TextInput
          style={styles.pinInput}
          value={pin}
          onChangeText={setPin}
          placeholder="PIN"
          placeholderTextColor={COLORS.muted}
          secureTextEntry
          autoFocus
          editable={!busy}
          onSubmitEditing={() => void tryPin()}
        />
        <Pressable
          style={[styles.primary, busy && styles.dim]}
          onPress={() => void tryPin()}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={COLORS.accentInk} size="small" />
          ) : (
            <Text style={styles.primaryText}>Unlock</Text>
          )}
        </Pressable>
        {biometric ? (
          <Pressable style={styles.secondary} onPress={() => void tryBiometric()} disabled={busy}>
            <Text style={styles.secondaryText}>Unlock with biometrics</Text>
          </Pressable>
        ) : null}
        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.secondary} onPress={onSignOut}>
          <Text style={styles.secondaryText}>Sign out instead</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logo: { color: COLORS.text, fontSize: 21, fontWeight: "700", letterSpacing: -0.4 },
  logoBadge: { color: COLORS.muted, fontSize: 12, fontWeight: "600" },
  user: { color: COLORS.muted, fontSize: 11.5, marginTop: 2 },
  topButton: {
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: COLORS.panel,
  },
  topButtonText: { color: COLORS.accent, fontSize: 11, fontWeight: "700" },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 8,
  },
  sectionTitle: {
    color: COLORS.muted,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  count: { color: COLORS.muted, fontSize: 11 },
  list: { paddingHorizontal: 10, paddingBottom: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.panel,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 13,
  },
  rowPressed: { backgroundColor: COLORS.panel2 },
  rowName: { color: COLORS.text, fontSize: 14.5, fontWeight: "600" },
  rowSub: { color: COLORS.muted, fontSize: 11.5, marginTop: 3 },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: COLORS.accent,
  },
  separator: { height: 7 },
  empty: {
    color: COLORS.muted,
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 22,
    paddingTop: 38,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  footer: {
    borderTopColor: COLORS.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  footerText: { color: COLORS.muted, fontSize: 10.5, lineHeight: 15 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 22,
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: COLORS.panel,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
    gap: 8,
  },
  modalTitle: { color: COLORS.text, fontSize: 20, fontWeight: "700" },
  modalHint: { color: COLORS.muted, fontSize: 11.5, lineHeight: 16, marginBottom: 4 },
  pinInput: {
    backgroundColor: COLORS.bg,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  primary: {
    backgroundColor: COLORS.accent,
    borderRadius: radius.sm,
    paddingVertical: 11,
    alignItems: "center",
  },
  primaryText: { color: COLORS.accentInk, fontSize: 13, fontWeight: "700" },
  secondary: {
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryText: { color: COLORS.text, fontSize: 12.5, fontWeight: "600" },
  dim: { opacity: 0.55 },
  error: { color: COLORS.danger, fontSize: 12 },
});
