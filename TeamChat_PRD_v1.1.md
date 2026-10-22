# TeamChat: Master Product & Technical Specification

**Version:** 1.1 (Phase 1 MVP + Integration Layer)
**Date:** June 27, 2026

> **Product Vision:** WhatsApp is messaging for casual chat. TeamChat is messaging for work — structured, accountable, workflow-driven communication for organisations, franchises, and embedded business applications.

---

## Table of Contents

1. [Part 1: Product Requirements Document](#part-1-product-requirements-document)
2. [Part 2: Tech Stack](#part-2-tech-stack)
3. [Part 3: Database Design](#part-3-database-design)
4. [Part 4: Architecture Flow](#part-4-architecture-flow)
5. [Part 5: Open Integration Layer](#part-5-open-integration-layer)

---

## Part 1: Product Requirements Document

### 1. Core Architecture Principles

**Pub/Sub (Topic-Based / Hashtag) Messaging**
Groups are not physical folders copying messages to individual inboxes. Groups act as "Topics". Messages are published once to the topic, and subscribers (members) filter and view them. Ensures infinite scalability.

**Storage Abstraction Layer (SAL) / BYOS**
Bring Your Own Storage model. Metadata (text, flags, routing) lives on TeamChat servers. Heavy media (images, videos, docs) are routed via SAL directly to the user's chosen cloud storage (Google Drive, AWS S3, etc.).

**Tree Hierarchy Only**
Strict top-down parent-child relationships. Parent groups can see/interact with child groups. Child groups cannot see parent groups. Sibling groups are isolated.

**Open Integration by Design** *(Locked Principle)*
TeamChat exposes a documented REST/Webhook API for bidirectional integration with external ERP and business systems. Identity provisioning, group management, and message triggers must be automatable via API. No closed-system architectural decisions shall block this capability.

---

### 2. Message Modes — The Core Differentiator

Every message sent in a group is categorised into one of two modes:

#### Mode A: Action / Task (Single-Claim)

**Use Case:** Customer support tickets, direct assignments, urgent alerts.

- **Telephone Extension Rule:** When an Action message is sent, all members see it. The first member to click `[ ⚡ Claim Task ]` locks it to themselves — like the first person to pick up a ringing office extension. All others' claim buttons deactivate instantly.
- **Single Claim:** Once claimed, the task is locked. No one else can claim it unless it is formally Forwarded.
- **Confirmation UX:** Claiming requires a one-tap "Are you sure?" confirmation to prevent misclicks, without breaking the audit trail.
- **Customer Support Rule:** Any message originating from the Embedded Widget (Host App) is automatically and strictly locked into Action Mode to prevent multi-agent collisions.

#### Mode B: Open Discussion / Broadcast (Watercooler)

**Use Case:** Brainstorming, asking for opinions, general announcements.

- No claiming mechanism. Message stays in normal chat stream.
- Encourages Threading (slide-out panel) to keep the main chat clean.
- Everyone can participate. No ownership assigned.

---

### 3. Key Features

| Feature | Description |
|---|---|
| **Action Inbox** | Dedicated task board. Tracks the ball: Sender → Claimed By → Forwarded To. |
| **Embeddable Chat SDK** | Shadow account identity mapping via host app email. Zero friction. Limited white-labelling (colours/logo). |
| **Connections** | Find via Phone/Email, Invite Links, QR Code. Acoustic handshake deferred to Phase 3. |
| **Authentication** | Passwordless Email OTP (3-min expiry). 30-day inactivity session timeout. Local PIN/Biometric to open app. |
| **General Chat** | Multi-device sync, offline read (last 100 cached messages), edit/delete, threaded replies, rich attachments. |
| **Open API Layer** | REST + Webhook endpoints for ERP/business system integration. See Part 5. |

---

### 4. Edge Case Handling

- **Un-claiming:** A user cannot simply un-claim a task. They must use Forward to pass the ball to another user, maintaining an audit trail.
- **Closing Flags:** The original sender/manager closes the flag to confirm completion. The assignee clicks "Mark as Done" to notify the sender to review and officially close.
- **Host App Guest Friction:** Embedded widget users can chat immediately via shadow accounts. File uploads are restricted until they download the main app and link their BYOS storage.
- **BYOS = `none` state:** Users with no cloud storage configured operate in text-only mode. BYOS setup is an upgrade path, not a hard requirement for basic usage.

---

## Part 2: Tech Stack

### Frontend (Client Side)

- **Mobile App (iOS/Android):** React Native — shares business logic with Web.
- **Web / PWA:** Next.js (React).
- **Embeddable Chat SDK:** Vanilla TypeScript + Convex Client. Lightweight, dependency-free JS snippet for host apps, rendered in secure iframe/Shadow DOM.

### Backend & Database

- **Backend-as-a-Service:** Convex — handles Database, Real-time WebSocket Sync, Server Functions, Cron Jobs, Auth, and HTTP Actions for the Open API layer.
- **Language:** TypeScript — end-to-end type safety from DB to Client.

### External Integrations

- **Email Provider:** SendGrid or AWS SES (OTP delivery).
- **BYOS Cloud Providers:** Google Drive, AWS S3 (Phase 1 MVP). Dropbox, Azure (Phase 2).
- **ERP / Business Systems:** Via Open API Layer — Accurate Accounting, SellMore POS, SAP, and any REST-capable system (Phase 2+).

### Infrastructure

- **Hosting:** Convex Cloud (Managed) for Phase 1. Self-hosted option for Enterprise Phase 2.
- **Frontend Hosting:** Vercel (Next.js).

---

## Part 3: Database Design

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({

  // 1. USERS & CONNECTIONS
  users: defineTable({
    email:            v.string(),
    name:             v.string(),
    orgId:            v.id("organizations"),
    byosProvider:     v.union(v.literal("gdrive"), v.literal("s3"), v.literal("none")),
    byosRefreshToken: v.optional(v.string()),  // Encrypted OAuth token
    isShadowAccount:  v.boolean(),             // True if created via Embedded Widget
  }).index("by_email", ["email"]),

  connections: defineTable({
    user1:  v.id("users"),
    user2:  v.id("users"),
    status: v.union(v.literal("pending"), v.literal("accepted")),
  }),

  // 2. HIERARCHICAL GROUPS (Tree Structure)
  organizations: defineTable({
    name:        v.string(),
    rootGroupId: v.id("groups"),
  }),

  groups: defineTable({
    name:                v.string(),
    orgId:               v.id("organizations"),
    parentGroupId:       v.union(v.id("groups"), v.null()),
    path:                v.string(),  // e.g. "/org_123/sales/team_a"
    memberIds:           v.array(v.id("users")),
    allowDirectMessages: v.boolean(),
  })
  .index("by_path",   ["path"])
  .index("by_parent", ["parentGroupId"]),

  // 3. MESSAGES (Pub/Sub Hashtag Approach)
  messages: defineTable({
    groupId:        v.id("groups"),          // The "Hashtag" / Topic
    senderId:       v.id("users"),
    text:           v.string(),
    mediaUrls:      v.optional(v.array(v.string())),  // Links to BYOS cloud
    mode:           v.union(v.literal("action"), v.literal("discussion")),
    flags:          v.optional(v.array(v.string())),  // e.g. ["urgent"]
    parentId:       v.union(v.id("messages"), v.null()),  // For threading
    createdAt:      v.number(),
    // ERP integration fields
    externalRef:    v.optional(v.string()),  // e.g. ERP order/ticket ID
    externalSource: v.optional(v.string()),  // e.g. "accurate", "sellmore", "sap"
  })
  .index("by_group",        ["groupId", "createdAt"])
  .index("by_external_ref", ["externalRef"]),

  // 4. ACTION INBOX (Workflow Flags)
  actionInbox: defineTable({
    messageId:   v.id("messages"),
    groupId:     v.id("groups"),
    flagType:    v.string(),
    status:      v.union(v.literal("open"), v.literal("claimed"), v.literal("closed")),
    claimedBy:   v.union(v.id("users"), v.null()),
    closedBy:    v.union(v.id("users"), v.null()),
    forwardedTo: v.optional(v.id("users")),  // Tracking the "ball"
  })
  .index("by_status", ["status", "groupId"]),

  // 5. API KEYS (Open Integration Layer)
  apiKeys: defineTable({
    orgId:       v.id("organizations"),
    keyHash:     v.string(),              // SHA-256 hash — never store plaintext
    label:       v.string(),              // e.g. "SellMore POS Integration"
    scopes:      v.array(v.string()),     // ["messages:write", "users:read", ...]
    createdAt:   v.number(),
    lastUsedAt:  v.optional(v.number()),
    revokedAt:   v.optional(v.number()),
  })
  .index("by_org", ["orgId"]),

  // 6. WEBHOOK SUBSCRIPTIONS
  webhooks: defineTable({
    orgId:     v.id("organizations"),
    url:       v.string(),
    events:    v.array(v.string()),  // ["task.claimed", "task.closed", ...]
    secret:    v.string(),           // HMAC signing secret
    isActive:  v.boolean(),
    createdAt: v.number(),
  })
  .index("by_org", ["orgId"]),

});
```

---

## Part 4: Architecture Flow

### 1. High-Level System Topology

```
[ CLIENT LAYER ]
  ├── 📱 Mobile App (React Native)
  ├── 💻 Web / PWA (Next.js)
  └── 🔌 Embedded Widget (Vanilla TS inside Host App iframe)
         │
         │ (Persistent WebSocket / HTTP)
         ▼
[ CONVEX REACTIVE ENGINE ] (The Core)
  ├── 🧠 Reactive Database (ACID Transactions, Auto-Caching)
  ├── ⚡ Real-Time Sync (Automatic WebSocket subscriptions)
  ├── 🛠️  Server Functions (Mutations, Queries, Actions)
  ├── 🔐 Auth & Session Manager (Email OTP, JWT validation)
  └── 🌐 HTTP Actions (Open API / Webhook Layer)
         │
         │ (OAuth2 / REST / HMAC Webhooks)
         ▼
[ EXTERNAL SERVICES LAYER ]
  ├── 📧 Email Provider (SendGrid / AWS SES)
  ├── ☁️ BYOS Storage (Google Drive, AWS S3)
  └── 🏢 ERP / Business Systems (Accurate, SellMore, SAP, custom)
```

---

### 2. Core Data Flows

#### Flow A: Real-Time Pub/Sub Messaging

1. **Client:** User A sends a message to a 1,000-person group.
2. **Convex:** Mutation inserts **ONE** message into the `messages` table, tagged with `groupId`.
3. **Convex (Magic):** Clients subscribed to that `groupId` instantly receive the message via internal WebSocket router.
4. **Result:** 1 Database Write. No Redis Pub/Sub needed. Scales infinitely.

#### Flow B: Telephone Extension (Claiming a Task)

1. **Client:** User B clicks `[ ⚡ Claim Task ]` on an Action Mode message.
2. **UX:** A confirmation prompt appears — "Claim this task?" — preventing misclicks.
3. **Convex:** Calls a `mutation` wrapped in an **ACID Transaction**.
4. **Transaction Logic:** Checks `claimedBy` is `null`. If yes → updates to User B. If no → throws error (someone else was 1ms faster).
5. **Real-Time Update:** All group members' screens instantly update to show "Claimed by User B".

#### Flow C: Tree Hierarchy Visibility (Materialised Path)

1. **Client:** Director requests messages from their org.
2. **Convex Query:** Uses Materialised Path index — `WHERE group_path LIKE '/org_123/sales/%'`
3. **Result:** B-Tree index fetches all nested child messages in milliseconds. No recursive SQL joins.

#### Flow D: BYOS Media Upload

1. **Client:** User selects a 50MB video.
2. **Convex Action:** Uses stored OAuth2 Refresh Token to call Google Drive API.
3. **Google Drive:** Generates a Pre-Signed Upload URL.
4. **Client:** App uploads video directly to Google Drive. TeamChat servers never touch the file bytes.
5. **Convex:** Saves the Google Drive File ID into the `messages` table.
6. **Viewing:** Convex generates a temporary Read URL from GDrive for direct streaming.

---

## Part 5: Open Integration Layer

> TeamChat is designed as an open platform. Any ERP, POS, CRM, or custom business system can trigger messages, provision users, and receive status callbacks via this API layer — without embedding the full SDK.

### 1. Architecture Principle

**Locked principle:** No architectural decision shall create a closed system. Identity provisioning, group management, and message triggers must always be automatable via API. This enables franchise head offices, ERP vendors, and enterprise IT teams to integrate TeamChat without manual onboarding steps.

---

### 2. Authentication — API Keys

External systems authenticate using organisation-scoped API keys, not user sessions.

| Property | Detail |
|---|---|
| **Format** | `tc_live_xxxxxxxxxxxxxxxx` (prefixed, 32-char random) |
| **Storage** | SHA-256 hash only. Plaintext never stored. |
| **Scopes** | `messages:write`, `messages:read`, `users:provision`, `groups:manage`, `tasks:read` |
| **Management** | Created/revoked via Admin Dashboard. One key per integration recommended. |
| **Rate Limit** | 500 requests/minute per key (Phase 2 default, configurable per org). |

---

### 3. REST API Endpoints

**Base URL:** `https://api.teamchat.app/v1/`

#### 3a. Message Triggers (ERP → TeamChat)

Allows external systems to push Action or Discussion messages into any group.

```http
POST /v1/messages
Authorization: Bearer tc_live_xxxxx
Content-Type: application/json

{
  "groupId":        "grp_abc123",
  "text":           "New purchase order #PO-8821 requires approval.",
  "mode":           "action",
  "externalRef":    "PO-8821",
  "externalSource": "accurate_erp"
}

// Response 201 Created
{
  "messageId": "msg_xyz789",
  "status":    "open"
}
```

#### 3b. Task Status Query (ERP ← TeamChat)

```http
GET /v1/tasks?externalRef=PO-8821
Authorization: Bearer tc_live_xxxxx

// Response 200 OK
{
  "messageId":   "msg_xyz789",
  "status":      "claimed",
  "claimedBy":   { "userId": "usr_111", "name": "Budi Santoso" },
  "claimedAt":   "2026-06-27T09:14:22Z",
  "forwardedTo": null
}
```

#### 3c. User Provisioning (Batch)

Allows ERP/POS systems to auto-create TeamChat accounts for their users — eliminating manual onboarding for large organisations.

```http
POST /v1/users/provision
Authorization: Bearer tc_live_xxxxx

{
  "users": [
    { "email": "budi@franchise-outlet-7.com", "name": "Budi Santoso", "groupIds": ["grp_outlet7"] },
    { "email": "sari@franchise-outlet-7.com", "name": "Sari Dewi",    "groupIds": ["grp_outlet7"] }
  ]
}

// Creates shadow accounts; users receive OTP invite to activate.
```

#### 3d. Group / Tree Provisioning

Allows franchise head offices or enterprise IT to replicate their org chart into TeamChat programmatically.

```http
POST /v1/groups
Authorization: Bearer tc_live_xxxxx

{
  "name":          "Outlet Jakarta Selatan 07",
  "parentGroupId": "grp_jakarta_region",
  "memberEmails":  ["budi@franchise-outlet-7.com"]
}
```

---

### 4. Outbound Webhooks (TeamChat → ERP)

TeamChat pushes real-time status events back to external systems via HMAC-signed POST requests. This closes the loop: ERP triggers a task → agent claims it → ERP is notified automatically.

| Event | Triggered When |
|---|---|
| `task.claimed` | A member claims an Action message |
| `task.forwarded` | A task is forwarded to another user |
| `task.closed` | Sender or manager officially closes the task |
| `task.done` | Assignee clicks Mark as Done (pending sender review) |
| `message.created` | Any new message posted (opt-in, high volume) |

#### Webhook Payload Example

```http
POST https://your-erp.com/teamchat-webhook
X-TeamChat-Signature: sha256=abc123...
Content-Type: application/json

{
  "event":      "task.claimed",
  "occurredAt": "2026-06-27T09:14:22Z",
  "data": {
    "messageId":   "msg_xyz789",
    "externalRef": "PO-8821",
    "claimedBy":   { "userId": "usr_111", "email": "budi@outlet7.com" },
    "groupId":     "grp_outlet7"
  }
}
```

> **Note:** Webhook payloads carry metadata and `externalRef` only — no message content. ERP must call `GET /v1/messages/{id}` to fetch content if needed. This minimises data exposure.

---

### 5. Flow E: ERP-Triggered Action Message (Complete Loop)

1. **ERP System:** New event fires (e.g. new support ticket, new PO, stock alert).
2. **ERP calls** `POST /v1/messages` with `externalRef` and `mode: action`.
3. **Convex HTTP Action:** Validates API key scope, writes message to the group.
4. **Real-Time:** All group members see the Action message with `[ ⚡ Claim Task ]` button.
5. **Agent Claims:** First agent claims the task (Telephone Extension logic applies).
6. **Webhook fires:** TeamChat POSTs `task.claimed` event to ERP's registered webhook URL.
7. **ERP Updates:** ERP marks the record as in-progress, stamped with the agent's identity.
8. **Closure:** Agent marks Done → manager closes → `task.closed` webhook fires → ERP record closed.

---

### 6. Target Integration Use Cases (Phase 2+)

| System / Market | Integration Use Case |
|---|---|
| **Accurate Accounting** | New AP invoice → Action message to finance group for approval |
| **SellMore POS** | Customer complaint from POS → Action message to support group |
| **Franchise / Chain Store** | Head office provisions entire outlet tree + staff via API. Daily ops alerts flow to regional managers. |
| **SAP / Oracle ERP** | Purchase order approval workflow routed through TeamChat Action Inbox |
| **Custom App Developers** | Any REST-capable app can send alerts and receive status updates |

---

### 7. Design Constraints & Guardrails

- **Webhook retry policy:** 3 retries with exponential backoff (10s, 60s, 300s). Dead-letter queue for failed deliveries.
- **API key rotation:** Keys should be rotated every 90 days. Dashboard shows last-used timestamp to identify stale keys.
- **Scope enforcement:** Every API call is validated against key scopes. Writing messages with a read-only key returns `403`.
- **No message content in webhook:** Webhook payloads carry metadata and `externalRef` only. ERP must call `GET /v1/messages/{id}` to fetch content if needed. Reduces data exposure.
- **BYOS not required for API messages:** Text-only Action messages triggered via API do not require BYOS. Media attachments via API are a Phase 3 consideration.

---

*— End of Document —*

*TeamChat Confidential | Version 1.1 | June 27, 2026*
