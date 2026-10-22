# TeamChat MVP v0: Brief for the Code Agent

Owner: Darwin Tjoe · Base: PRD v1.4 · 19 October 2026

**Scope:** this brief is the **v0** increment. `TeamChat_PRD_v1.4.md` governs; where they differ, v1.4 wins. v0 is chat-only by design — Action mode and the widget are the next increment.

## Goal

A plain WhatsApp-style chat app, built to find out whether people use the chat itself. The Action/task workflow is **not** part of v0.

## In scope

- **One-to-one chat.** DMs follow CR-2: outside the tree, no path, no orgId. In the MVP they are between members of the same org and honor the org's `allowDirectMessages` policy.
- **Group chat inside an org.** The org root group plus flat groups as its direct children, one level, no nesting. Any member can post. There is no group-to-group communication.
- **Messages:** text, photo, video, audio file and any file attachment, plus threaded replies.
- **Orgs:** anyone creates an org and becomes its owner. Others join by invite link. This needs one new additive table, `orgInvites` (unguessable token, orgId, createdBy, expiresAt).
- **Sign-in:** the user types an email and the OTP is shown on screen under the OTP box. No email provider. Keep it behind the swappable auth wrapper (O5), behind an environment flag that **refuses to start in production**. Rate limiting stays on (CR-6).
- **Storage:** the Storage Abstraction Layer (SAL) with an S3-compatible dev adapter (see below).

## Out of scope

Voice notes and calls. Action mode, `actionInbox` and `actionEvents` (next increment). The embedded widget and shadow accounts (next increment). The REST API and webhooks. Hierarchy beyond one level. Cost-model levers. Global phone lookup. Google Drive as production storage.

## Locked rules: do not drift

- One message is one database write. No document scoped to a group is written on every message.
- TeamChat never proxies media bytes. Clients upload directly with a pre-signed PUT.
- The server generates the `fileKey` under an org/group prefix. Unconfirmed uploads live under an expiring `pending/` prefix. An attachment is recorded on the message only after the confirm step.
- Reads are authorized server-side against group access, then a short-lived signed GET is issued.
- Each attachment carries its own typed `storageRef`.
- No secret on any client-readable document. Order by `_creationTime`. External IDs are `publicId` only.

## SAL contract

Every storage adapter implements the same three operations, so no app code depends on one provider. This replaces v1.1's wording about the user's chosen cloud storage.

1. **Upload ticket:** the server returns a signed upload for one server-generated `fileKey`, with size and type limits. S3: a pre-signed PUT. Drive: an upload session address.
2. **Confirm:** the client confirms, the server promotes the object out of `pending/`, and only then is the attachment recorded on the message.
3. **Read ticket:** after checking the reader's group access, the server returns a short-lived way to read the file. S3: a signed GET. Drive: decided by S7.

Each adapter declares which operations it supports. The S3-compatible dev adapter supports all three. The Drive adapter supports upload and confirm, and its read side waits for S7: if recipients can copy into their own Drive, the read ticket becomes a copy instruction that runs on the recipient's phone. No adapter may relay file bytes through TeamChat servers.

## Build notes

- Keep `mode` on messages with `discussion` as the default. Do not create the Action tables yet, so adding Action mode later is an addition and not a migration.
- The dev bucket is paid by TeamChat, with a per-org key prefix, size and type limits, and a storage cap. It is demo-only. In the MVP, attachments are **not** in each user's own Drive.
- Parents see children in the locked tree, so an org owner can drill into any group. This is expected.
- No real email verification means no real people's data in this build.

## S7: Google Drive spike (run in parallel, time-boxed)

**Question:** can a recipient's phone fetch a file from the sender's Drive and save it into the recipient's own Drive, using only the non-sensitive `drive.file` scope, with no bytes going through TeamChat servers? Whether `drive.file` allows this has **not** been verified.

1. Create a Google Cloud OAuth client in testing mode with the `drive.file` scope only.
2. Use two test Google accounts, A and B. Link each through OAuth and store the refresh token encrypted in a secrets-only table.
3. A uploads a small and a large file to A's Drive. The message carries only the file ID.
4. Test three routes for B: (a) A shares the file to B's Google account and B's app tries to read and copy it; (b) B opens it through the Google Picker; (c) a link-sharing read.
5. Record for each route: pass or fail, consent screens needed, any quota or permission errors, and whether a copy lands in B's Drive.

**Pass:** B ends with an own copy, no TeamChat byte relay, and at most one extra consent step. **Fail:** keep S3-compatible storage and report to Darwin. The options then are a TeamChat-hosted storage tier or Drive with limits in Phase 2 (O6).

## Decisions still with Darwin

- The success metric that triggers building Action mode, set before launch.
- **DM policy when two users share more than one org.** Which org's `allowDirectMessages` governs? Neither v1.4 nor this brief specifies it. Needs a rule before v0 ships.
- If S7 passes, the Drive adapter is added under **CR-15**. No new CR is needed — CR-15 covers the target and CR-19 covers the build order.
- This brief follows **CR-16** (echoed OTP) and **CR-19** (S3 dev adapter first). No further CR is needed for v0.
