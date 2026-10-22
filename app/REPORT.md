# TeamChat MVP — Build Report (v0 + Action mode + Part 5)

Date: 2026-10-20  
Scope: `TeamChat_PRD_v1.4.md` + `TeamChat MVP v0 Brief for the Code Agent.md`  
Build: backend first, then thin web and mobile clients, then Action mode + Action Inbox, then the S5 and Action burst tests.

## 1. Status

The v0 chat foundation and the Action mode/Action Inbox layer are built and working end-to-end on the dev deployment, including the Part 1 corrections.

- Backend: complete for the v0 scope, with the Part 1 OTP-limit, presigned-POST, DM-attachment, and message-owned read-path corrections. The Action workflow is complete: message creation, the full transition table, typed audit events, rollup, my-tasks, raised-by-me, and viewer flags.
- Web: complete for the thin-client scope, browser-verified; uploads use presigned POST. Action mode adds the composer toggle, task cards, the Action Inbox, three lists, filters, and the audit panel.
- Mobile: complete for the thin-client scope; typechecks, Expo Doctor 20/20, and an Android bundle build after the Action changes (735 modules, 2.1 MB HBC). Action parity covers claim, claimed-by, and mark-done, smoke-tested through the Expo web target. No native device/emulator was available, so the native binary and native photo picker were not launched.
- Automated v0 DoD verification: **37/37 PASS** (`run id mvfovja3`, `evidence/verify-v0.txt`).
- Action mode + Action Inbox verification: **26/26 PASS** (`run id mvgvksge`, `evidence/action-inbox.txt`). This covers concurrent claims, every claim refusal, ancestor-manager oversight, separation of duties, self-close, reopen, forward/reassign, DM lifecycle, rollup descendants/DM exclusion, archived/hidden behaviour, edit/delete refusal, audit access, and one typed event per transition.
- Production compile refusal (CR-16): **PASS** (`evidence/cr16-prod-compile-failure.txt`).
- Per-org storage cap: **3/3 PASS** (`evidence/cap-check.txt`).
- Part 1 attachment read path: **9/9 PASS** (`evidence/part1-attachment-read.txt`).
- Part 1 functional + OTP limits: **14/14 PASS** after the per-IP metadata fix (`evidence/part1-verify.txt`).
- Focused IP window: **20 accepted, 21st denied** (`evidence/otp-ip-limit.txt`).
- S5 v2 distributed run: **session target missed; query/action targets met.** Best fresh-fleet ramp **8,268/10,000 (82.7%)**; 256 queries and 512 concurrent sends completed with zero errors in the combined burst. One message to 8,000 viewers took **38.2 s p95**; 40 groups x 200 viewers took **626 ms p95**. Fan-out stops feeling instant above roughly **427 viewers**; the largest measured point under 2 s p95 is **400**. Details in section 5.1.
- Action 512-action burst: **512/512, 0 errors.** Action mode p50 **11,884.89 ms**, p95 **23,453.00 ms**, p99 **24,404.24 ms**, wall **25,009.94 ms**. Against an adjacent discussion control the overhead is **+14.42% p50, +20.84% p95, +20.45% p99, +19.13% wall**; against the original baseline it is **+0.42%, +9.65%, +10.07%, +9.96%**. Details in section 5.2.
- Action UI smoke: web and mobile flows completed; exact task IDs, filters, refusal message, and console state are recorded in `evidence/action-ui-smoke.txt`.

Part 5 (public REST API, outbound webhooks, widget shell hardening) is now built and verified: **37/37 PASS** (`run id mvhl1yga`, `evidence/verify-part5.txt`). Shadow-account onboarding and hierarchy beyond the one-level org tree remain out of scope.

## 2. Environment

| Item | Value |
|---|---|
| Dev deployment | `dev:adventurous-squirrel-356` |
| Convex URL | `https://adventurous-squirrel-356.convex.cloud` |
| HTTP site | `https://adventurous-squirrel-356.convex.site` |
| Region | `aws-us-east-1` (US East) |
| Storage dev adapter | S3-compatible MinIO in Docker (`teamchat-minio`, ports 9000/9001) behind `cloudflared` |
| Local bucket endpoint | `app/.storage/endpoint.txt` (current tunnel URL; bucket `teamchat`) |
| Web dev server | `http://localhost:3000` |
| Mobile smoke export | Expo web export; v0 smoke at `http://localhost:4173`, Action UI smoke at `http://[::1]:4174` |
| Auth | `@convex-dev/auth` 0.0.96, email OTP echoed on screen (CR-16) |
| Convex runtime | `convex` 1.47.0 |
| Rate limiter | `@convex-dev/rate-limiter` 0.4.2 |
| S3 signing | `aws4fetch` 1.0.20 |

The dev deployment has `JWT_PRIVATE_KEY`, `JWKS`, `TEAMCHAT_MASTER_KEY`, and `SITE_URL` set. `TEAMCHAT_BUILD_CHANNEL` and `TEAMCHAT_ORG_STORAGE_CAP_BYTES` are unset in normal operation.

## 3. File-by-file build summary

### 3.1 Backend — `app/convex/`

About 5,050 lines of TypeScript excluding generated files.

#### Schema and auth

| File | What it does |
|---|---|
| `schema.ts` | Frozen v1.4 Part 3 schema: identity, connections, organizations, invites, memberships, groups, group activity, messages, storage/config tables, Action workflow tables, API/webhook/idempotency tables. `users` is one merged Convex Auth + TeamChat table. Three v0-additive tables: `demoAuthCodes`, `attachments`, `storageUsage`. The frozen `actionInbox` and `actionEvents` tables are now used; the widget/API/webhook tables remain unused. |
| `auth.ts` | Thin, swappable auth wrapper. Pins 30-day total and inactivity session lifetime, registers the email OTP provider and user callback, calls the CR-16 runtime guard at module load, and wraps the library `signIn` with the 10-attempt verification limiter. |
| `auth/providers.ts` | Email OTP provider. Applies the per-email 3/10 min and per-IP 20/10 min request limits inside `sendVerificationRequest`, reading the caller IP from Convex request metadata. In demo mode it records the code for on-screen echo instead of sending email; OTP lifetime is 3 minutes. |
| `auth.config.ts` | Convex Auth provider configuration. |
| `auth/buildFlags.ts` | `BUILD_CHANNEL`, `DEMO_OTP_ECHO`, the compile-time `AssertTrue` guard, `buildInfo()`, and the runtime production refusal. |
| `auth/demo.ts` | Echoed-code write/read, build-info query for the client banner, and hourly expired-code sweep. |
| `auth/callbacks.ts` | Creates/updates the merged `users` row on sign-in, assigns `publicId`, normalizes email, and enforces at least one of email/phone. |
| `auth/pin.ts` | Shared constant naming the local-unlock storage key. PIN hashing and biometric calls live on the clients. |
| `crons.ts` | Hourly pending-upload sweep at minute 7; hourly demo-code sweep at minute 23. |
| `http.ts` | Minimal HTTP router placeholder; no public API was built. |
| `users.ts` | `users.me` for the clients. |

#### Libraries

| File | What it does |
|---|---|
| `lib/ids.ts` | `publicId` generation (`usr_`, `org_`, `grp_`, `msg_`, `task_`, `att_`) and unguessable invite tokens. |
| `lib/time.ts` | 30-day session, 3-minute OTP, 3-second activity debounce, 24-hour pending TTL, 7-day invite TTL. |
| `lib/crypto.ts` | AES-GCM encryption with a versioned master key (`TEAMCHAT_MASTER_KEY`), plus SHA-256 for invite hashes. |
| `lib/guards.ts` | `requireUserId`, `requireUser`, `requireActive`, `requireOrgMember`, `requireGroupRole`, `requireGroupAccess`. Membership and org-admin drill-in are enforced here. |
| `lib/address.ts` | Conversation addressing: tree groups by `publicId`, DMs by peer `publicId`. DM lookup by sorted pair key. Read access allows org owner/admin drill-in for tree groups; DMs require participation. |
| `lib/dmPolicy.ts` | DM policy: any shared org allows; no shared org allows; shared orgs with all DMs off denies. Shadow/bot accounts are excluded. |
| `lib/limits.ts` | 25 MB per-file limit, MIME allowlist (image/video/audio plus documents/archives; executables and scripts refused), 5 GiB per-org default cap with env override, filename sanitization. |
| `lib/rateLimiter.ts` | Named limits: `redeemInvite` 10/min per user; `requestUpload` 30/min per user; `otpRequestByEmail` 3/10 min; `otpRequestByIp` 20/10 min; `otpVerifyByEmail` 10/10 min. Denial messages name the scope and retry time. |

#### Feature modules

