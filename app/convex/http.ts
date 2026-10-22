// Public HTTP surface (Part 5).
//
//  * `/v1/*` is the org-scoped REST API. Every request authenticates by API-key hash, then by
//    scope, then by rate limit. Writes require `Idempotency-Key`; the request-body hash is stored
//    with the verbatim response so a replay is byte-identical and a changed body is a 409.
//  * `/widget/shell` is the hardened iframe entry point. It resolves the host app before serving
//    HTML and enforces the allowlist with `Content-Security-Policy: frame-ancestors`, never with
//    `X-Frame-Options` (which cannot express a per-tenant list).
//
// No `_id` and no internal error detail crosses this boundary. Every error is
// `{ "error": { "code": "...", "message": "..." } }`.

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { dynamicRateLimiter, rateLimiter } from "./lib/rateLimiter";
import { sha256Hex } from "./lib/crypto";

const MINUTE_MS = 60_000;

type JsonBody = Record<string, unknown>;

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function fail(error: ApiError): Response {
  return json(error.status, { error: { code: error.code, message: error.message } });
}

function internalFailure(): Response {
  return json(500, {
    error: { code: "internal_error", message: "The request could not be completed" },
  });
}

/** Strip Convex's wrapper and any stack, then map only messages this codebase throws. */
function fromThrown(error: unknown): ApiError {
  const raw = error instanceof Error ? error.message : "";
  const message = raw
    .replace(/^Uncaught Error:\s*/i, "")
    .split("\n")[0]
    .replace(/\s+at\s+.*$/, "")
    .trim();

  if (/not found/i.test(message)) return new ApiError(404, "not_found", message);
  if (/already exists|collides with/i.test(message)) return new ApiError(409, "conflict", message);
  if (/nested groups are not permitted/i.test(message)) {
    return new ApiError(400, "nested_group_not_supported", message);
  }
  if (
    /required|needs|cannot|must|limited|at most|at least|not permitted|not a member|not active|no root|supplied together|not valid|not available|only .* can/i.test(
      message,
    )
  ) {
    return new ApiError(400, "invalid_request", message);
  }
  return new ApiError(500, "internal_error", "The request could not be completed");
}

function requiredString(body: JsonBody, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_request", `"${field}" is required`);
  }
  return value;
}

function optionalString(body: JsonBody, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_request", `"${field}" must be a string`);
  }
  return value;
}

function optionalStringArray(body: JsonBody, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(400, "invalid_request", `"${field}" must be an array of strings`);
  }
  return value as string[];
}

async function readJson(request: Request): Promise<{ raw: string; body: JsonBody }> {
  const raw = await request.text();
  if (raw.length === 0) throw new ApiError(400, "invalid_request", "A JSON body is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_request", "The request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_request", "The request body must be a JSON object");
  }
  return { raw, body: parsed as JsonBody };
}

type Auth = {
  keyPublicId: string;
  orgId: any;
  orgPublicId: string;
  scopes: string[];
  rateLimitPerMinute: number;
};

async function authenticate(
  ctx: any,
  request: Request,
  requiredScope: string,
): Promise<Auth> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match === null || match[1].trim() === "") {
    throw new ApiError(401, "unauthorized", "A Bearer API key is required");
  }
  const result = await ctx.runMutation(internal.apiKeys.authenticate, {
    token: match[1].trim(),
    requiredScope,
  });
  if (!result.ok) {
    throw new ApiError(result.status, result.code, result.message);
  }
  return result as Auth;
}

async function perKeyLimit(ctx: any, auth: Auth): Promise<void> {
  const result = await dynamicRateLimiter.limit(ctx, "apiKeyRequests", {
    key: auth.keyPublicId,
    config: {
      kind: "fixed window",
      rate: Math.max(500, auth.rateLimitPerMinute),
      period: MINUTE_MS,
    },
  });
  if (!result.ok) {
    throw new ApiError(429, "rate_limited", "API rate limit exceeded for this key");
  }
}

async function perGroupSendLimit(ctx: any, groupPublicId: string): Promise<void> {
  const result = await rateLimiter.limit(ctx, "apiGroupSends", { key: groupPublicId });
  if (!result.ok) {
    throw new ApiError(429, "group_rate_limited", "Per-group send limit exceeded");
  }
}

function idempotencyKey(request: Request): string {
  const key = (request.headers.get("Idempotency-Key") ?? "").trim();
  if (key === "") {
    throw new ApiError(400, "idempotency_key_required", "Idempotency-Key is required on writes");
  }
  if (key.length > 200) {
    throw new ApiError(400, "invalid_request", "Idempotency-Key is too long");
  }
  return key;
}

