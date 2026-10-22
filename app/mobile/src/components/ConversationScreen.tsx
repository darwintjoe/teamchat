import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import * as ImagePicker from "expo-image-picker";
import { api } from "../lib/convex";
import {
  conversationKey,
  readConversationCache,
  writeConversationCache,
  type ClientMessage,
  type Conversation,
  type TaskStatus,
} from "../lib/cache";
import { errorMessage } from "../lib/errors";
import { formatClock, formatDay, sameDay } from "../lib/format";
import { COLORS, radius } from "../theme";
import { DemoBanner } from "./DemoBanner";

type Attachment = ClientMessage["attachments"][number];
type ComposeMode = "discussion" | "action";
type FlagType = "task" | "approval" | "support_ticket" | "inventory_alert";

const FLAG_TYPES: Array<{ value: FlagType; label: string }> = [
  { value: "task", label: "Task" },
  { value: "approval", label: "Approval" },
  { value: "support_ticket", label: "Support" },
  { value: "inventory_alert", label: "Inventory" },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  claimed: "Claimed",
  done: "Done · review",
  closed: "Closed",
  archived: "Archived",
};

type Props = {
  conversation: Conversation;
  label: string;
  groupPath: string | null;
  orgPublicId: string | null;
  myPublicId: string;
  onBack: () => void;
};