| File | What it does |
|---|---|
| `organizations.ts` | Create org + root group + owner membership + activity row; list my orgs; get org; owner/admin rename and DM-policy update. `serviceUserId` stays unset. |
| `invites.ts` | Hashed, single-use, expiring (7 days), revocable invite links; owner/admin create/list/revoke; public inspect; redeem is an action because rate-limiter consumption must be transactional, with an internal mutation doing the join. Redemption joins both the org and root group. Failed attempts count against the limit. |
| `groups.ts` | Flat tree groups only: create (parent must be org root), get, rename (display name only), add/remove member, `listMine` with activity, `tree`, and `createDm`. A nested parent is refused. Paths are immutable. |
| `groupActivity.ts` | Flow A2. One activity row per group; at most one write per 3-second window; a single scheduled trailing flush recomputes `lastMessageAt` from the group's actual newest message. |
| `messages.ts` | Send, live page (15), cursor history (25 default, max 50, non-reactive), replies, edit, soft delete. Server sets `origin: "app"`; `mode` defaults to `"discussion"` and is validated when supplied. An Action send inserts the message and exactly one `actionInbox` row in the same mutation, materialises `senderMayClose`, and returns `taskPublicId`. Rendered messages carry the viewer's `TaskCard`. Action messages cannot be soft-deleted; editing is refused once their task leaves `open`. Parent must be in the same conversation; attachments must be confirmed, uploader-owned, same-group, and not already sent. The sender's own `lastReadAt` advances in the same mutation. |
| `unread.ts` | `hasUnread` compares exactly two documents on the tree fast path (membership + groupActivity) and never scans messages. `unreadCount` is on-demand, `take(100)`, capped display `"99+"`. `markRead` validates the message belongs to the conversation and never moves the pointer backwards (stale client is a silent no-op). |
| `connections.ts` | Email connection request/accept/remove/list; in-org phone matching only, exact or digits/`+digits`, with a shared-org gate and `matched:false` for unknown/shadow/bot. No global phone lookup and no router near phone discovery. QR is a client-side rendering of an existing invite/connection token. |
| `storage/adapter.ts` | The three-operation SAL contract plus head/promote/delete helpers and the typed org storage target. |
| `storage/s3.ts` | S3 adapter using `aws4fetch`: presigned POST policy under `pending/` bound to the exact key, exact `Content-Type`, and `content-length-range` 1..declared size (capped at 25 MB), signed GET, HEAD at confirm, S3-side CopyObject promotion then delete of the pending object. No bytes pass through Convex. |
| `storage/config.ts` | Org S3 config and encrypted credentials (`byosCredentials` only), owner/admin-only `setS3Config`, client-safe derived `myStorageState` (`s3` or `none`), active-config lookup, group/DM upload resolver, and action-side decryption. A DM resolves the first shared org with active storage. |
| `storage/attachments.ts` | `requestUpload`, `confirmUpload`, `requestRead`, hourly `sweepPending`, and internal create/confirm/access/expiry steps. Accepts tree groups and DMs; enforces 25 MB and MIME at ticket and confirm, per-org cap at ticket and again at confirm, pending TTL, single-use attachment, and conversation access before signing a read. The read path takes `fileKey` and `storageConfigId` only from `messages.attachments[].storageRef`; the `attachments` row supplies status and message wiring. If the cap refuses at confirm, the promoted object is deleted. |
| `actionInbox.ts` | Action workflow and Action Inbox. Mutations: `claim`, `markDone`, `forward`, `reassign`, `close`, `reopen`, `archive`, `hideClosed`. Queries: `rollup`, `myTasks`, `raisedByMe`, `events`, `assignableMembers`, plus the bounded task-card renderer used by `messages.listLive` and history. Every state change patches the task and inserts its typed `actionEvents` row in the same mutation. Enforces exact-group claim membership, active accounts only, ancestor manager close/archive, DM participants as owners, separation of duties, no self-forward, same-status forwarding, and a bounded rollup (one indexed `by_status_path` query per live status). |
| `testing.ts` | Internal-only verification hooks: account-state and membership mutators, `actionProbeState`, and `actionMessageCounts`. Used by the scripts through the Convex CLI; not reachable by the clients. |
| `probes.ts` | Step 0 S1/S2 probes and probe helpers, preserved as requested. Not part of the v0 client flow. |

### 3.2 Web client — `app/web/`

Next.js 16.4, React 19.1, Convex 1.47. About 2,200 lines of TypeScript/TSX.

| File | What it does |
|---|---|
| `src/app/layout.tsx`, `page.tsx` | App shell and entry page. |
| `src/app/globals.css` | Demo UI styling, including unread dot, count chip, connection chip, composer mode toggle, task cards, Action Inbox, status colours, and audit panel. |
| `src/app/offline/page.tsx` | Local-storage-only offline reader. Shows the newest 100 cached messages per conversation with no Convex client. |
| `src/components/SignIn.tsx` | Email OTP sign-in with echoed code and the visible demo banner. |
| `src/components/Workspace.tsx` | Org switcher/creation, flat group list, unread dots, on-demand hover/focus count chip, group open, group/invite admin, S3 config form, connections, DM creation, local PIN setup/lock. Adds the Action Inbox sidebar entry and a live connection chip. The chip exposes the Convex client's existing jittered exponential reconnect (1 s base, 16 s cap) rather than replacing it. |
| `src/components/ActionInbox.tsx` | Action Inbox surface: group selector, live counts, All/Open/Claimed/Done/Closed filters, Review queue shortcut, and three lists — rollup (own group + descendants, DMs excluded), My tasks (claimed by default), and Tasks I raised (open by default). |
| `src/components/TaskCard.tsx` | Reusable task card with status, flag type, task ID, sender/claimant/forward/closed metadata, viewer-gated Claim / Mark done / Forward / Reassign / Reopen / Close / Archive / Hide closed controls, transfer target picker, and lazily loaded chronological audit panel. Claim/close/archive use a confirmation prompt. |
| `src/components/Conversation.tsx` | Live 15-message page, on-demand older history, text send, photo upload (`requestUpload` → presigned POST with policy fields → `confirmUpload` → send), attachment rendering, reply/edit/delete affordances. Adds the Discussion/Action composer toggle, Action flag-type selector, and inline task cards for every Action message. |
| `src/lib/cache.ts` | Offline cache merge/slice plus the shared `TaskStatus`, `TaskCard`, and viewer-flag types rendered by both the inbox and conversation cards. |
| `src/components/providers.tsx` | Convex auth/provider wiring. |
| `src/lib/api.ts` | Typed API shim: runtime `anyApi` object plus type-only generated API import. |
| `src/lib/convex.ts`, `errors.ts`, `format.ts`, `pin.ts` | Client setup, error formatting, timestamps, local PIN hashing. |

Verified in the browser: banner; OTP sign-in; org creation; flat group list; text send; cross-tab live delivery; unread dot and `markRead`; S3 config; photo upload end-to-end; invite/connection/DM send and live delivery; DM absent from the tree; `/offline` cache capped at 100 with zero Convex requests. The Action UI smoke additionally verified the composer toggle, one-card-per-action-message rendering, claim, mark-done, the Review queue, the separation-of-duties refusal, the audit panel, and the connection chip; see `evidence/action-ui-smoke.txt`.

### 3.3 Mobile client — `app/mobile/`

Expo SDK 58, React Native 0.88, React 19.3. About 2,150 lines of TypeScript/TSX.

| File | What it does |
|---|---|
| `App.tsx`, `index.ts` | Session restore, simple state navigation (no Expo Router), sign-in/workspace/conversation/offline/PIN routing. |
| `src/components/SignInScreen.tsx` | OTP sign-in, demo banner, cached-message entry point. |
| `src/components/WorkspaceScreen.tsx` | Flat group/DM list, unread dots, org display, cache and PIN controls, sign-out. |
| `src/components/ConversationScreen.tsx` | Live last 15, load-older history, text send, photo picker + presigned POST + confirm + send, on-demand unread count, cache write. Adds the Discussion/Action composer toggle, Action flag cycling, and task cards with claimed-by metadata plus Claim task / Mark done parity. Web uses `window.confirm` because React Native Web's `Alert.alert` is a no-op; native keeps `Alert.alert`. |
| `src/components/OfflineScreen.tsx` | AsyncStorage-only reader; newest 100 per conversation; no network or session. |
| `src/components/DemoBanner.tsx` | Visible demo-build banner. |
| `src/lib/cache.ts` | AsyncStorage cache merge/slice to 100 plus the shared task-card types used by the mobile conversation screen. |
| `src/lib/storage.ts` | SecureStore token adapter with web localStorage fallback. |
| `src/lib/pin.ts` | SHA-256 PIN hash in SecureStore/keychain plus OS biometric stub. |
| `src/lib/convex.ts`, `errors.ts`, `format.ts`, `theme.ts` | Client setup, errors, formatting, colors. |
| `app.json`, `.env.example`, `README.md` | Expo config, deployment URL example, run notes. |

The mobile client does not create orgs, send invites, or edit messages; those remain on web. DMs support text and attachments like tree groups. Mobile Action parity is deliberately limited to claim, claimed-by, and mark-done; the Action Inbox, transfer controls, and audit panel are web-only. The Expo web target is a local smoke-test aid, not a shipping client.

### 3.4 Scripts, probes, evidence

