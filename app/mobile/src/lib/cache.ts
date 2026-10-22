import AsyncStorage from "@react-native-async-storage/async-storage";

export type Conversation =
  | { kind: "group"; publicId: string }
  | { kind: "dm"; peerPublicId: string };

export type TaskStatus = "open" | "claimed" | "done" | "closed" | "archived";
export type TaskFlagType = "task" | "approval" | "support_ticket" | "inventory_alert";

export type TaskViewerFlags = {
  canClaim: boolean;
  canMarkDone: boolean;
  canForward: boolean;
  canReassign: boolean;
  canClose: boolean;
  canReopen: boolean;
  canArchive: boolean;
  canHide: boolean;
};

export type TaskCard = {
  publicId: string;
  status: TaskStatus;
  flagType: TaskFlagType;
  claimedByPublicId: string | null;
  claimedByName: string | null;
  closedByPublicId: string | null;
  closedByName: string | null;
  forwardedToPublicId: string | null;
  forwardedToName: string | null;
  senderMayClose: boolean;
  archivedAt: number | null;
  hidden: boolean;
  viewer: TaskViewerFlags;
};

export type ClientMessage = {
  publicId: string;
  text: string;
  deleted: boolean;
  editedAt: number | null;
  createdAt: number;
  senderPublicId: string;
  senderName: string;
  attachments: Array<{ attachmentId: string; name: string; mime: string; size: number }>;
  isReply: boolean;
  mode: "action" | "discussion";
  origin: "app" | "widget" | "api";
  task: TaskCard | null;
};

export type CachedConversation = {
  key: string;
  label: string;
  conversation: Conversation;
  messages: ClientMessage[];
  updatedAt: number;
};

const CACHE_KEY = "teamchat.cache.v1";
const MAX_CACHED_MESSAGES = 100;

export function conversationKey(conversation: Conversation): string {
  return conversation.kind === "group"
    ? `group:${conversation.publicId}`
    : `dm:${conversation.peerPublicId}`;
}

type CacheMap = Record<string, CachedConversation>;

async function readMap(): Promise<CacheMap> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw === null ? {} : (JSON.parse(raw) as CacheMap);
  } catch {
    return {};
  }
}

async function writeMap(map: CacheMap): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    // Cache is a convenience, not a source of truth (storage may be full or wiped).
  }
}

/** Merge and keep the newest 100 messages (offline read requirement). */
export async function writeConversationCache(
  conversation: Conversation,
  label: string,
  messages: ClientMessage[],
): Promise<void> {
  const map = await readMap();
  const key = conversationKey(conversation);
  const byId = new Map<string, ClientMessage>();
  for (const message of messages) byId.set(message.publicId, message);
  const merged = [...byId.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_CACHED_MESSAGES);
  map[key] = { key, label, conversation, messages: merged, updatedAt: Date.now() };
  await writeMap(map);
}

export async function readConversationCache(
  conversation: Conversation,
): Promise<CachedConversation | null> {
  const map = await readMap();
  return map[conversationKey(conversation)] ?? null;
}

export async function listConversationCaches(): Promise<CachedConversation[]> {
  const map = await readMap();
  return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function hasAnyCache(): Promise<boolean> {
  return Object.keys(await readMap()).length > 0;
}
