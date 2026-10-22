// convex/schema.ts — v1.4
//
// Part 3 of PRD v1.4, transcribed byte-for-byte, with exactly three build additions:
//   1. `users` is ONE merged table: Convex Auth fields (@convex-dev/auth 0.0.96) plus the
//      Part 3 fields and indexes. Decided since Step 0; the alternative (a second auth user
//      table) contradicts Convex Auth's model and was ruled out in the probe report.
//   2. The remaining Convex Auth tables (`authSessions`, `authAccounts`, `authRefreshTokens`,
//      `authVerificationCodes`, `authVerifiers`, `authRateLimits`) are spread in from
//      `authTables`. This is the O5 auth mechanism, not a schema question.
//   3. v0-only plumbing tables: `demoAuthCodes` (CR-16 echo), `attachments` and
//      `storageUsage` (SAL confirm step and per-org byte cap). Part 3 defines no table for
//      pending/confirmed uploads; the SAL contract in the v0 brief requires one.
// No Part 3 table is otherwise added, dropped, renamed, or altered.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// Reused by `webhooks.events` and `webhookDeliveries.event`.
// If the Convex bundler objects to non-default exports from schema.ts,
// move these to convex/validators.ts and import them.
const webhookEventValidator = v.union(
  v.literal("task.claimed"),
  v.literal("task.forwarded"),
  v.literal("task.done"),
  v.literal("task.reopened"),
  v.literal("task.closed"),
  v.literal("message.created"),
);

// Encodes the "no message content in webhooks" guardrail structurally,
// so a future code change cannot violate it by accident.
const webhookPayloadValidator = v.object({
  event:      webhookEventValidator,
  occurredAt: v.string(),
  data: v.object({
    messagePublicId: v.optional(v.string()),
    externalRef:     v.optional(v.string()),
    externalSource:  v.optional(v.string()),
    groupPublicId:   v.optional(v.string()),
    claimedBy:       v.optional(v.object({
                       publicId: v.string(),
                       email:    v.optional(v.string()),
                     })),
  }),
});

// Convex Auth's own tables, minus its `users` (merged below).
const { users: _authUsers, ...authTablesWithoutUsers } = authTables;