| File | What it does |
|---|---|
| `scripts/verify-v0.mjs` | 37-check end-to-end DoD verification against the dev deployment. |
| `scripts/cap-check.mjs` | Per-org byte cap check with a temporary 1,000,000-byte cap. |
| `scripts/s5-v2-scenario.mjs`, `s5-v2-worker.mjs`, `s5-v2-merge.mjs` | S5 v2 distributed harness: four generator processes, fresh 10,000-session fleet per scenario, exact curve points, combined burst, 40-group phase, sequential baseline, and evidence merge. |
| `scripts/s5-burst.mjs` | Original single-process S5 harness, retained for the sequential baseline and historical comparison. |
| `scripts/verify-part1.mjs`, `scripts/attachment-read-path.mjs`, `scripts/otp-ip-limit.mjs` | Part 1 functional, OTP-limit, DM-attachment, presigned-POST, and message-owned read-path checks; the focused IP script proves exactly 20 accepted requests and a 21st denial. |
| `scripts/verify-action-inbox.mjs` | 26-check Action workflow verification. Uses cached real sessions for the API, and internal `testing.ts` mutations/queries through the Convex CLI for account-state changes and raw probes. |
| `scripts/action-burst.mjs` | 512 concurrent `messages.send` calls from eight real users to one write group with no subscribers. `--mode=action` adds exactly one task insert per send; `--mode=discussion` is the control. Each run creates a fresh org and group and caches tokens. |
| `scripts/setup-dev-env.mjs`, `dev-tunnel.mjs` | Reproducible dev auth env and storage tunnel; MinIO runs in Docker. |
| `scripts/probe-*.mjs`, `probes/`, `PROBE_REPORT.md` | Step 0 probes, preserved; `PROBE_REPORT.md` records the `by_email`/`by_phone` schema-name deviation. |
| `evidence/verify-v0.txt` | Fresh 37/37 run, `run id mvfovja3`. |
| `evidence/cap-check.txt` | Fresh 3/3 cap run. |
| `evidence/cr16-prod-compile-failure.txt` | Production compile refusal. |
| `evidence/part1-attachment-read.txt` | 9/9 message-owned read-path proof and POST-policy checks. |
| `evidence/part1-verify.txt` | Full Part 1 run, including OTP limits. |
| `evidence/otp-ip-limit.txt` | Focused IP proof: 20 accepted, 21st denied. |
| `evidence/action-inbox.txt` | 26/26 Action workflow run, `run id mvgvksge`, including exact refusal and event-count assertions. |
| `evidence/action-ui-smoke.txt` | Web and Expo-web Action UI smoke transcript, task IDs, Review queue, separation-of-duties refusal, console state, and mobile claim/done. |
| `evidence/action-burst-baseline.json` | Original 512-action discussion baseline. |
| `evidence/action-burst-action.json` | 512-action Action-mode run. |
| `evidence/action-burst-baseline-rerun.json` | Adjacent 512-action discussion control, run after the Action run. |
| `evidence/s5-v2-result.json`, `s5-v2-summary.md` | Merged S5 v2 result and summary tables. |
| `evidence/s5-v2-curve*.json`, `s5-v2-fanout40.json`, `s5-v2-sequential.json` | Per-scenario raw evidence; logs retain the 8k instability attempts. |
| `evidence/typecheck-*.txt` | Clean backend/web/mobile typechecks, including the `-action` runs. |
| `evidence/web-build-action.txt` | Next.js production build after the Action UI changes. Clean apart from the known multiple-lockfile root warning. |
| `evidence/mobile-web-export-action.txt` | Expo web export used for the mobile Action smoke (`dist-action`, 345 modules, 743 KB). |
| `evidence/expo-export-android-action.txt` | Android production bundle after the Action changes (735 modules, 2.1 MB HBC). |
| `evidence/expo-doctor.txt`, `expo-export-android.txt`, `mobile-smoke.txt` | Mobile checks and v0 smoke flow. |
| `evidence/web-smoke.txt` | Web browser smoke flow and offline cache evidence. |

## 4. Definition of Done

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Sign-in produces an active account | **PASS** | T1: `accountState=active`, `publicId=usr_...`; unauthenticated query refused (T1b). |
| 2 | Production build refuses to compile with echoed OTP enabled | **PASS** | With `BUILD_CHANNEL="production"` and `DEMO_OTP_ECHO=true`, `tsc` fails: `buildFlags.ts(26,41): error TS2344: Type 'false' does not satisfy the constraint 'true'`. Runtime guard also refuses a production-marked deployment. |
| 3 | Visible demo banner | **PASS** | Web and mobile sign-in and workspace screens render "Demo build — not authentication…" from `auth.demo.buildInfo`. |
| 4 | Invite links single-use, expiring, revocable, rate-limited | **PASS** | T2b (join), T2c (second redemption refused), T2d (expired refused), T2e (revoked refused), T2f (11th attempt in a minute rate-limited). |
| 5 | Groups flat, path `/<orgPub>/<grpPub>`, nested parent refused | **PASS** | T3 path; T3b nested parent refused; T3c rename keeps path; T3d tree is root + flat children. |
| 6 | One message insert, server-set origin, live page, sender pointer | **PASS, with the write-count note below** | T4 sender `hasUnread=false`; T4b live 15. Code sets `origin:"app"` and advances only the sender's own membership. Action messages add exactly one `actionInbox` row in the same mutation; no `actionEvents` row at creation. |
| 7 | Live page is 15; older history is separate and non-reactive | **PASS** | T4b exactly 15 newest; T4c separate cursor page returns all 22; history is an imperative query, not a subscription. |
| 8 | Two messages within 3 s are never lost | **PASS** | T4d: second message present; after 3.5 s the trailing flush equals the newest message timestamp. |
| 9 | Attachments confirmed before recording; oversize/wrong type refused; unconfirmed unreachable; non-member refused | **PASS** | T6b 26 MB refused; T6c `.exe` refused; T6d ticket→presigned POST→confirm promotes out of `pending/`; T6d2 read before confirm refused; T6e member round-trip; T6f non-member read ticket refused; T6g double attach refused. Part 1 adds DM tickets, policy conditions, and the message-owned read path. |
| 10 | Per-org byte cap | **PASS** | `cap-check.mjs`: 800 kB confirmed; second 800 kB refused with `800000 + 800000 > 1000000`; env unset afterwards. |
| 11 | `hasUnread` reads exactly two documents; count only on demand | **PASS by implementation and T5** | Tree fast path: one `memberships` lookup + one `groupActivity` lookup, no message scan. `unreadCount` is a separate query (`take(100)`, `"99+"`) called only when a count is rendered. T5 count 1→0. |
| 12 | Offline read of newest 100 after restart | **PASS on the web/Expo target; native run untested** | Web `/offline`: seeded 120, cache capped at 100, 100 rendered with zero Convex requests. Mobile: 108 messages loaded, cache reached exactly 100, sign-out + page reload, unauthenticated cache screen showed "100 of the newest 100 messages". |
| 13 | DMs work and never appear in tree/rollup/org-admin queries | **PASS** | T7 both directions; T7b DM row has `publicId=null`, `path=null` and is absent from tree/path results; T7c unread works; T7d policy cases; T7e policy flip blocks sends. DMs structurally have no `path`/`orgId`/`publicId`. |
| 14 | DM policy is not silently wrong | **PASS** | T7d: no shared org ⇒ allowed; shared org with DMs off ⇒ denied; T7e re-checks on every send. |
| 15 | Web photo send end-to-end | **PASS** | Browser: ticket → presigned POST → confirm → send → `<img>` 320 px; live delivery observed. No bytes proxied. |
| 16 | S5 concurrent test report | **Session target FAIL; query/action targets PASS** | Best fresh-fleet ramp 8,268/10,000 (82.7%); all failures were connection timeouts. 256 concurrent queries and 512 concurrent actions completed with zero errors in the combined burst. Fan-out breaks 2 s p95 above ~427 viewers. Full report in section 5.1. |

### Part 1 corrections

| Correction | Result | Proof |
|---|---|---|
| Email OTP request limit 3/10 min | **PASS** — the demo echo served three requests; the 4th was refused with the email-scope message | `verify-part1.mjs` |
| Client-IP OTP limit 20/10 min | **PASS** — on a fresh window, exactly 20 requests were accepted and the 21st was refused; the IP is read from async Convex request metadata | `otp-ip-limit.mjs`, `verify-part1.mjs` |
| Verification attempts 10/email/10 min | **PASS** — 10 wrong-code attempts reached the verifier; the 11th was refused before verification | `verify-part1.mjs` |
| Upload ticket is presigned POST, not PUT | **PASS** — ticket has policy, algorithm, credential, date, exact key, exact `Content-Type`, and `content-length-range` 1..declared size | `attachment-read-path.mjs`, `verify-part1.mjs` |
| SAL contract and HEAD-at-confirm retained | **PASS** — confirm HEADs the pending object, re-checks size/MIME/cap, promotes by S3 CopyObject, then deletes the pending object | `verify-part1.mjs` |
| DM participants can upload and send attachments | **PASS** — both participants see shared-org storage; DM message records the attachment; non-participants are refused | `verify-part1.mjs` |
| Attachment reads resolve only from `messages.attachments[].storageRef` | **PASS** — tampering with the `attachments` row's `fileKey`/`storageConfigId` does not change the signed key; removing the id from the message makes it unreachable | `attachment-read-path.mjs` |
| `users.by_email` / `users.by_phone` schema deviation | **Recorded, not changed** — the auth library requires indexes named `email`/`phone`; `PROBE_REPORT.md` records the deviation and affected call sites | `PROBE_REPORT.md` |

