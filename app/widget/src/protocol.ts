// Versioned postMessage protocol between the host page and the TeamChat iframe.
// Nothing in either direction is trusted until the sender origin and source have been checked.

export const WIDGET_PROTOCOL_VERSION = 1;

export type HostToWidget =
  | { type: "teamchat:token"; token: string; hostAppPublicId: string }
  | { type: "teamchat:visibility"; visible: boolean }
  | { type: "teamchat:close" }
  | { type: "teamchat:open" };

export type WidgetToHost =
  | { type: "teamchat:ready"; version: number }
  | { type: "teamchat:token-request" }
  | { type: "teamchat:state"; open: boolean; ticketStatus: string | null }
  | { type: "teamchat:error"; code: string; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseHostMessage(value: unknown): HostToWidget | null {
  if (!isObject(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "teamchat:token":
      if (typeof value.token !== "string" || value.token === "") return null;
      if (typeof value.hostAppPublicId !== "string" || value.hostAppPublicId === "") return null;
      return {
        type: "teamchat:token",
        token: value.token,
        hostAppPublicId: value.hostAppPublicId,
      };
    case "teamchat:visibility":
      if (typeof value.visible !== "boolean") return null;
      return { type: "teamchat:visibility", visible: value.visible };
    case "teamchat:close":
      return { type: "teamchat:close" };
    case "teamchat:open":
      return { type: "teamchat:open" };
    default:
      return null;
  }
}

export function parseWidgetMessage(value: unknown): WidgetToHost | null {
  if (!isObject(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "teamchat:ready":
      return {
        type: "teamchat:ready",
        version: typeof value.version === "number" ? value.version : 0,
      };
    case "teamchat:token-request":
      return { type: "teamchat:token-request" };
    case "teamchat:state":
      if (typeof value.open !== "boolean") return null;
      return {
        type: "teamchat:state",
        open: value.open,
        ticketStatus: typeof value.ticketStatus === "string" ? value.ticketStatus : null,
      };
    case "teamchat:error":
      return {
        type: "teamchat:error",
        code: typeof value.code === "string" ? value.code : "unknown",
        message: typeof value.message === "string" ? value.message : "Widget error",
      };
    default:
      return null;
  }
}

/** Exact-origin allowlist check after URL normalisation. Duplicated from the server helper on purpose. */
export function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  let normalised: string;
  try {
    normalised = new URL(origin).origin;
  } catch {
    return false;
  }
  for (const allowed of allowedOrigins) {
    try {
      if (new URL(allowed).origin === normalised) return true;
    } catch {
      if (allowed === origin) return true;
    }
  }
  return false;
}
