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

/** Rendered workflow state for one Action message. Viewer flags are hints, never enforcement. */
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
export const LAST_CONVERSATION_KEY = "teamchat.lastConversation.v1";
const MAX_CACHED_MESSAGES = 100;

export function conversationKey(conversation: Conversation): string {
  return conversation.kind === "group"
    ? `group:${conversation.publicId}`
    : `dm:${conversation.peerPublicId}`;
}

type CacheMap = Record<string, CachedConversation>;

function readMap(): CacheMap {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "{}") as CacheMap;
  } catch {
    return {};
  }
}

function writeMap(map: CacheMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    // storage full / disabled — the cache is a convenience, not a source of truth
  }
}

/** Merge and keep the newest 100 messages (offline read requirement). */
export function writeConversationCache(
  conversation: Conversation,
  label: string,
  messages: ClientMessage[],
): void {
  const map = readMap();
  const key = conversationKey(conversation);
  const byId = new Map<string, ClientMessage>();
  for (const message of messages) byId.set(message.publicId, message);
  const merged = [...byId.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_CACHED_MESSAGES);
  map[key] = { key, label, conversation, messages: merged, updatedAt: Date.now() };
  writeMap(map);
}

export function readConversationCache(conversation: Conversation): CachedConversation | null {
  return readMap()[conversationKey(conversation)] ?? null;
}

export function listConversationCaches(): CachedConversation[] {
  return Object.values(readMap()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveLastConversation(conversation: Conversation, label: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CONVERSATION_KEY, JSON.stringify({ conversation, label }));
  } catch {
    // ignore
  }
}

export function readLastConversation(): { conversation: Conversation; label: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_CONVERSATION_KEY);
    return raw === null ? null : (JSON.parse(raw) as { conversation: Conversation; label: string });
  } catch {
    return null;
  }
}