### Action mode and Action Inbox acceptance

| Requirement | Result | Evidence |
|---|---|---|
| Composer can choose Discussion or Action; `origin` is server-set to `"app"`; `mode` is client-supplied but server-validated | **PASS** | `messages.send` fixes `origin`; invalid flag use on discussion is refused. A1 creates an action task; A1b sends discussion with no task and confirms the flag is action-only. |
| An Action message creates exactly one `actionInbox` row in the same mutation | **PASS** | A1: one message, one task, zero events at creation. Creation exists only in `messages.send`; no second insert path. |
| `senderMayClose` is materialised at creation, never re-derived | **PASS** | A3: stored `true` before and after the sender's account became provisioned. |
| Full transition table, no un-claim; closed/archived terminal | **PASS** | Claim, done, reopen, close, archive and hide paths implement the table. C5 refuses claim on claimed/done/closed/archived; T3 reopens to the same claimant; archive cannot be reopened. |
| Every state change writes exactly one typed `actionEvents` row in the same mutation | **PASS** | T4 and the probe assertions in the 26-check run. `forward`/`reassign` both write `forwarded` with actor/from/to; `closed` carries `selfClosed`. |
| Claim requires exact active group membership; shadow, bot, provisioned, non-member and ancestor-manager claims refused | **PASS** | C1 (non-member), C2 (shadow/bot/provisioned), C3 (ancestor manager may close but not claim), I3 (inactive excluded). |
| Concurrent claims produce one winner and one event | **PASS** | C4: one winner, seven refused, exactly one `claimed` event. |
| Closing authority at the group or any ancestor; sender only when `senderMayClose`; DM participants are owners | **PASS** | T1/T2/C3/D1/D2. DM claim, done, reopen, done, close and archive all exercised. |
| Separation of duties: a different eligible closer is required whenever one exists; `selfClosed` only when the assignee is the sole eligible closer | **PASS** | T1 refuses the claimant while another closer exists; T2 permits and records `selfClosed=true` when the claimant is the only eligible closer. |
| Forward/reassign both write `forwarded` with actor/from/to; status stays `claimed`; no self-forward; reassign off an absent assignee, not a done task | **PASS** | F1/F3 event fields and status; F2 self-forward refused; reassign on done refused. |
| `closed` means work done; `archived` means withdrawn; hiding closed sets `archivedAt` without changing status | **PASS** | R2: archived excluded from rollup/counts but audit retained; R3: hidden closed stays `status=closed`, count stays 1, default list drops it, no event. |
| Edit refused once claimed; Action messages cannot be deleted | **PASS** | I1: edit allowed while open, refused after claim. I2: action delete refused; discussion soft-delete still works. |
| Rollup covers own group + descendants, excludes DMs, uses one indexed query per live status, and is chronological | **PASS** | R1: own + child included, DM excluded, counts correct, chronological. Implementation uses `by_status_path` per status and sorts by creation. |
| My tasks, tasks I raised, and chronological read-gated audit | **PASS** | R4 and I4; audit is ordered ascending and a non-member is refused. |
| Manager review queue is the rollup filtered to `done` | **PASS** | `ActionInbox` Review queue sets the `done` filter; web smoke confirmed the task appears there. |
| Web UI: composer toggle, task cards, inbox filters, three lists, audit, closer controls; mobile parity: claim, claimed-by, done | **PASS on web; mobile verified on Expo web target** | `evidence/action-ui-smoke.txt`; no native device/emulator available. |
| Client hardening: jittered exponential reconnect, no auto-open group, no group member cap | **PASS by implementation and smoke** | Connection chip exposes the installed Convex client's 1 s→16 s jittered backoff; `selected` starts `null`; no member cap was added. |
| 512-action burst stays error-free with Action mode | **PASS, with measured overhead** | 512/512, 0 errors; +14.42% p50 / +20.84% p95 / +19.13% wall vs the adjacent discussion control. Section 5.2. |

### Write-count note (requirement 6 / locked rule)

A text message performs:

1. one `messages` insert;
2. one patch of the **sender's own** `memberships.lastReadAt` (required by Flow A3's sender exception);
3. the debounced `groupActivity` write — at most one per group per 3 seconds, not one per message.

There is no per-recipient write, no group-scoped counter, and no hot shared document written on every send. Attachments add one bounded patch per attachment to mark it recorded. An Action message adds exactly one `actionInbox` insert in the same mutation; it does not add an `actionEvents` row at creation. I read "one message = one database write" as the anti-fan-out/anti-counter rule, not a literal prohibition on the sender's read pointer, the debounced activity row, or the one task row that defines Action mode. This distinction is called out rather than hidden.

## 5. Burst tests

### 5.1 S5 v2 distributed burst

Harness: `scripts/s5-v2-scenario.mjs` with four separate Node generator processes (`s5-v2-worker.mjs`), run against the dev deployment. Each scenario starts a fresh 10,000-session fleet, authenticates every session, and keeps exactly one viewer set alive. Reusing one 8k fleet across the whole curve measured teardown and socket loss, not fan-out, so each curve point gets a new fleet.

Terminology: in this subsection, "action burst" means concurrent `messages.send` calls, not Action-mode messages. The S5 harness predates Action mode and sends discussion messages. The Action-mode comparison is section 5.2.

Measurement points:

- **T0** is immediately after the `messages.send` mutation returns in the master process.
- **T1** is inside the `messages.listLive` subscription callback in the generator process.
- Both use `performance.timeOrigin + performance.now()`; cross-process negative latency is clamped to 0 for sub-millisecond clock skew.
- The query burst is 256 one-shot first-time queries, not cached subscriptions.
- The action burst is 512 `messages.send` calls across eight real users to a write group with no live subscribers.
- The combined burst starts 256 queries, 512 actions, and one fan-out at the same target epoch.
- The session ramp uses cached refresh tokens, not OTP, so later scenarios do not consume the OTP budget.

Scenarios: `curve400`, `curve500`, `curve1000`, `curve2000`, `curve4000`, `curve8000`, `fanout40`, and `sequential`. Raw evidence is in `evidence/s5-v2-*.json`; the merged report is `evidence/s5-v2-result.json` and `evidence/s5-v2-summary.md`.

#### Achieved vs cap

| Gate | S256 cap | Achieved | Verdict |
|---|---:|---|---|
| Concurrent sessions | 10,000 | **8,268 best** (82.7%); range 7,986–8,268 across fresh fleets | **FAIL** |
| Concurrent queries | 256 | 256 calls, 0 errors, p95 345.6 ms at 4k / 314.1 ms at 8k | **PASS at cap** |
| Concurrent actions | 512 | 512 calls, 0 errors, p95 2,646 ms at 4k / 2,758 ms at 8k | **PASS at cap, thin** |
| Combined burst | all three at once | 256 queries + 512 actions + fan-out, 0 errors at 4k and 8k | **PASS for concurrency; fan-out latency is the problem** |
| Fan-out, one group | no numeric cap in brief | 8,000 viewers: 38.2 s p95 | **No interactive headroom** |
| Fan-out, 40 groups x 200 | no numeric cap in brief | 8,000 viewers: 626 ms p95, 0 missing | **Healthy** |

#### Session ramp

| Scenario | Requested | Connected | Shortfall | Ramp s | Failures |
|---|---:|---:|---:|---:|---|
| curve400 | 10,000 | 8,167 | 1,833 | 266.4 | 1,833 ramp:timeout |
| curve500 | 10,000 | 8,013 | 1,987 | 263.2 | 1,987 ramp:timeout |
| curve1000 | 10,000 | **8,268** | 1,732 | 290.9 | 1,732 ramp:timeout |
| curve2000 | 10,000 | 8,024 | 1,976 | 280.7 | 1,976 ramp:timeout |
| curve4000 | 10,000 | 7,986 | 2,014 | 186.6 | 2,014 ramp:timeout |
| curve8000 | 10,000 | 8,040 | 1,960 | 196.6 | 1,960 ramp:timeout |
| fanout40 | 10,000 | 8,044 | 1,956 | 252.4 | 1,956 ramp:timeout |
| sequential | 10,000 | 8,057 | 1,943 | 188.1 | 1,943 ramp:timeout |

Every failure in every ramp was a 20-second first-result timeout with `hasEverConnected=false`: the client could not establish the WebSocket at all, not a query or auth failure. The deployment consistently refuses new connections above roughly 8.0–8.3k. The dev deployment's class is not exposed by the CLI, so this is an observed dev ceiling, not proof that a production S256 deployment has the same cap.