function mergeMessages(older: ClientMessage[], live: ClientMessage[]): ClientMessage[] {
  const byId = new Map<string, ClientMessage>();
  for (const message of [...older, ...live]) byId.set(message.publicId, message);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function messageSignature(messages: ClientMessage[]): string {
  return messages
    .map(
      (m) =>
        `${m.publicId}:${m.createdAt}:${m.editedAt ?? 0}:${m.deleted ? 1 : 0}:${m.text.length}:${
          m.task?.status ?? ""
        }:${m.task?.claimedByPublicId ?? ""}:${m.task?.archivedAt ?? 0}`,
    )
    .join("|");
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const requestRead = useAction(api.storage.attachments.requestRead);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isImage = attachment.mime.startsWith("image/");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void requestRead({ attachmentId: attachment.attachmentId })
      .then((ticket) => {
        if (!cancelled) setUrl(ticket.url);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.attachmentId, requestRead]);

  if (isImage && url !== null) {
    return (
      <Pressable onPress={() => void Linking.openURL(url)}>
        <Image source={{ uri: url }} style={styles.image} resizeMode="cover" />
      </Pressable>
    );
  }

  return (
    <View style={styles.attachRow}>
      {loading ? (
        <ActivityIndicator color={COLORS.accent} size="small" />
      ) : (
        <Pressable
          style={styles.attachButton}
          onPress={() => {
            if (url !== null) void Linking.openURL(url);
          }}
          disabled={url === null}
        >
          <Text style={styles.attachText} numberOfLines={1}>
            {isImage ? "Image" : "File"} · {attachment.name}
          </Text>
        </Pressable>
      )}
      {error !== null ? <Text style={styles.attachError}>{error}</Text> : null}
    </View>
  );
}

function TaskRow({
  task,
  busy,
  error,
  onClaim,
  onDone,
}: {
  task: NonNullable<ClientMessage["task"]>;
  busy: boolean;
  error: string | null;
  onClaim: () => void;
  onDone: () => void;
}) {
  return (
    <View style={styles.taskCard}>
      <View style={styles.taskHead}>
        <Text style={styles.taskStatus}>{STATUS_LABEL[task.status]}</Text>
        <Text style={styles.taskMeta}>{task.flagType.replaceAll("_", " ")}</Text>
        {task.hidden ? <Text style={styles.taskMeta}>hidden</Text> : null}
      </View>
      {task.claimedByName !== null ? (
        <Text style={styles.taskMeta}>Claimed by {task.claimedByName}</Text>
      ) : null}
      {task.forwardedToName !== null ? (
        <Text style={styles.taskMeta}>Forwarded to {task.forwardedToName}</Text>
      ) : null}
      {task.closedByName !== null ? (
        <Text style={styles.taskMeta}>Closed by {task.closedByName}</Text>
      ) : null}
      {task.viewer.canClaim || task.viewer.canMarkDone ? (
        <View style={styles.taskActions}>
          {task.viewer.canClaim ? (
            <Pressable
              style={({ pressed }) => [styles.taskButton, pressed && styles.dim]}
              onPress={onClaim}
              disabled={busy}
            >
              <Text style={styles.taskButtonText}>⚡ Claim task</Text>
            </Pressable>
          ) : null}
          {task.viewer.canMarkDone ? (
            <Pressable
              style={({ pressed }) => [styles.taskButton, pressed && styles.dim]}
              onPress={onDone}
              disabled={busy}
            >
              <Text style={styles.taskButtonText}>Mark done</Text>
            </Pressable>
          ) : null}
          {busy ? <ActivityIndicator color={COLORS.accent} size="small" /> : null}
        </View>
      ) : null}
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function ConversationScreen(props: Props) {
  const { conversation, label, groupPath, myPublicId } = props;
  const convex = useConvex();
  const live = useQuery(api.messages.listLive, { conversation });
  const unread = useQuery(api.unread.unreadCount, { conversation });
  const storage = useQuery(api.storage.config.conversationStorageState, { conversation });
  const markRead = useMutation(api.unread.markRead);
  const send = useMutation(api.messages.send);
  const claimTask = useMutation(api.actionInbox.claim);
  const markTaskDone = useMutation(api.actionInbox.markDone);
  const requestUpload = useAction(api.storage.attachments.requestUpload);
  const confirmUpload = useAction(api.storage.attachments.confirmUpload);

  const listRef = useRef<FlatList<ClientMessage> | null>(null);
  const markedRef = useRef<string | null>(null);

  const [cached, setCached] = useState<ClientMessage[]>([]);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [older, setOlder] = useState<ClientMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyDone, setHistoryDone] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposeMode>("discussion");
  const [flagType, setFlagType] = useState<FlagType>("task");
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<{ taskPublicId: string; message: string } | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readConversationCache(conversation).then((row) => {
      if (cancelled) return;
      setCached(row?.messages ?? []);
      setCacheLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [conversation]);

  // If the live subscription is unavailable (cold start with no network), fall back to the
  // newest 100 cached messages rather than an empty screen.
  const source = live ?? cached;
  const merged = useMemo(() => mergeMessages(older, source), [older, source]);
  const signature = messageSignature(merged);
  const last = merged.length > 0 ? merged[merged.length - 1] : null;
  const lastPublicId = last?.publicId ?? null;
  const offline = live === undefined && cacheLoaded;

  useEffect(() => {
    if (merged.length === 0) return;
    void writeConversationCache(conversation, label, merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, conversationKey(conversation), label]);

  // Flow A3: send the last message id actually seen, never a timestamp.
  useEffect(() => {
    if (lastPublicId === null || live === undefined) return;
    if (markedRef.current === lastPublicId) return;
    markedRef.current = lastPublicId;
    void markRead({ conversation, lastMessagePublicId: lastPublicId }).catch(() => {
      markedRef.current = null;
    });
  }, [lastPublicId, conversation, markRead, live]);

  async function loadOlder() {
    if (convex === null || loadingHistory) return;
    setLoadingHistory(true);
    setError(null);
    try {
      const page = await convex.query(api.messages.listHistory, {
        conversation,
        cursor: cursor ?? undefined,
        limit: 25,
      });
      setOlder((previous) => mergeMessages(page.messages, previous));
      setCursor(page.nextCursor);
      setHistoryDone(page.isDone);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingHistory(false);
    }
  }

  async function sendText() {
    const value = text.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await send({
        conversation,
        text: value,
        mode,
        ...(mode === "action" ? { flagType } : {}),
      });
      setText("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function runTask(taskPublicId: string, label: string, fn: () => Promise<unknown>) {
    setTaskBusy(taskPublicId);
    setTaskError(null);
    try {
      await fn();
    } catch (caught) {
      setTaskError({ taskPublicId, message: `${label}: ${errorMessage(caught)}` });
    } finally {
      setTaskBusy(null);
    }
  }

  function confirmClaim(taskPublicId: string) {
    const claim = () => {
      void runTask(taskPublicId, "Claim failed", () =>
        claimTask({ taskPublicId }),
      );
    };
    if (Platform.OS === "web") {
      // React Native Web's Alert.alert is a no-op; keep the confirmation available in the
      // Expo-web smoke target as well as on native.
      if (window.confirm("Claim this task? The first claimant locks it to themselves.")) {
        claim();
      }
      return;
    }
    Alert.alert("Claim this task?", "The first claimant locks it to themselves.", [
      { text: "Cancel", style: "cancel" },
      { text: "Claim", onPress: claim },
    ]);
  }

  async function sendPhoto() {
    if (busy) return;
    setError(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo access is required to send an image.");
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0];

    setBusy(true);
    try {
      let blob: Blob | null = null;
      let size = asset.fileSize ?? 0;
      if (size <= 0) {
        const response = await fetch(asset.uri);
        blob = await response.blob();
        size = blob.size;
      }
      if (size <= 0) throw new Error("Could not read the selected image.");

      const name = asset.fileName ?? `photo-${Date.now()}.jpg`;
      const mime = asset.mimeType ?? "image/jpeg";

      setUploadStatus("Requesting upload ticket…");
      const ticket = await requestUpload({
        ...(conversation.kind === "group"
          ? { groupPublicId: conversation.publicId }
          : { peerPublicId: conversation.peerPublicId }),
        name,
        mime,
        size,
      });

      if (blob === null) {
        const response = await fetch(asset.uri);
        blob = await response.blob();
      }

      setUploadStatus("Uploading directly to storage…");
      const form = new FormData();
      for (const [field, value] of Object.entries(ticket.fields)) form.append(field, value);
      form.append("file", blob, name);
      const upload = await fetch(ticket.uploadUrl, {
        method: ticket.method,
        body: form,
      });
      if (!upload.ok) {
        throw new Error(`Storage upload failed with HTTP ${upload.status}`);
      }

      setUploadStatus("Confirming upload…");
      const confirmed = await confirmUpload({ attachmentId: ticket.attachmentId });

      setUploadStatus("Sending message…");
      await send({
        conversation,
        text: text.trim(),
        attachmentIds: [confirmed.attachmentId],
        mode,
        ...(mode === "action" ? { flagType } : {}),
      });
      setText("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setUploadStatus(null);
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <DemoBanner />
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={props.onBack} hitSlop={8}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerMain}>
          <Text style={styles.title} numberOfLines={1}>
            {conversation.kind === "dm" ? "DM · " : ""}
            {label}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {groupPath ?? "Direct message"}
          </Text>
        </View>
        {unread !== undefined && unread.count > 0 ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{unread.display}</Text>
          </View>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={merged}
          keyExtractor={(message) => message.publicId}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListHeaderComponent={
            <>
              {offline ? (
                <View style={styles.offlineNote}>
                  <Text style={styles.offlineText}>
                    Offline — showing {cached.length} cached messages. Sending is unavailable.
                  </Text>
                </View>
              ) : null}
              {!historyDone && (older.length > 0 || (live?.length ?? 0) >= 15) ? (
                <Pressable
                  style={styles.historyButton}
                  onPress={() => void loadOlder()}
                  disabled={loadingHistory}
                >
                  <Text style={styles.historyText}>
                    {loadingHistory ? "Loading…" : "Load older messages"}
                  </Text>
                </Pressable>
              ) : null}
            </>
          }
          ListEmptyComponent={
            cacheLoaded || live !== undefined ? (
              <Text style={styles.empty}>
                No messages yet. Say hello or send a photo.
              </Text>
            ) : undefined
          }
          renderItem={({ item, index }) => {
            const previous = index > 0 ? merged[index - 1] : null;
            const showDay =
              previous === null || !sameDay(new Date(previous.createdAt), new Date(item.createdAt));
            const own = item.senderPublicId === myPublicId;
            const task = item.task ?? null;
            return (
              <View>
                {showDay ? <Text style={styles.day}>{formatDay(item.createdAt)}</Text> : null}
                <View style={[styles.message, own ? styles.messageOwn : null]}>
                  <View style={styles.metaRow}>
                    <Text style={styles.sender}>{own ? "You" : item.senderName}</Text>
                    <Text style={styles.meta}>{formatClock(item.createdAt)}</Text>
                    {item.editedAt !== null ? <Text style={styles.meta}>edited</Text> : null}
                    {item.isReply ? <Text style={styles.meta}>reply</Text> : null}
                  </View>
                  {item.deleted ? (
                    <Text style={styles.deleted}>Message deleted</Text>
                  ) : (
                    <>
                      {item.text !== "" ? <Text style={styles.messageText}>{item.text}</Text> : null}
                      {item.attachments.map((attachment) => (
                        <AttachmentView key={attachment.attachmentId} attachment={attachment} />
                      ))}
                    </>
                  )}
                </View>
                {task !== null ? (
                  <TaskRow
                    task={task}
                    busy={taskBusy === task.publicId}
                    error={taskError?.taskPublicId === task.publicId ? taskError.message : null}
                    onClaim={() => confirmClaim(task.publicId)}
                    onDone={() =>
                      void runTask(task.publicId, "Mark done failed", () =>
                        markTaskDone({ taskPublicId: task.publicId }),
                      )
                    }
                  />
                ) : null}
              </View>
            );
          }}
        />

        <View style={styles.composer}>
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modePill, mode === "discussion" && styles.modePillActive]}
              onPress={() => setMode("discussion")}
            >
              <Text style={[styles.modeText, mode === "discussion" && styles.modeTextActive]}>
                💬 Discussion
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modePill, mode === "action" && styles.modePillActive]}
              onPress={() => setMode("action")}
            >
              <Text style={[styles.modeText, mode === "action" && styles.modeTextActive]}>
                ⚡ Action
              </Text>
            </Pressable>
            {mode === "action" ? (
              <Pressable
                style={styles.modePill}
                onPress={() => {
                  const index = FLAG_TYPES.findIndex((row) => row.value === flagType);
                  setFlagType(FLAG_TYPES[(index + 1) % FLAG_TYPES.length].value);
                }}
              >
                <Text style={styles.modeText}>
                  {FLAG_TYPES.find((row) => row.value === flagType)?.label ?? "Task"}
                </Text>
              </Pressable>
            ) : null}
            <Text style={styles.modeHint}>
              {mode === "action" ? "One task · first claim locks" : "No claiming"}
            </Text>
          </View>
          <View style={styles.composerRow}>
            <Pressable
              style={({ pressed }) => [
                styles.attach,
                (pressed || busy || storage === undefined || storage.provider === "none") && styles.dim,
              ]}
              onPress={() => void sendPhoto()}
              disabled={busy || storage === undefined || storage.provider === "none"}
              accessibilityLabel="Send a photo"
            >
              <Text style={styles.attachIcon}>＋</Text>
            </Pressable>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={COLORS.muted}
              multiline
              maxLength={4000}
            />
            <Pressable
              style={({ pressed }) => [
                styles.send,
                (pressed || busy || text.trim() === "") && styles.dim,
              ]}
              onPress={() => void sendText()}
              disabled={busy || text.trim() === ""}
            >
              {busy ? (
                <ActivityIndicator color={COLORS.accentInk} size="small" />
              ) : (
                <Text style={styles.sendText}>Send</Text>
              )}
            </Pressable>
          </View>
          {uploadStatus !== null ? <Text style={styles.status}>{uploadStatus}</Text> : null}
          {storage?.provider === "none" ? (
            <Text style={styles.status}>
              Text-only: no shared storage is connected
              {conversation.kind === "group" ? " (an org admin can add S3)" : ""}.
            </Text>
          ) : null}
          {error !== null ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.panel,
    gap: 10,
  },
  back: { width: 24, alignItems: "center" },
  backText: { color: COLORS.accent, fontSize: 30, lineHeight: 32, marginTop: -3 },
  headerMain: { flex: 1 },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  subtitle: { color: COLORS.muted, fontSize: 11.5, marginTop: 2 },
  chip: {
    backgroundColor: COLORS.accent,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  chipText: { color: COLORS.accentInk, fontSize: 11, fontWeight: "700" },
  messages: { paddingHorizontal: 12, paddingVertical: 10, paddingBottom: 20 },
  offlineNote: {
    backgroundColor: "#0f2b22",
    borderColor: "#1f6f56",
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 9,
    marginBottom: 10,
  },
  offlineText: { color: "#9ff0d2", fontSize: 11.5, lineHeight: 16 },
  historyButton: {
    alignSelf: "center",
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
    marginBottom: 12,
  },
  historyText: { color: COLORS.accent, fontSize: 12, fontWeight: "600" },
  empty: { color: COLORS.muted, fontSize: 13, textAlign: "center", marginTop: 34 },
  day: {
    color: COLORS.muted,
    fontSize: 10.5,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    textAlign: "center",
    marginTop: 14,
    marginBottom: 8,
  },
  message: {
    backgroundColor: COLORS.bubble,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 10,
    marginBottom: 6,
    maxWidth: "92%",
  },
  messageOwn: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.bubbleOwn,
    borderColor: "#24527f",
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 3 },
  sender: { color: COLORS.text, fontSize: 11.5, fontWeight: "700" },
  meta: { color: COLORS.muted, fontSize: 10 },
  messageText: { color: COLORS.text, fontSize: 14, lineHeight: 20 },
  deleted: { color: COLORS.muted, fontSize: 13, fontStyle: "italic" },
  image: {
    width: 220,
    height: 165,
    borderRadius: radius.sm,
    marginTop: 6,
    backgroundColor: COLORS.panel2,
  },
  attachRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  attachButton: {
    backgroundColor: COLORS.panel2,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
    maxWidth: 220,
  },
  attachText: { color: COLORS.accent, fontSize: 12, fontWeight: "600" },
  attachError: { color: COLORS.danger, fontSize: 11, flexShrink: 1 },
  composer: {
    borderTopColor: COLORS.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.panel,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 5,
  },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 7 },
  attach: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    borderColor: COLORS.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.bg,
  },
  attachIcon: { color: COLORS.accent, fontSize: 22, lineHeight: 24, marginTop: -2 },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    backgroundColor: COLORS.bg,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: COLORS.text,
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 14,
  },
  send: {
    backgroundColor: COLORS.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: COLORS.accentInk, fontSize: 13, fontWeight: "700" },
  dim: { opacity: 0.5 },
  status: { color: COLORS.muted, fontSize: 11, lineHeight: 15 },
  error: { color: COLORS.danger, fontSize: 11.5, lineHeight: 16 },
  modeRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  modePill: {
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: COLORS.bg,
  },
  modePillActive: {
    borderColor: COLORS.accent,
    backgroundColor: "rgba(79, 156, 249, 0.16)",
  },
  modeText: { color: COLORS.muted, fontSize: 11.5, fontWeight: "600" },
  modeTextActive: { color: COLORS.text },
  modeHint: { color: COLORS.muted, fontSize: 10.5, marginLeft: 2 },
  taskCard: {
    marginTop: 5,
    marginLeft: 8,
    marginRight: 8,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderLeftColor: COLORS.accent,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    backgroundColor: COLORS.panel2,
    padding: 8,
    gap: 3,
  },
  taskHead: { flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" },
  taskStatus: { color: COLORS.accent, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  taskMeta: { color: COLORS.muted, fontSize: 10.5 },
  taskActions: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4, flexWrap: "wrap" },
  taskButton: {
    backgroundColor: COLORS.panel,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  taskButtonText: { color: COLORS.accent, fontSize: 11.5, fontWeight: "700" },
});
