import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  listConversationCaches,
  type CachedConversation,
  type ClientMessage,
} from "../lib/cache";
import { formatClock, formatDay, formatShort, sameDay } from "../lib/format";
import { COLORS, radius } from "../theme";

/**
 * Offline read: renders only from AsyncStorage — no Convex client, no network, no auth. The
 * newest 100 messages of every conversation this device opened survive an app restart.
 */
export function OfflineScreen({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<CachedConversation[] | null>(null);
  const [selected, setSelected] = useState<CachedConversation | null>(null);

  useEffect(() => {
    void listConversationCaches().then((caches) => {
      setItems(caches);
      setSelected(caches[0] ?? null);
    });
  }, []);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          <Text style={styles.bannerStrong}>Offline cache — read only.</Text> Loaded from this
          device. No network request was made.
        </Text>
      </View>

      <View style={styles.head}>
        <Pressable onPress={selected !== null ? () => setSelected(null) : onClose}>
          <Text style={styles.backText}>{selected !== null ? "‹ Conversations" : "‹ Back"}</Text>
        </Pressable>
        <Text style={styles.headTitle} numberOfLines={1}>
          {selected !== null ? selected.label : "Cached conversations"}
        </Text>
        <View style={styles.headSpacer} />
      </View>

      {items === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.hint}>Reading cache…</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing cached yet</Text>
          <Text style={styles.hint}>
            Open a conversation while online. Each one keeps its newest 100 messages here for
            offline reading.
          </Text>
        </View>
      ) : selected === null ? (
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => setSelected(item)}
            >
              <View style={styles.flex}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.label}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {item.conversation.kind === "group"
                    ? `group ${item.conversation.publicId}`
                    : `DM ${item.conversation.peerPublicId}`}
                </Text>
              </View>
              <View style={styles.rowMeta}>
                <Text style={styles.rowTime}>{formatShort(item.updatedAt)}</Text>
                <Text style={styles.rowCount}>{item.messages.length} msgs</Text>
              </View>
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={selected.messages}
          keyExtractor={(message) => message.publicId}
          contentContainerStyle={styles.messages}
          ListHeaderComponent={
            <Text style={styles.cacheNote}>
              {selected.messages.length} of the newest 100 messages · cached{" "}
              {new Date(selected.updatedAt).toLocaleString()}
            </Text>
          }
          renderItem={({ item, index }) => (
            <CachedMessage
              message={item}
              previous={index > 0 ? selected.messages[index - 1] : null}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function CachedMessage({
  message,
  previous,
}: {
  message: ClientMessage;
  previous: ClientMessage | null;
}) {
  const showDay =
    previous === null || !sameDay(new Date(previous.createdAt), new Date(message.createdAt));

  return (
    <View>
      {showDay ? <Text style={styles.day}>{formatDay(message.createdAt)}</Text> : null}
      <View style={styles.cachedMessage}>
        <View style={styles.metaRow}>
          <Text style={styles.sender}>{message.senderName}</Text>
          <Text style={styles.meta}>{formatClock(message.createdAt)}</Text>
          {message.editedAt !== null ? <Text style={styles.meta}>edited</Text> : null}
        </View>
        {message.deleted ? (
          <Text style={styles.deleted}>Message deleted</Text>
        ) : (
          <>
            {message.text !== "" ? <Text style={styles.messageText}>{message.text}</Text> : null}
            {message.attachments.map((attachment) => (
              <Text key={attachment.attachmentId} style={styles.hint}>
                [attachment] {attachment.name} · {attachment.mime} · {attachment.size} bytes (not
                cached offline)
              </Text>
            ))}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  banner: {
    backgroundColor: "#0f2b22",
    borderBottomColor: "#1f6f56",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  bannerText: { color: "#9ff0d2", fontSize: 12, lineHeight: 17 },
  bannerStrong: { fontWeight: "700" },
  head: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  backText: { color: COLORS.accent, fontSize: 13, fontWeight: "600" },
  headTitle: { flex: 1, color: COLORS.text, fontSize: 15, fontWeight: "700", textAlign: "center" },
  headSpacer: { width: 78 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 10,
  },
  emptyTitle: { color: COLORS.text, fontSize: 17, fontWeight: "700" },
  hint: { color: COLORS.muted, fontSize: 12.5, lineHeight: 18, textAlign: "center" },
  list: { padding: 12, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.panel,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 13,
    gap: 10,
  },
  rowPressed: { backgroundColor: COLORS.panel2 },
  rowName: { color: COLORS.text, fontSize: 14.5, fontWeight: "600" },
  rowSub: { color: COLORS.muted, fontSize: 11.5, marginTop: 3 },
  rowMeta: { alignItems: "flex-end", gap: 3 },
  rowTime: { color: COLORS.muted, fontSize: 11 },
  rowCount: { color: COLORS.muted, fontSize: 10.5 },
  messages: { padding: 14, paddingBottom: 32 },
  cacheNote: { color: COLORS.muted, fontSize: 11.5, marginBottom: 14 },
  day: {
    color: COLORS.muted,
    fontSize: 10.5,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginTop: 14,
    marginBottom: 8,
  },
  cachedMessage: {
    backgroundColor: COLORS.panel,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 11,
    marginBottom: 7,
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  sender: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  meta: { color: COLORS.muted, fontSize: 10.5 },
  deleted: { color: COLORS.muted, fontSize: 13, fontStyle: "italic" },
  messageText: { color: COLORS.text, fontSize: 14, lineHeight: 20 },
});