#### Fan-out curve

One message to one group; every subscribed viewer received it.

| Requested viewers | Subscribed | Received | p50 ms | p95 ms | p99 ms | Max ms |
|---:|---:|---:|---:|---:|---:|---:|
| 400 | 400 | 400 | 974 | **1,852** | 2,003 | 2,019 |
| 500 | 500 | 500 | 1,218 | **2,409** | 2,483 | 2,501 |
| 1,000 | 1,000 | 1,000 | 2,570 | **4,681** | 4,920 | 5,019 |
| 2,000 | 2,000 | 2,000 | 5,063 | **9,501** | 9,900 | 9,995 |
| 4,000 | 4,000 | 4,000 | 9,879 | **19,126** | 19,817 | 20,175 |
| 8,000 | 8,000 | 8,000 | 20,128 | **38,220** | 39,783 | 40,442 |

The curve is almost linear at **4.79 ms per viewer**. A 2,000 ms p95 threshold falls at roughly **427 viewers**. The largest measured point under 2 s p95 is **400 viewers** (p95 1,852 ms, p99 2,003 ms). 500 viewers is already over at 2,409 ms.

**Recommended standard-tier max group size: 400 members.** That is the measured edge if every member is live (p95 1,852 ms). At the PRD's 60% shift-start concurrency, 400 members is only ~240 live viewers, so the p95 headroom is larger in practice. Use **300 members** if p99 must stay under 2 s even when the whole group is live, because the 400-viewer run's p99 was 2,003 ms. CR-13's proposed ~300 threshold is therefore supported by measurement, and the current standard tier should not assume an 8,000-member live group is interactive.

#### 8,000-viewer instability

8,000 viewers in one group is not reliably sustainable on this deployment. Three fresh attempts produced:

| Attempt | Ramp connected | Assigned viewers | Ready viewers | Sockets held | Fan-out p95 |
|---|---:|---:|---:|---:|---:|
| 1 | 8,091 | 4,692 | 6,242 | 4,655 | 27.9 s (invalid: set collapsed) |
| 2 | 8,049 | 3,942 | 5,338 | 5,679 | 15.0 s (partial set) |
| 3 | 8,040 | 8,000 | 8,000 | 8,040 | **38.2 s** |

When subscription setup collapsed, workers reported `subscription produced no first result in 30 s`; the server shed thousands of sockets while 8,000 queries targeted the same group. Attempts 1 and 2 predate adding the `no first result` string to the classifier, so their logs label those failures `unknown`; by message they are 30-second subscription timeouts and are counted as `subscription:timeout` in this report. This is evidence that the failure mode is concentration in one live query, not the total session count: the same 8,000 viewers spread across 40 groups subscribed in 4 seconds and delivered in 626 ms p95.

#### Combined burst

| Scale | Queries | Actions | Fan-out | Missing |
|---|---:|---:|---:|---:|
| 4,000 viewers | 256/256, p95 345.6 ms, 0 errors | 512/512, p95 2,646 ms, 0 errors | 4,000/4,000, p95 19,181 ms | 0 |
| 8,000 viewers | 256/256, p95 314.1 ms, 0 errors | 512/512, p95 2,758 ms, 0 errors | 8,000/8,000, p95 37,954 ms | 0 |

The send mutation returned 369 ms (4k) and 379 ms (8k) after the target epoch, so the fan-out latencies include the mutation's own queueing delay. The 4k combined burst is the reliable combined result. The 8k combined result comes from the one attempt where all 8,000 subscriptions held; the other two attempts could not form a valid set.

The action pool is eight cached users, so each user issues 64 concurrent sends and the result includes per-sender membership-row contention. The original 64-user harness measured 1.69 s p95 at 7,841 sessions. The 2.6–2.8 s figures here are therefore conservative for action throughput, not a clean deployment ceiling.

#### Sequential baseline

Same 8k fleet, queries and actions one at a time, then one 4,000-viewer fan-out:

| Phase | Calls | Errors | p50 | p95 | Wall time |
|---|---:|---:|---:|---:|---:|
| Queries, one at a time | 256 | 0 | 275 ms | 342 ms | 74.6 s |
| Actions, one at a time | 512 | 0 | 309 ms | 389 ms | 165.5 s |
| Fan-out | 4,000 | 0 | 10,058 ms | 19,192 ms | — |

Against the 4k combined burst, query p95 is unchanged (342 → 346 ms) and fan-out p95 is unchanged (19,192 → 19,181 ms), but action p95 rises **6.8x** (389 → 2,646 ms). The action path is the part that degrades when all three phases overlap; fan-out latency is dominated by the viewer count itself, not by the concurrent query/action load.

#### 40 groups x 200 viewers

- 8,000 viewers across 40 groups, 40 messages sent, one per group.
- 8,000/8,000 receipts, 0 missing.
- p50 327 ms, p95 **626 ms**, p99 674 ms, max 835 ms.
- One insert per message; no per-recipient or per-message group writes.

#### Interpretation

- **The 10,000-session gate was not demonstrated.** The best fresh fleet reached 8,268 (82.7%). Every shortfall was a connection-establishment timeout, not a query or auth error.
- **The query and action caps were met, exactly at the cap.** 256 queries and 512 actions completed with zero errors, but this proves behaviour at the cap, not above it. Action p95 under the combined burst is 2.6–2.8 s, which is thin for interactive sends.
- **Fan-out is the binding product problem.** One 8,000-viewer group takes 38 s p95; the same viewers in 40 groups take 626 ms. The per-group viewer count, not the org's total session count, sets the cost.
- **The dev class is unknown.** The observed ~8.3k connection ceiling may be a dev-tier limit. A production-class S256 re-run is still required before declaring the session gate pass or fail.
- **Risk if S256 is not met:** Business/Enterprise at a **$2,500/month minimum plus a per-deployment class fee**. That is 2.5x the entire Phase 1 budget.

#### Lever status

| Lever | Status |
|---|---|
| Connect widget only while open | **N/A** — no widget was built. |
| Drop idle sessions | **Not implemented.** A production client policy could close idle sockets; it would need its own test. |
| Keep the 15-message live page | **Implemented and verified.** Live page is exactly 15; history is separate. |
| Cap standard-tier group size | **Recommended at 400 measured / 300 conservative.** Fan-out exceeds 2 s p95 above ~427 viewers. |

#### Recommendation

Do not onboard a 10,000-session org on the strength of this dev run. Re-run the same harness on a production-class S256 deployment. Independently of the tier, cap standard-tier live groups at 400 (300 for p99 headroom) or move larger groups to announcement-style/non-live reads. The 40 x 200 result shows that distributing viewers across groups is the effective mitigation; increasing the deployment class does not fix a single hot group's fan-out cost by itself.

### 5.2 Action mode 512-action before/after

Harness: `scripts/action-burst.mjs`. Each run creates a fresh org and write group, caches eight real sessions, and sends 512 `messages.send` calls concurrently through those eight clients to one group with no live subscribers. The run measures the send mutation in isolation from the session ramp and fan-out. The only difference in Action mode is one `actionInbox` insert per message inside the same mutation; no `actionEvents` row is written at creation.

| Run | Mode | Calls | Errors | p50 ms | p95 ms | p99 ms | Max ms | Wall ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Original baseline (15:27) | discussion | 512/512 | 0 | 11,835.17 | 21,389.02 | 22,171.04 | 22,730.74 | 22,745.26 |
| Action run (16:08) | action | 512/512 | 0 | 11,884.89 | 23,453.00 | 24,404.24 | 24,987.75 | 25,009.94 |
| Adjacent control (16:09) | discussion | 512/512 | 0 | 10,386.72 | 19,409.01 | 20,261.32 | 20,985.12 | 20,993.45 |

**Action overhead**

| Control | p50 | p95 | p99 | Wall |
|---|---:|---:|---:|---:|
| Original baseline | +0.42% | +9.65% | +10.07% | +9.96% |
| Adjacent rerun | +14.42% | +20.84% | +20.45% | +19.13% |

The two discussion runs differ materially (adjacent p95 is 9.3% lower than the original), so the honest result is a range, not a single number. Against the original baseline the extra task insert costs **+9.7% p95**; against the tighter adjacent control it costs **+20.8% p95**. In both comparisons throughput is preserved: **512/512 calls succeed with zero errors**. Action mode adds one indexed row, not a fan-out or a second write path; the delta is consistent with that extra insert plus normal dev-deployment variance.

The absolute latencies are high because 512 concurrent sends share eight sender membership rows; they are not interactive single-send latency. The same shape produced 2.6–2.8 s p95 in the S5 combined burst. This test is a before/after comparison of the mutation, not a user-facing latency budget.