function outcomeResponse(outcome: { kind: string; status?: number; body?: string }): Response {
  if (outcome.kind === "conflict") {
    return fail(
      new ApiError(
        409,
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request body",
      ),
    );
  }
  return json(outcome.status ?? 200, outcome.body ?? "{}");
}

function guard(handler: (ctx: any, request: Request) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    try {
      return await handler(ctx, request);
    } catch (error) {
      if (error instanceof ApiError) return fail(error);
      const mapped = fromThrown(error);
      return mapped.status >= 500 ? internalFailure() : fail(mapped);
    }
  });
}

const http = httpRouter();
auth.addHttpRoutes(http);

// ---------------------------------------------------------------------------------------------
// POST /v1/messages
// ---------------------------------------------------------------------------------------------

http.route({
  path: "/v1/messages",
  method: "POST",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "messages:write");
    const key = idempotencyKey(request);
    const { raw, body } = await readJson(request);
    const groupPublicId = requiredString(body, "groupPublicId");
    const text = requiredString(body, "text");
    const mode = optionalString(body, "mode") ?? "discussion";
    if (mode !== "action" && mode !== "discussion") {
      throw new ApiError(400, "invalid_request", '"mode" must be "action" or "discussion"');
    }
    const externalRef = optionalString(body, "externalRef");
    const externalSource = optionalString(body, "externalSource");
    if ((externalRef === undefined) !== (externalSource === undefined)) {
      throw new ApiError(
        400,
        "invalid_request",
        "externalRef and externalSource must be supplied together",
      );
    }

    // The group must belong to the calling key's org before it can consume that org's budget.
    const group = await ctx.runQuery(internal.apiEndpoints.groupOrg, { groupPublicId });
    if (group === null || group.orgId !== authn.orgId) {
      throw new ApiError(404, "group_not_found", "Group not found");
    }

    // Group cap first: a runaway integration is attributed to the group it is flooding, not
    // masked by the larger per-key budget.
    await perGroupSendLimit(ctx, group.groupPublicId);
    await perKeyLimit(ctx, authn);

    const requestHash = await sha256Hex(raw);
    const outcome = await ctx.runMutation(internal.apiEndpoints.createMessage, {
      orgId: authn.orgId,
      idempotencyKey: key,
      requestHash,
      groupPublicId,
      text,
      mode,
      externalRef,
      externalSource,
    });
    return outcomeResponse(outcome);
  }),
});

// ---------------------------------------------------------------------------------------------
// POST /v1/users/provision
// ---------------------------------------------------------------------------------------------

http.route({
  path: "/v1/users/provision",
  method: "POST",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "users:provision");
    const key = idempotencyKey(request);
    const { raw, body } = await readJson(request);
    const users = body.users;
    if (!Array.isArray(users) || users.length === 0) {
      throw new ApiError(400, "invalid_request", '"users" must be a non-empty array');
    }
    const externalSource = optionalString(body, "externalSource");
    await perKeyLimit(ctx, authn);
    const requestHash = await sha256Hex(raw);
    const outcome = await ctx.runMutation(internal.apiEndpoints.provisionUsers, {
      orgId: authn.orgId,
      idempotencyKey: key,
      requestHash,
      externalSource,
      users: users as any,
    });
    return outcomeResponse(outcome);
  }),
});

// ---------------------------------------------------------------------------------------------
// POST /v1/groups
// ---------------------------------------------------------------------------------------------

http.route({
  path: "/v1/groups",
  method: "POST",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "groups:manage");
    const key = idempotencyKey(request);
    const { raw, body } = await readJson(request);
    const name = requiredString(body, "name");
    const parentPublicId = optionalString(body, "parentPublicId");
    const memberEmails = optionalStringArray(body, "memberEmails");
    const externalRef = optionalString(body, "externalRef");
    const externalSource = optionalString(body, "externalSource");
    if ((externalRef === undefined) !== (externalSource === undefined)) {
      throw new ApiError(
        400,
        "invalid_request",
        "externalRef and externalSource must be supplied together",
      );
    }
    await perKeyLimit(ctx, authn);
    const requestHash = await sha256Hex(raw);
    const outcome = await ctx.runMutation(internal.apiEndpoints.createGroup, {
      orgId: authn.orgId,
      idempotencyKey: key,
      requestHash,
      name,
      parentPublicId,
      memberEmails,
      externalRef,
      externalSource,
    });
    return outcomeResponse(outcome);
  }),
});

// ---------------------------------------------------------------------------------------------
// GET /v1/tasks
// ---------------------------------------------------------------------------------------------