export default defineSchema({

  // Convex Auth session/account/verification tables (O5, S3/S4).
  ...authTablesWithoutUsers,

  // ============================== IDENTITY ==============================
  // Merged table (Step 0 decision): Convex Auth fields + Part 3 fields/indexes.
  users: defineTable({
    // --- Convex Auth fields (required by @convex-dev/auth 0.0.96) ---
    name:                  v.optional(v.string()),
    image:                 v.optional(v.string()),
    email:                 v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone:                 v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous:           v.optional(v.boolean()),
    // --- TeamChat fields (Part 3) ---
    publicId:      v.string(),
    // email / phone optional as in Part 3; at least one of email|phone is enforced in the
    // user-creation callback (`convex/auth/callbacks.ts`).
    phoneVerified: v.boolean(),
    accountState:  v.union(
      v.literal("shadow"),      // host-linked; confined to support group; may not claim; no DMs
      v.literal("provisioned"), // created via API; unusable until activated by email OTP
      v.literal("active"),      // email-OTP verified
      v.literal("bot"),         // ERP service user
    ),
    // No orgId: org membership lives in orgMembers.
    // No externalRef here: ERP references are org-relative — see orgMembers.
    // Convex Auth (beta) manages its own session/account tables. See O5 and S4.
  })
  // Index names Convex Auth itself requires (it looks them up by name). Part 3 also asked for
  // `by_email`/`by_phone`; Convex rejects two indexes with identical fields on one table, and the
  // auth library cannot be pointed at different names, so the auth-required names win. Application
  // code uses `email`/`phone` as its lookup indexes — noted in the final report.
  .index("email",        ["email"])
  .index("phone",        ["phone"])
  // Part 3 index:
  .index("by_public_id", ["publicId"]),

  // CR-16 only: the echoed OTP shown under the sign-in box. A demo hint, not authentication.
  // Never written or read when DEMO_OTP_ECHO is off, and the build refuses to run it in
  // production (see `convex/auth/buildFlags.ts`).
  demoAuthCodes: defineTable({
    identifier: v.string(),                    // normalised email
    token:      v.string(),                    // the OTP the email provider would have sent
    createdAt:  v.number(),
    expiresAt:  v.number(),
  })
  .index("by_identifier", ["identifier"]),

  externalIdentities: defineTable({
    hostAppId:      v.id("hostApps"),
    externalUserId: v.string(),
    userId:         v.id("users"),
    createdAt:      v.number(),
  })
  .index("by_host_external", ["hostAppId", "externalUserId"])
  .index("by_user",          ["userId"]),

  connections: defineTable({
    user1:   v.id("users"),
    user2:   v.id("users"),
    pairKey: v.string(),                       // sorted "idA:idB"
    status:  v.union(v.literal("pending"), v.literal("accepted")),
  })
  .index("by_pair",  ["pairKey"])
  .index("by_user1", ["user1"])
  .index("by_user2", ["user2"]),

  // ============================ ORGANISATIONS ===========================
  organizations: defineTable({
    publicId:            v.string(),           // the org segment of every group path
    name:                v.string(),
    rootGroupId:         v.optional(v.id("groups")),
    allowDirectMessages: v.boolean(),
    serviceUserId:       v.optional(v.id("users")),   // ERP bot
    // Additive for Part 5 §2: the per-key request limit is configurable per org above the
    // 500/min floor. Absent means 500. Never below 500 (validated by `apiKeys.setRateLimit`).
    apiRateLimitPerMinute: v.optional(v.number()),
    // Per-org storage cap. Absent falls back to TEAMCHAT_ORG_STORAGE_CAP_BYTES (5 GiB).
    storageCapBytes:     v.optional(v.number()),
  })
  .index("by_public_id", ["publicId"]),

  // Invite links (v0). The raw token exists only in the link; the row stores its hash, matching
  // the apiKeys pattern. Single-use, expiring, revocable. Join attempts are rate-limited (CR-6).
  orgInvites: defineTable({
    orgId:     v.id("organizations"),
    tokenHash: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt:    v.optional(v.number()),
    usedBy:    v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
  })
  .index("by_token_hash", ["tokenHash"])
  .index("by_org",        ["orgId"]),

  // Every user who belongs to an org has a row here, not just its administrators. `owner` and
  // `admin` carry org-administration rights; `member` carries none — the row exists to record org
  // membership and to hold the ERP reference. Ordinary provisioned staff (ACC-EMP-0007) get a
  // `member` row, which is what makes GET /v1/users?externalRef= resolve. Keeping the ref only on
  // owner/admin rows would leave most of the staff directory unlookupable.
  orgMembers: defineTable({
    orgId:          v.id("organizations"),
    userId:         v.id("users"),
    orgRole:        v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    joinedAt:       v.number(),
    externalRef:    v.optional(v.string()),    // ERP-side identifier, e.g. "ACC-EMP-0007"
    externalSource: v.optional(v.string()),    // e.g. "accurate_erp"
    uniqueKey:      v.string(),                // "orgId:userId"
  })
  .index("by_org",          ["orgId"])
  .index("by_user",         ["userId"])
  .index("by_unique",       ["uniqueKey"])
  .index("by_org_external", ["orgId", "externalSource", "externalRef"])
  // Additive: supports lookup when the caller omits externalSource (Part 5 §3b's example does).
  .index("by_org_ref",      ["orgId", "externalRef"]),

  // ============================= WIDGET HOSTS ===========================
  hostApps: defineTable({
    orgId:          v.id("organizations"),
    // Additive: the widget needs a non-internal handle (hard rule: `_id` never crosses to the
    // widget). Everything else is the frozen v1.4 shape plus the O2 opt-in fields below.
    publicId:       v.string(),
    name:           v.string(),
    issuer:         v.string(),                // expected `iss`
    audience:       v.string(),                // expected `aud`
    allowedOrigins: v.array(v.string()),       // iframe origin allowlist
    supportGroupId: v.id("groups"),
    isActive:       v.boolean(),
    // O2 / CR-8. Absent or false means widget uploads are blocked. These are per host app, which
    // is the org's opt-in surface; the org byte cap still applies unchanged.
    allowWidgetUploads:       v.optional(v.boolean()),
    widgetUploadMaxBytes:     v.optional(v.number()),
    widgetUploadMimes:        v.optional(v.array(v.string())),
    widgetUploadRatePerMinute: v.optional(v.number()),
    // Limited white-labelling.
    primaryColor:   v.optional(v.string()),
    logoUrl:        v.optional(v.string()),
  })
  .index("by_org", ["orgId"])
  .index("by_public_id", ["publicId"]),

  hostAppKeys: defineTable({                   // public keys only — no shared secret
    hostAppId: v.id("hostApps"),
    kid:       v.string(),
    alg:       v.union(v.literal("ES256"), v.literal("RS256")),
    publicKey: v.string(),
    notBefore: v.number(),
    notAfter:  v.optional(v.number()),
  })
  .index("by_hostapp_kid", ["hostAppId", "kid"])
  .index("by_hostapp",     ["hostAppId"]),

  usedTokenIds: defineTable({                  // jti replay protection; swept on expiry
    hostAppId: v.id("hostApps"),
    jti:       v.string(),
    usedAt:    v.number(),
    expiresAt: v.number(),
  })
  .index("by_hostapp_jti", ["hostAppId", "jti"])
  .index("by_expires",     ["expiresAt"]),

  // Additive audit for widget-only overrides/refusals that must be observable. Never exposes a
  // token, key or secret: `detail` is a short server-written label.
  widgetAuditLog: defineTable({
    hostAppId: v.id("hostApps"),
    userId:    v.optional(v.id("users")),
    kind:      v.union(
                 v.literal("mode_override"),
                 v.literal("upload_denied"),
                 v.literal("origin_rejected"),
               ),
    detail:    v.string(),
    createdAt: v.number(),
  })
  .index("by_hostapp_created", ["hostAppId", "createdAt"]),

  // ============================ GROUPS & TREE ===========================
  // Discriminated union: a tree group cannot lack orgId or path, and a DM cannot carry them.
  // See S1 — indexing variant-only fields (path, dmKey, orgId, externalRef) is unverified
  // until the schema validates on first deploy.
  groups: defineTable(
    v.union(
      v.object({
        kind:           v.literal("group"),
        publicId:       v.string(),            // path segments built from this, never _id
        name:           v.string(),
        orgId:          v.id("organizations"),
        parentGroupId:  v.optional(v.id("groups")),
        path:           v.string(),            // immutable in Phase 1 (reparenting disabled)
        externalRef:    v.optional(v.string()),
        externalSource: v.optional(v.string()),
      }),
      v.object({
        kind:           v.literal("dm"),       // outside the tree — named exception (CR-2)
        dmKey:          v.string(),            // sorted "userA:userB"
        participantIds: v.array(v.id("users")),
        // no path, orgId, publicId or externalRef.
        // Absent `path` sorts below every real value, so a DM can never match
        // a subtree range query — the exclusion is structural, not a filter.
      }),
    ),
  )
  .index("by_path",         ["path"])
  .index("by_parent",       ["parentGroupId"])
  .index("by_public_id",    ["publicId"])
  .index("by_dm_key",       ["dmKey"])
  .index("by_org",          ["orgId"])
  .index("by_org_external", ["orgId", "externalSource", "externalRef"])
  .index("by_org_ref",      ["orgId", "externalRef"]),

  memberships: defineTable({
    groupId:           v.id("groups"),
    userId:            v.id("users"),
    role:              v.union(v.literal("owner"), v.literal("manager"), v.literal("member")),
    groupPath:         v.optional(v.string()), // absent for DM memberships
    joinedAt:          v.number(),
    lastReadAt:        v.optional(v.number()), // server-derived from a message's _creationTime
    lastReadMessageId: v.optional(v.id("messages")),   // lets the value be re-derived / audited
    uniqueKey:         v.string(),             // "groupId:userId"
  })
  .index("by_group",     ["groupId"])
  .index("by_unique",    ["uniqueKey"])
  .index("by_user_path", ["userId", "groupPath"])   // "is manager at any ancestor of X"
  .index("by_path_role", ["groupPath", "role"]),

  // Chat-list ordering only. Written at a bounded rate, never per message.
  groupActivity: defineTable({
    groupId:       v.id("groups"),
    lastMessageAt: v.number(),
    flushPending:  v.boolean(),                // trailing-flush marker
  })
  .index("by_group", ["groupId"]),

  // ============================== MESSAGES ==============================
  messages: defineTable({
    publicId:  v.string(),
    groupId:   v.id("groups"),
    orgId:     v.optional(v.id("organizations")),   // absent for DM messages
    senderId:  v.id("users"),
    text:      v.string(),
    origin:    v.union(                             // server-set, never client-supplied
                 v.literal("app"), v.literal("widget"), v.literal("api")),
    attachments: v.optional(v.array(v.object({
      attachmentId: v.string(),                    // server-generated at confirm; keys attachmentCopies
      storageRef: v.union(                         // where the ORIGINAL lives; org built in Phase 1
        v.object({
          scope:    v.literal("org"),
          configId: v.id("storageConfigs"),
          fileKey:  v.string(),
        }),
        v.object({
          scope:    v.literal("user"),
          configId: v.id("userStorageConfigs"),
          fileId:   v.string(),                    // Drive file id in the sender's Drive
        }),
      ),
      name:       v.string(),
      mime:       v.string(),
      size:       v.number(),
      sha256:     v.optional(v.string()),
    }))),
    mode:      v.union(v.literal("action"), v.literal("discussion")),
    flags:     v.optional(v.array(v.union(          // labels only; workflow truth = actionInbox
                 v.literal("urgent"), v.literal("vip"), v.literal("spam")))),
    parentId:  v.optional(v.id("messages")),
    externalOccurredAt: v.optional(v.number()),     // display-only; never ordered or authorised by
    editedAt:  v.optional(v.number()),              // blocked once an action is claimed
    deletedAt: v.optional(v.number()),              // soft delete only
    externalRef:    v.optional(v.string()),
    externalSource: v.optional(v.string()),
    // No `createdAt`: ordering uses the system _creationTime, which cannot be backdated.
  })
  .index("by_group",        ["groupId"])            // _creationTime appended automatically
  .index("by_parent",       ["parentId"])           // threading; _creationTime appended
  .index("by_public_id",    ["publicId"])
  .index("by_org_external", ["orgId", "externalSource", "externalRef"])
  .index("by_org_ref",      ["orgId", "externalRef"]),

  // ============================== WORKFLOW ==============================
  actionInbox: defineTable({
    publicId:       v.string(),
    messageId:      v.id("messages"),
    groupId:        v.id("groups"),
    groupPath:      v.optional(v.string()),   // rollup axis; absent on DM tasks
    senderId:       v.id("users"),            // denormalised: "tasks I raised"
    senderMayClose: v.boolean(),              // true only for origin == "app" with an active sender
    flagType:       v.union(v.literal("task"), v.literal("approval"),
                            v.literal("support_ticket"), v.literal("inventory_alert")),
    status:         v.union(v.literal("open"), v.literal("claimed"), v.literal("done"),
                            v.literal("closed"), v.literal("archived")),
    claimedBy:      v.optional(v.id("users")),
    closedBy:       v.optional(v.id("users")),
    forwardedTo:    v.optional(v.id("users")),
    archivedAt:     v.optional(v.number()),   // retention/hide flag — NOT a workflow transition.
                                              // Set when a task is hidden from default views.
                                              // Never changes `status`, so completion counts
                                              // (status == "closed") stay intact.
    // No `openedAt`: _creationTime already carries it.
  })
  .index("by_status_path", ["status", "groupPath"])  // one query per live status
  .index("by_archived",    ["archivedAt"])           // retention sweep
  .index("by_message",     ["messageId"])            // one task per message
  .index("by_claimant",    ["claimedBy", "status"])  // "my tasks" — core screen
  .index("by_sender",      ["senderId", "status"])   // "tasks I raised" + widget ticket lookup
  .index("by_public_id",   ["publicId"]),

  // Append-only audit trail. Typed per action so `forwarded` carries from/to and
  // `closed` carries selfClosed — no untyped catch-all field.
  // `actionInboxId` and `action` exist in every variant, so this index is safe under S1.
  actionEvents: defineTable(
    v.union(
      v.object({
        actionInboxId: v.id("actionInbox"),
        action:        v.literal("claimed"),
        actorId:       v.optional(v.id("users")),
        timestamp:     v.number(),
      }),
      v.object({
        actionInboxId: v.id("actionInbox"),
        action:        v.literal("forwarded"),
        actorId:       v.optional(v.id("users")),
        fromUserId:    v.id("users"),
        toUserId:      v.id("users"),
        timestamp:     v.number(),
      }),
      v.object({
        actionInboxId: v.id("actionInbox"),
        action:        v.literal("done"),
        actorId:       v.optional(v.id("users")),
        timestamp:     v.number(),
      }),
      v.object({
        actionInboxId: v.id("actionInbox"),
        action:        v.literal("reopened"),
        actorId:       v.optional(v.id("users")),
        reason:        v.union(
                         v.literal("sender_review"),   // a closer sent a done task back
                         v.literal("customer_reply"),  // the customer replied on a done ticket
                       ),
        timestamp:     v.number(),
      }),
      v.object({
        actionInboxId: v.id("actionInbox"),
        action:        v.literal("closed"),
        actorId:       v.optional(v.id("users")),
        selfClosed:    v.boolean(),              // closer was the assignee
        timestamp:     v.number(),
      }),
      v.object({
        actionInboxId: v.id("actionInbox"),
        action:        v.literal("archived"),
        actorId:       v.optional(v.id("users")),
        timestamp:     v.number(),
      }),
    ),
  )
  .index("by_inbox_time", ["actionInboxId", "timestamp"]),

  // ============================== STORAGE ===============================
  storageConfigs: defineTable({
    orgId:         v.id("organizations"),
    provider:      v.union(v.literal("s3"), v.literal("gdrive")),   // org scope: s3 only.
                                                                    // Drive is user-scope — see userStorageConfigs
    endpoint:      v.optional(v.string()),
    bucket:        v.optional(v.string()),
    region:        v.optional(v.string()),
    keyPrefix:     v.optional(v.string()),      // least-privilege scope for the bucket policy
    pendingPrefix: v.optional(v.string()),      // unconfirmed uploads expire here
    credentialRef: v.optional(v.id("byosCredentials")),
    status:        v.union(v.literal("active"), v.literal("disabled")),
  })
  .index("by_org", ["orgId"]),

  // Secrets only. Discriminated union so a scope/id mismatch is unrepresentable.
  // See S1 — indexing a variant-only field is unverified until first deploy.
  byosCredentials: defineTable(
    v.union(
      v.object({
        scopeType:  v.literal("org"),
        orgId:      v.id("organizations"),
        ciphertext: v.string(),
        keyVersion: v.number(),
        createdAt:  v.number(),
        rotatedAt:  v.optional(v.number()),
      }),
      v.object({
        scopeType:  v.literal("user"),
        userId:     v.id("users"),
        ciphertext: v.string(),
        keyVersion: v.number(),
        createdAt:  v.number(),
        rotatedAt:  v.optional(v.number()),
      }),
    ),
  )
  .index("by_org",  ["orgId"])
  .index("by_user", ["userId"]),

  // User-scope storage (CR-15). Defined, not built until S7 passes (CR-19).
  // A separate table rather than a union on storageConfigs:
  // an org config has a bucket and a key prefix; a user config has neither.
  userStorageConfigs: defineTable({
    userId:        v.id("users"),
    provider:      v.literal("gdrive"),          // Phase 1: Google Drive only
    googleSub:     v.string(),                   // stable Google account id; email can change
    googleEmail:   v.optional(v.string()),       // display only
    credentialRef: v.optional(v.id("byosCredentials")),   // refresh token; secrets-only table
    status:        v.union(v.literal("active"), v.literal("revoked")),
    connectedAt:   v.number(),
    revokedAt:     v.optional(v.number()),
  })
  .index("by_user",       ["userId"])
  .index("by_google_sub", ["googleSub"]),        // lookup only: indexes are not unique constraints

  // A recipient's own copy of an attachment (CR-15). Defined, not built until S7 passes (CR-19).
  // Never deleted by TeamChat: the copy is the user's property, not the tenant's.
  attachmentCopies: defineTable({
    attachmentId: v.string(),                    // stable id inside messages.attachments[]
    messageId:    v.id("messages"),
    userId:       v.id("users"),
    provider:     v.literal("gdrive"),
    fileId:       v.string(),                    // Drive file id in the user's own Drive
    size:         v.number(),
    createdAt:    v.number(),
  })
  .index("by_attachment_user", ["attachmentId", "userId"])
  .index("by_user",            ["userId"]),

  // v0 SAL plumbing (the build additions noted at the top of this file).
  // One row per upload intent. `pending/` while unconfirmed; the message records the attachment
  // only after confirm. An unconfirmed row is unreachable: no message references it and the read
  // ticket path requires a message.
  attachments: defineTable({
    attachmentId:   v.string(),                  // server-generated; the typed reference on messages
    orgId:          v.id("organizations"),
    groupId:        v.id("groups"),
    uploaderId:     v.id("users"),
    storageConfigId: v.id("storageConfigs"),
    pendingKey:     v.string(),                  // object key under the expiring pending/ prefix
    fileKey:        v.optional(v.string()),      // final key, set at confirm
    name:           v.string(),
    mime:           v.string(),
    size:           v.number(),
    status:         v.union(v.literal("pending"), v.literal("confirmed"), v.literal("expired")),
    messageId:      v.optional(v.id("messages")), // set when recorded on a message; single use
    // Additive: set only for a widget upload. Always org-scoped; a shadow never owns a copy.
    widgetHostAppId: v.optional(v.id("hostApps")),
    createdAt:      v.number(),
    expiresAt:      v.number(),                  // pending sweep
    confirmedAt:    v.optional(v.number()),
  })
  .index("by_attachment_id", ["attachmentId"])
  .index("by_uploader",      ["uploaderId"])
  .index("by_group",         ["groupId"])
  .index("by_status_expires", ["status", "expiresAt"]),

  // Per-org confirmed bytes, for the dev-bucket cap. Written per confirmed upload (bounded rate),
  // never per message.
  storageUsage: defineTable({
    orgId:          v.id("organizations"),
    confirmedBytes: v.number(),
    updatedAt:      v.number(),
  })
  .index("by_org", ["orgId"]),

  // ============================= INTEGRATION ============================
  apiKeys: defineTable({
    // Additive: client-facing key handle. `_id` must never cross the API or the admin surface.
    publicId:   v.string(),
    orgId:      v.id("organizations"),
    keyHash:    v.string(),
    label:      v.string(),
    scopes:     v.array(v.union(
                  v.literal("messages:write"),  v.literal("messages:read"),
                  v.literal("users:provision"), v.literal("groups:manage"),
                  v.literal("tasks:read"))),
    createdAt:  v.number(),
    lastUsedAt: v.optional(v.number()),
    expiresAt:  v.number(),                    // enforces the 90-day rotation rule
    rotatedAt:  v.optional(v.number()),
    revokedAt:  v.optional(v.number()),
  })
  .index("by_org",      ["orgId"])
  .index("by_public_id", ["publicId"])
  .index("by_key_hash", ["keyHash"]),          // every API request authenticates by hash

  webhooks: defineTable({
    // Additive: client-facing webhook handle. `_id` must never cross the admin surface.
    publicId:  v.string(),
    orgId:     v.id("organizations"),
    url:       v.string(),                     // https only; private/link-local ranges rejected
    events:    v.array(webhookEventValidator),
    isActive:  v.boolean(),
    createdAt: v.number(),
    // no `secret` — see webhookSecrets
  })
  .index("by_org", ["orgId"])
  .index("by_public_id", ["publicId"]),

  webhookSecrets: defineTable({                // never returned by a client-readable query
    webhookId:  v.id("webhooks"),
    ciphertext: v.string(),
    keyVersion: v.number(),
    createdAt:  v.number(),
  })
  .index("by_webhook", ["webhookId"]),

  webhookDeliveries: defineTable({
    webhookId:     v.id("webhooks"),
    event:         webhookEventValidator,
    payload:       webhookPayloadValidator,    // snapshot: a retry sends the original, not current state
    status:        v.union(v.literal("pending"), v.literal("delivered"),
                           v.literal("failed"), v.literal("dead")),
    attempts:      v.number(),
    nextAttemptAt: v.optional(v.number()),     // 10s / 60s / 300s
    lastError:     v.optional(v.string()),
    createdAt:     v.number(),
  })
  .index("by_status_next",    ["status", "nextAttemptAt"])
  .index("by_webhook",        ["webhookId"])
  .index("by_status_created", ["status", "createdAt"]),   // retention sweep

  idempotencyKeys: defineTable({
    orgId:          v.id("organizations"),
    scope:          v.string(),                // e.g. "POST /v1/messages"
    key:            v.string(),
    requestHash:    v.string(),                // same key + different body ⇒ 409
    responseStatus: v.number(),                // the original response, stored verbatim
    responseBody:   v.string(),                // serialised JSON — replay must be byte-identical
    createdAt:      v.number(),
    expiresAt:      v.number(),                // cron sweep
  })
  .index("by_org_scope_key", ["orgId", "scope", "key"])
  .index("by_expires",       ["expiresAt"]),

  // ================================ COST (O7) ============================
  // One row per org per UTC day, written by the daily scheduled aggregation. NEVER written per
  // message and never a hot per-group document (Appendix A "What to build", item 1).
  //
  // `peakConcurrentViewers` is intentionally absent: the deployment exposes no per-org presence
  // signal, and adding one would create exactly the extra subscription load the brief forbids.
  // `peakViewerMethod` records that fact rather than inventing a number.
  usageRollups: defineTable({
    orgId:                  v.id("organizations"),
    orgPublicId:            v.string(),         // client-facing, so no admin query needs an _id
    day:                    v.string(),         // "YYYY-MM-DD" UTC
    messagesSent:           v.number(),
    activeSenders:          v.number(),
    groupCount:             v.number(),
    groupSizeBuckets:       v.object({
                              le10:    v.number(),
                              le50:    v.number(),
                              le200:   v.number(),
                              le1000:  v.number(),
                              gt1000:  v.number(),
                            }),
    messagesPerUserPerDay:  v.number(),         // measured: messagesSent / activeSenders
    averageGroupSize:       v.number(),
    projectedMonthlyCostUsd: v.number(),        // estimate, not a bill
    peakViewerMethod:       v.string(),         // "not_measured_no_presence_signal"
    createdAt:              v.number(),
  })
  .index("by_org_day", ["orgId", "day"])
  .index("by_day",     ["day"]),

  // Single-row alert state. Only the scheduled aggregation writes it; the admin query reads it.
  costAlertState: defineTable({
    key:                 v.string(),            // "platform"
    day:                 v.string(),
    projectedTotalUsd:   v.number(),
    percentOfCeiling:    v.number(),
    level:               v.union(v.literal("ok"), v.literal("warning"), v.literal("over")),
    activeOrgCount:      v.number(),
    lastLoggedAt:        v.number(),
  })
  .index("by_key", ["key"]),
});