**Transport correction.** S5 v2 sent the 512-action burst across eight users over `ConvexClient` WebSockets and measured **p95 2,757.93 ms** at 8k viewers (2,646.39 ms at 4k), not 23 s. The 23,453.00 ms p95 in the table above came from `ConvexHttpClient`: each account's 64 sends were effectively serialized on one HTTP connection (64 × ~345 ms RTT ≈ 22 s), so it measured client-side queueing, not deployment send latency. Re-running this harness over the same WebSocket transport (`baseline-ws` and `action-ws`, three runs per mode, 512/512 with zero errors) gives discussion p50/p95/wall **1,608 / 2,631 / 2,796 ms** and Action **1,653 / 2,776 / 3,037 ms** on the run means. Task overhead is therefore **+2.8% p50, +5.5% p95, +8.6% wall** (medians +2.0%, +7.8%, +7.7%), not the **+14.42% / +20.84% / +19.13%** HTTP comparison, which was inflated by per-connection serialization and should not be quoted as the WebSocket shape's task cost.

Evidence: `evidence/action-burst-baseline.json`, `evidence/action-burst-action.json`, `evidence/action-burst-baseline-rerun.json`. WebSocket reruns: `evidence/action-burst-baseline-ws.json`, `action-burst-action-ws.json`, plus the `-ws-2` and `-ws-3` pairs.

## 6. Decisions the PRD/brief did not cover

These are the decisions I made. None were silent.

### Schema and auth

1. **`users` is one merged table.** Convex Auth fields plus the Part 3 fields/indexes. A second auth table would contradict the library's model.
2. **Dropped duplicate `by_email` / `by_phone` indexes.** Part 3 asks for them, but the auth library requires indexes named `email` and `phone` on the same fields; Convex rejects two indexes with identical fields on one table. Application code uses `email`/`phone`. `PROBE_REPORT.md` records this as the one schema-name deviation, with the affected call sites. The schema was not changed to fake the names.
3. **Three additive v0 tables:** `demoAuthCodes` (CR-16 echo), `attachments` (SAL pending/confirmed state), `storageUsage` (per-org byte cap). Part 3 defines no table for pending uploads.
4. **Auth module is `convex/auth.ts`, not `convex/auth/index.ts`.** `@convex-dev/auth` uses string function references (`"auth:signIn"`), so `auth.ts` is the module. Helpers live in `convex/auth/`.
5. **CR-16 mechanism:** literal build flags + type-level `AssertTrue` guard + runtime `assertAuthBuildSafe()` keyed on `TEAMCHAT_BUILD_CHANNEL=production`. The banner reads `auth.demo.buildInfo`.
6. **Session length:** 30 days for both total duration and inactivity, set explicitly rather than relying on a library default.
7. **Echoed OTP lifetime:** 3 minutes; expired codes swept hourly. Failed invite redemptions count against the rate limit.
8. **Local PIN:** SHA-256 of `teamchat-pin:<pin>` stored in SecureStore/keychain; biometric is an OS prompt stub only. Neither is authentication and neither is sent to the server.

### Organizations, groups, DMs

9. **Any active user can create an org** and becomes org owner + root-group owner. `serviceUserId` stays unset.
10. **Group creation is org owner/admin only.** Member adds/removes are allowed for group owner/manager or org owner/admin ("parents see children").
11. **Root path is `/<orgPublicId>`; a child path is `/<orgPublicId>/<grpPublicId>`.** A child may only name the org root as its parent. Reparenting does not exist. Rename changes the display name only.
12. **Both DM memberships have role `"owner"`.** A DM has no group role hierarchy.
13. **DM creation is not gated on a prior connection.** The org DM policy is the gate; the connection surface is separate. DM participants can upload and send attachments; a DM resolves the first shared org with active storage. If there is no shared org, the DM stays text-only.
14. **DM policy:** any shared org that allows DMs permits the pair; no shared org permits the pair; shared orgs with all DMs off deny. The policy is re-checked on every DM send, so flipping it off blocks an existing DM.
15. **DMs have no `path`, `orgId`, or `publicId`.** They are addressed by the peer's `publicId` + sorted pair key. This is what keeps them out of tree/path/org-admin queries structurally.

### Messages, unread, activity

16. **Text limit:** 4,000 characters. An empty message needs at least one confirmed attachment.
17. **`origin` is always server-set to `"app"`; `mode` is client-chosen and server-validated.** The first-party `messages.send` mutation defaults to `"discussion"`; `"action"` creates one task atomically. A flag type is rejected on a discussion message. A reply's parent must be in the same conversation.
18. **History page:** 25 default, max 50, cursor-paginated, non-reactive. Replies return at most 50.
19. **Edit and soft delete are sender-only.** Soft delete masks text to empty; it does not remove the row. An Action message's text is editable only while its task is `open`; once the task is claimed, editing is refused. Action messages cannot be soft-deleted at all; the task is closed or archived instead.
20. **Stale `markRead` is a silent no-op,** not an error. A pending read receipt racing the sender's own pointer update is normal.
21. **`unreadCount` excludes the caller's own messages and soft-deleted messages,** and caps display at `"99+"`.
22. **Activity flush:** one scheduled trailing flush per group per 3-second window; it recomputes from the newest message, so a burst cannot lose the latest timestamp. If a flush is already pending, later messages do no activity write.
23. **Write model:** see the write-count note in section 4. I did not add a group counter or per-recipient fan-out.
24. **DM uploads are allowed for participants.** `requestUpload` accepts either a tree group or a DM peer; the DM is resolved to the first shared org with active storage. A non-participant cannot get a ticket.

### Storage

25. **S3 adapter supports all three SAL operations.** Upload is a presigned POST; read is a presigned GET; confirm is S3-side CopyObject + DeleteObject. No bytes pass through TeamChat.
26. **Ticket lifetimes:** upload 15 minutes; read 5 minutes; pending object TTL 24 hours; hourly sweep at minute 7.
27. **Per-org cap:** 5 GiB default, overridable with `TEAMCHAT_ORG_STORAGE_CAP_BYTES`. Enforced at ticket time and again in the confirm mutation. If confirm refuses, the already-promoted object is deleted.
28. **Key layout:** `${keyPrefix}/${orgPublicId}/${attachmentId}/${safeName}` for confirmed objects; `${keyPrefix}/${pendingPrefix}/${orgPublicId}/${attachmentId}/${safeName}` while pending. Names are sanitized; keys are server-generated.
29. **Limits:** 25 MB per file; MIME allowlist covers image/video/audio plus common documents/archives; executables/scripts are refused. The ticket is a presigned POST whose policy binds the exact key, exact `Content-Type`, and `content-length-range` 1..declared size (capped at 25 MB). Confirm still HEADs the object and re-checks size/MIME/cap, so a policy bypass cannot promote an oversized object.
30. **Credentials:** only in `byosCredentials`, AES-GCM encrypted with a versioned key. Decryption happens in actions, never in queries. `myStorageState` returns only the derived `s3`/`none`; `byosProvider` is never stored.
31. **`setS3Config` is an owner/admin mutation** as the v0 stand-in for the unbuilt admin dashboard. It never returns the secret.
32. **Sweep behavior:** rows are marked expired even if the object delete fails, so the table cannot accumulate. The object is under an unreachable pending key and no row will confirm it.
33. **Cap check uses confirmed bytes.** Concurrent pending uploads can temporarily exceed the cap; the confirm step re-checks and deletes a refused promoted object.

### Connections and phone

34. **Email is lowercased** for lookup and storage. `requestByEmail` returns `found:false` for unknown, shadow, and bot accounts; it never reveals which.
35. **Connection direction:** `user1` is the requester. Only the recipient can accept; either side can remove.
36. **Phone matching is in-org only.** Exact stored value, digits-only, or `+digits`; at least one shared org is required; shadow/bot never match; otherwise `matched:false`. No global directory.
37. **QR is client-side:** a rendering of an org invite link or a user's connection code. No server endpoint and no global lookup.

### Clients and tooling

38. **Web additions:** typed API shim (`anyApi` runtime + type-only generated import), dev storage bootstrap form prefilled from env, `/offline` route, on-demand hover/focus count chip, upload flow, Action composer, task cards, Action Inbox, and the connection chip. PIN overlay and hover count chip were not clicked through in the browser; their code paths share the verified PIN/count backends.
39. **Mobile additions:** simple state navigation (no Expo Router), SecureStore tokens, AsyncStorage cache, local PIN + OS biometric stub, cache reachable without auth, Action composer toggle, and task claim/done parity. The mobile client does not expose org/invite/edit admin or the Action Inbox. Expo web is a local smoke-test target only.
40. **Clients never receive `_id`.** All API boundaries expose `publicId`; `users.me` and `organizations.listMine` were added for the thin clients.
41. **Dev storage is MinIO in Docker + `cloudflared`,** with bucket `teamchat` on ports 9000/9001. s3rver was replaced because Docker/WSL owned those ports. This is demo tooling only; the adapter is standard S3.
42. **S5 v2 is distributed across four generator processes against the dev deployment.** Each scenario uses a fresh 10,000-session fleet; the best ramp reached 8,268 rather than pretending 10,000. The query burst is one round because Convex caches one-shot results. Actions use eight cached real users. T0/T1 are send-return/subscription-callback timestamps on one host clock.
43. **The frozen schema includes forward tables.** `actionInbox` and `actionEvents` are now used by Action mode. `hostApps` and the API/webhook/idempotency tables remain unused because no widget, public API, or webhook delivery was built. The schema was not changed for Action mode.
44. **`probes.ts` and `probes/` are preserved Step 0 artifacts.** They are deployed with the dev build but are not used by any v0 client flow.
45. **Attachment storage authority lives on the message.** `messages.attachments[].storageRef` supplies the file key and storage config for a read. The `attachments` row supplies status, uploader, and message pointer only; tampering with its `fileKey` or `storageConfigId` cannot redirect a signature.
46. **OTP request limits run before code creation.** The per-email 3/10 min and per-IP 20/10 min limits are inside `sendVerificationRequest`; the wrapper `signIn` action applies the 10-attempt verification limit before invoking the library handler. The IP comes from `await ctx.meta.getRequestMetadata()` — the earlier synchronous read returned a Promise and silently disabled the IP limit.
47. **DM storage bills the first shared org with active storage.** A DM with no shared org cannot get an upload ticket. DM attachments are recorded in the message's `attachments` array like tree-group attachments.