http.route({
  path: "/v1/tasks",
  method: "GET",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "tasks:read");
    await perKeyLimit(ctx, authn);
    const url = new URL(request.url);
    const externalRef = (url.searchParams.get("externalRef") ?? "").trim();
    if (externalRef === "") {
      throw new ApiError(400, "invalid_request", '"externalRef" is required');
    }
    const externalSource = url.searchParams.get("externalSource") ?? undefined;
    const task = await ctx.runQuery(internal.apiEndpoints.lookupTask, {
      orgId: authn.orgId,
      externalRef,
      externalSource: externalSource === "" ? undefined : externalSource,
    });
    if (task === null) throw new ApiError(404, "task_not_found", "Task not found");
    return json(200, {
      messagePublicId: task.messagePublicId,
      status: task.status,
      claimedBy: task.claimedBy,
      claimedAt: task.claimedAt,
      forwardedTo: task.forwardedTo,
    });
  }),
});

// ---------------------------------------------------------------------------------------------
// GET /v1/messages/{publicId}
// ---------------------------------------------------------------------------------------------

http.route({
  pathPrefix: "/v1/messages/",
  method: "GET",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "messages:read");
    await perKeyLimit(ctx, authn);
    const url = new URL(request.url);
    const publicId = decodeURIComponent(url.pathname.slice("/v1/messages/".length));
    if (publicId === "" || publicId.includes("/")) {
      throw new ApiError(404, "message_not_found", "Message not found");
    }
    const message = await ctx.runQuery(internal.apiEndpoints.getMessage, {
      orgId: authn.orgId,
      messagePublicId: publicId,
    });
    if (message === null) throw new ApiError(404, "message_not_found", "Message not found");
    return json(200, message);
  }),
});

// ---------------------------------------------------------------------------------------------
// GET /v1/groups?externalRef=
// ---------------------------------------------------------------------------------------------

http.route({
  path: "/v1/groups",
  method: "GET",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "groups:manage");
    await perKeyLimit(ctx, authn);
    const url = new URL(request.url);
    const externalRef = (url.searchParams.get("externalRef") ?? "").trim();
    if (externalRef === "") {
      throw new ApiError(400, "invalid_request", '"externalRef" is required');
    }
    const externalSource = url.searchParams.get("externalSource") ?? undefined;
    const group = await ctx.runQuery(internal.apiEndpoints.lookupGroup, {
      orgId: authn.orgId,
      externalRef,
      externalSource: externalSource === "" ? undefined : externalSource,
    });
    if (group === null) throw new ApiError(404, "group_not_found", "Group not found");
    return json(200, group);
  }),
});

// ---------------------------------------------------------------------------------------------
// GET /v1/users?externalRef=
// ---------------------------------------------------------------------------------------------

http.route({
  path: "/v1/users",
  method: "GET",
  handler: guard(async (ctx, request) => {
    const authn = await authenticate(ctx, request, "users:provision");
    await perKeyLimit(ctx, authn);
    const url = new URL(request.url);
    const externalRef = (url.searchParams.get("externalRef") ?? "").trim();
    if (externalRef === "") {
      throw new ApiError(400, "invalid_request", '"externalRef" is required');
    }
    const externalSource = url.searchParams.get("externalSource") ?? undefined;
    const user = await ctx.runQuery(internal.apiEndpoints.lookupUser, {
      orgId: authn.orgId,
      externalRef,
      externalSource: externalSource === "" ? undefined : externalSource,
    });
    if (user === null) throw new ApiError(404, "user_not_found", "User not found");
    return json(200, user);
  }),
});

// ---------------------------------------------------------------------------------------------
// GET /widget/shell
// ---------------------------------------------------------------------------------------------

const WIDGET_SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TeamChat support</title>
    <link rel="stylesheet" href="./widget.css" />
  </head>
  <body>
    <div id="widget-root"></div>
    <script src="./widget.js"></script>
  </body>
</html>`;

http.route({
  path: "/widget/shell",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const host = (url.searchParams.get("host") ?? "").trim();
    const config =
      host === ""
        ? null
        : await ctx.runQuery(internal.hostApps.shellConfig, { hostAppPublicId: host });

    // Unknown, missing and inactive are one response: no existence probe, no allowlist leak.
    if (config === null) {
      return json(404, {
        error: { code: "host_not_found", message: "Widget host not found" },
      });
    }

    return new Response(WIDGET_SHELL_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // Enforcement. `origin` supplied to the token exchange is advisory metadata only.
        "Content-Security-Policy": `frame-ancestors ${config.allowedOrigins.join(" ")}`,
        // Deliberately no X-Frame-Options: it cannot express a per-tenant allowlist.
      },
    });
  }),
});

export default http;