### Action mode and Action Inbox

48. **Task creation lives in `messages.send`, not in a second mutation.** `by_message` is an index, not a uniqueness constraint, so duplication is prevented by having one creation code path rather than by a database constraint. This keeps the message insert and task insert in one transaction.
49. **`senderMayClose` is materialised at creation and is `true` for every current app-origin Action message.** `messages.send` already requires an active human account and fixes `origin: "app"`; there is no widget or API send path yet. The stored flag is never re-derived, so later account changes do not alter it.
50. **Claim authority is exact group membership only.** A `member`, `manager`, or `owner` of the task's own group may claim; an ancestor manager may not. Shadow, bot, and provisioned accounts are stopped by the active-account guard. DM participants are exact members of the DM.
51. **Separation of duties counts active eligible closers.** The closer set is the group's managers/owners, managers/owners of every ancestor, both DM participants, and the sender when `senderMayClose`; inactive accounts are filtered out. A claimant may close only when no other active closer exists, and only then is `selfClosed` true.
52. **Forward and reassign share the `forwarded` event shape.** Forward is the current claimant passing the task on; reassign is an eligible closer moving it off the current holder. Both require an active exact-group target, reject the current holder, keep `status: "claimed"`, and write `actorId`, `fromUserId`, and `toUserId`. A self-forward is refused; a done task must be reopened, not reassigned.
53. **Archive and hide are different operations.** `archive` is a terminal workflow state for withdrawn work and writes an `archived` event. `hideClosed` is retention only: it sets `archivedAt` on a closed task, leaves `status: "closed"`, and writes no event. Hidden closed tasks stay in the counts but drop out of the default list.
54. **DM tasks are never in the rollup.** Both DM participants are treated as owners for claim/close/reopen/archive, but DM tasks have no `groupPath`, so `by_status_path` cannot return them. They still appear in My tasks and Tasks I raised.
55. **Rollup reads are bounded.** The rollup issues one `by_status_path` query per live status, takes at most 201 rows per status, and sorts the combined result by creation time. Counts are computed from that bounded read and before hidden-closed rows are filtered, so a hidden task still counts as closed but a status with more than 201 rows saturates. `status: "archived"` is refused as a rollup filter. There is no pagination yet.
56. **Inbox defaults are deliberate.** The rollup starts on "All live"; My tasks defaults to `claimed`; Tasks I raised defaults to `open`. Selecting a specific filter applies it to all three lists.
57. **Audit is read-gated and chronological.** `events` checks access to the task's group (or DM participation), orders by `timestamp` ascending, and expands the typed event fields. Hiding a closed task does not add an event because no workflow state changed.
58. **Client confirmation differs by platform.** Web task cards use `window.confirm`; mobile uses `Alert.alert` on native. React Native Web's `Alert.alert` is a no-op, so the mobile screen also uses `window.confirm` when `Platform.OS === "web"`.
59. **Reconnect hardening is an exposure change, not a new protocol.** The installed Convex client already performs jittered exponential reconnect with a 1 s base and 16 s cap; the web sidebar now shows that state and retry count. No custom reconnect loop was added, and no client auto-opens a conversation on launch.
60. **No group member cap was added.** The PRD does not set one, and the S5 fan-out curve is a deployment/product finding rather than a membership rule. The measured 400/300 recommendation in section 5.1 remains a recommendation, not enforced code.
61. **The archived/unread wording is scoped to the Action Inbox.** `hasUnread` remains the two-document chat check and does not read `actionInbox`; there is no per-task unread state. Archived tasks are excluded from the rollup and remain in the audit trail, which is the workflow surface the requirement describes.

## 7. What was not done / known gaps

- **S5 10,000-session target:** not reached on the dev deployment. Best fresh fleet 8,268/10,000; every shortfall was a connection timeout. Query/action gates passed at the cap. A production-class S256 re-run is required.
- **8,000-viewer single group:** unstable. Two of three attempts shed thousands of sockets during subscription setup; the one valid attempt took 38.2 s p95. This is a deployment/product limit, not a harness clock issue. Groups should be capped well below this.
- **Part 1 IP-limit fix is freshly deployed:** the full 14/14 check was re-run after fixing the synchronous metadata read; any later auth change must re-run it after the 10-minute window resets.
- **Native mobile runtime:** no Android emulator, iOS simulator, or device available. The Android bundle builds (735 modules, 2.1 MB HBC), but the native binary was not launched. The native photo picker path, OS biometric prompt, and native Action claim/done flow were therefore not exercised. Mobile Action parity was verified through Expo web only.
- **Mobile offline test:** verified through the Expo web target with a page reload (100/100). A native process-kill/relaunch was not tested.
- **Web PIN overlay and hover count chip:** code exists and typechecks; the unread dot and backend count were verified, but these two UI affordances were not clicked through.
- **Action Inbox pagination:** the rollup and both queues are bounded at 201 rows per status and have no "load more". This is an MVP bound; a large org will need pagination or a narrower default filter.
- **Action unread is not separate from chat unread.** `hasUnread` remains the two-document chat check; archived tasks are excluded from the Action Inbox rollup, not from message unread. No task-level unread state exists.
- **Widget-only behaviour is absent:** no embedded widget, so `origin: "widget"` forced-Action mode, shadow-account onboarding, and the customer-reply auto-reopen (`reason: "customer_reply"`) are not implemented. The backend supports the typed reason but no widget path calls it.
- **Public API/webhooks/host apps and hierarchy** remain unbuilt; the frozen tables are present but unused.
- **Action burst scope:** 512 concurrent sends from eight users to one group. It measures mutation overhead, not interactive single-send latency; absolute p95 is dominated by per-sender contention.
- **No real email provider.** CR-16 echo is demo-only and the production build refuses it.

## 8. How to reproduce

```powershell
cd C:\workspace\TeamChat\app
npm run typecheck                 # backend
cd web; npx tsc --noEmit          # web
npm run build                     # web production build
cd ..\mobile; npx tsc --noEmit    # mobile
npx expo export --platform web --output-dir dist-action
npx expo export --platform android --output-dir .export-android-action-check

cd ..
node scripts/verify-v0.mjs        # 37 checks; needs dev storage tunnel
node scripts/verify-part1.mjs     # Part 1 functional + OTP limits; consumes the IP window
# wait 10 minutes before the focused proof, or run it first and wait before verify-part1
node scripts/otp-ip-limit.mjs     # focused 20/21 IP proof; fresh window required
node scripts/attachment-read-path.mjs
npx convex env set TEAMCHAT_ORG_STORAGE_CAP_BYTES 1000000
node scripts/cap-check.mjs
npx convex env unset TEAMCHAT_ORG_STORAGE_CAP_BYTES

# S5 v2: one scenario per fresh fleet, then merge the evidence
node scripts/s5-v2-scenario.mjs --scenario=curve4000 --combined=true
node scripts/s5-v2-scenario.mjs --scenario=fanout40
node scripts/s5-v2-scenario.mjs --scenario=sequential --viewers=4000
node scripts/s5-v2-merge.mjs
node scripts/s5-burst.mjs --sessions 2000   # original single-process baseline

# Action workflow + 512-action before/after
node scripts/verify-action-inbox.mjs
node scripts/action-burst.mjs --label=baseline
node scripts/action-burst.mjs --label=action --mode=action
node scripts/action-burst.mjs --label=baseline-rerun
```

`verify-action-inbox.mjs` uses cached sessions in `.storage/action-verify-auth.json`; `action-burst.mjs` uses `.storage/action-burst-auth.json` and creates a fresh org/group per run. The internal `testing.ts` hooks are invoked with `--typecheck disable` because they are internal-only. Run the burst labels in the order shown if you want an adjacent discussion control; the recorded numbers also include the earlier baseline from 15:27.

The `teamchat-minio` Docker container must be running on port 9000 with bucket `teamchat`. The quick-tunnel URL changes on restart; update `.storage/endpoint.txt` and `web/.env.local`, then set it again with `storage.setS3Config` for an existing test org.

## 9. Scope confirmation

Action mode, the Action Inbox/Events behaviour, the embedded widget, the public REST API, outbound webhooks, and the widget shell/frame hardening are built and verified. Still not built: shadow-account onboarding, the Google Drive adapter, hierarchy beyond the one-level org tree, voice notes, and calls. The previously unused frozen Part 3 tables (`apiKeys`, `webhooks`, `webhookSecrets`, `webhookDeliveries`, `idempotencyKeys`, `hostApps`) are now active; `actionInbox` and `actionEvents` remain active.

## 10. Part 5 — Public API, webhooks, and widget hardening

Date: 2026-10-21  
Verification: **37/37 PASS**, `run id mvhl1yga`, `evidence/verify-part5.txt`  
Builds: backend `tsc --noEmit` clean; web `tsc --noEmit` clean; `next build` compiled successfully.

### 10.1 Endpoint table

All `/v1/*` endpoints authenticate with `Authorization: Bearer tc_live_…`. SDK 401 responses cover missing, unknown, expired, and revoked keys; a valid key without the required scope gets 403. All errors are `{ "error": { "code": "…", "message": "…" } }` with no internal ids or stack traces.

| Method | Path | Required scope | Rate limit | Idempotent |
|---|---|---|---|---|
| `POST` | `/v1/messages` | `messages:write` | per-group 60/min **then** per-key 500/min (org may raise above 500) | Yes — `Idempotency-Key` required |
| `GET` | `/v1/tasks` | `tasks:read` | per-key | No (read) |
| `GET` | `/v1/messages/{publicId}` | `messages:read` | per-key | No (read) |
| `POST` | `/v1/users/provision` | `users:provision` | per-key | Yes — `Idempotency-Key` required |
| `POST` | `/v1/groups` | `groups:manage` | per-key | Yes — `Idempotency-Key` required |
| `GET` | `/v1/groups` | `groups:manage` | per-key | No (read) |
| `GET` | `/v1/users` | `users:provision` | per-key | No (read) |

The per-key limit is enforced by the transactional `@convex-dev/rate-limiter` component keyed by API-key `publicId`; no counter document exists. The per-group cap uses the same component keyed by group `publicId` and is checked before the per-key limit, so a group flood reports `group_rate_limited`, not a generic key limit. `organizations.apiRateLimitPerMinute` is optional; the floor is 500 (499 is rejected, 750 is stored and applied).

### 10.2 Test results (one line each)

All results are in `evidence/verify-part5.txt`.

- API key shape, SHA-256-only storage, metadata-only listing, 90-day expiry: **PASS**.
- Bearer auth 401/403 behaviour; revoked/expired keys indistinguishable from unknown: **PASS**.
- Rotation revokes the old key immediately and returns a new 90-day key: **PASS**.
- `lastUsedAt` bounded to at most one write per key per 60 s: **PASS**.
- Per-org limit floor: 499 rejected, 750 stored: **PASS**.
- `Idempotency-Key` required; same key + same bytes replays the original body; same key + different body is 409: **PASS**.
- `POST /v1/messages` writes `origin:"api"` as the one-per-org bot service user; action mode creates exactly one task: **PASS**.
- `GET /v1/messages/{publicId}` and `GET /v1/tasks` resolve by public id/external reference with no `_id` in any response (615 responses scanned): **PASS**.
- Provisioning creates a provisioned user plus `orgMembers` row, is idempotent by org-scoped `externalRef`, and resolves through `GET /v1/users`: **PASS**.
- Group creation uses the org root as parent, returns the public path, indexes `externalRef`, adds `memberEmails`, and rejects nesting: **PASS**.
- Per-group send cap trips at 60 sends with `group_rate_limited` before the per-key cap: **PASS**.
- Per-key limit allows 500/min and then returns 429 `rate_limited`: **PASS**.
- Webhook registration rejects HTTP, loopback, private, link-local, and metadata URLs: **PASS**.
- Webhook secret is shown once, stored encrypted in `webhookSecrets`, and absent from every client-readable query: **PASS**.
- `message.created` and `task.claimed` delivery rows are inserted in the same mutation, with a content-free snapshot and `claimedBy` identity: **PASS**.
- Delivery re-resolves DNS before every attempt and refuses a private address before opening a socket: **PASS**.
- Retry delays are 10 s / 60 s / 300 s, the original snapshot is reused, and the fourth failure dead-letters: **PASS**.
- A failing webhook does not roll back or delay the task transition: **PASS**.
- Payload is HMAC-SHA256 over the serialized body; 3xx is a failure and redirects are never followed: **PASS**.
- No rate-limiter counter document exists: **PASS**.
- `/widget/shell` resolves the host, sets `Content-Security-Policy: frame-ancestors <allowedOrigins>`, and omits `X-Frame-Options`: **PASS**. Convex evidence in `verify-part5.txt`; live demo probe in `evidence/widget-shell-demo.txt` (200, `frame-ancestors http://localhost:4310`, no XFO).
- Unknown and inactive hosts return the same 404 with no allowlist leak: **PASS**.
- Demo host points at `/widget/shell?host=…`; the old direct `index.html` URL is no longer used by the demo: **PASS** (`evidence/widget-shell-demo.txt`).
- Exchange `origin` is advisory metadata; CSP is enforcement; non-shadow resolution uses the distinct `identity_not_shadow` code, not `replayed`: **PASS**.

### 10.3 `by_org_external` contradiction

Part 5 §3f says both `?externalRef=` lookups resolve on `groups` and `orgMembers` through `by_org_external`. Appendix A (line 1793) says `messages.by_org_external` resolves no specified Phase 1 endpoint and should be pruned.

Resolved in favour of Part 5: `GET /v1/tasks?externalRef=` must find the message carrying the ERP reference before it can return its task, so `messages.by_org_external` **is** load-bearing. The implementation uses `by_org_external` when `externalSource` is supplied and the additive `by_org_ref` (`orgId`, `externalRef`) when it is omitted, matching the PRD's example query. `groups` and `orgMembers` use the same pair. No index is pruned; the cost note in Appendix A should be read as superseded for `messages`.

### 10.4 PRD ambiguities and decisions

| Ambiguity | Decision |
|---|---|
| Per-group cap value | 60 messages/min per group. The PRD fixes the mechanism and the 500/min key floor but not this number. Exposed as `API_GROUP_SEND_MAX_PER_MINUTE`. |
| Scope for read-only lookups | `GET /v1/groups` → `groups:manage`; `GET /v1/users` → `users:provision`. The PRD names scopes but does not map these two GETs. |
| Idempotency TTL | 24 hours, swept hourly with the other expired rows. |
| Retry count and dead-letter point | Initial attempt + 3 retries (4 attempts total); dead after the fourth failure. Delays 10 s, 60 s, 300 s. |
| Delivered-row retention | 30 days, swept daily. |
| Rotation semantics | Old key gets `rotatedAt` and `revokedAt` immediately; the replacement gets a fresh 90-day expiry. |
| `lastUsedAt` write bound | At most once per key per 60 s, inside the authentication mutation. |
| Idempotency coverage | Required on the three write endpoints; reads are not idempotent-keyed. TTL starts at first successful write. |
| Default message mode | `discussion` when `mode` is omitted; only `action` and `discussion` accepted. |
| `externalSource` omission | `externalRef` and `externalSource` must be supplied together at write time. On lookup, omitting `externalSource` falls back to the org+ref index. |
| Group creator membership | API group creation adds no creator membership. Only `memberEmails` add memberships, matching the ERP-driven provisioning model. |
| Service-user task flags | Service-user Action messages set `senderMayClose:false` and `flagType:"task"`; the bot cannot sign in, claim, or DM (existing auth/DM guards). |
| Widget unknown vs inactive | One 404 body and status for both, so the route cannot probe host existence or read a dormant allowlist. |
| Widget origin trust | The exchange `origin` is advisory input checked against the allowlist; the browser-enforced control is `frame-ancestors` on the shell response. |
| Non-shadow identity error | New `identity_not_shadow` code; `replayed` is reserved for a reused `jti`. |

### 10.5 Scope confirmation

Built and verified in Part 5: REST API, API-key lifecycle and admin surface, rate limits, idempotency, outbound webhooks with retries/dead-letter/sweep, and the hardened widget shell. Still **not started**: hierarchy beyond the one-level org tree, voice notes, calls, and the Google Drive adapter. The existing S3-compatible storage adapter remains the only storage backend. No bytes flow through TeamChat for API messages or webhook deliveries; API messages are text-only.

### 10.6 Reproduce

```powershell
cd C:\workspace\TeamChat\app
npm run typecheck
npx convex dev --once
cd web; npx tsc --noEmit; npm run build
cd ..
node scripts/verify-part5.mjs
```

`verify-part5.mjs` needs a deployed dev backend and `.env.local`. It creates its own org, keys, groups, users, webhook, and widget host; it uses admin-only `convex/testing.ts` hooks for expiry, raw key/secret inspection, deterministic delivery retries, and private-URL delivery checks. No product code imports those hooks.
