# TeamChat: Master Product & Technical Specification

**Version:** 1.3 (rebased on v1.1 + approved architecture refinements)
**Date:** October 19, 2026
**Status: FINAL, with open items: region, S1–S6.** Every change to locked v1.1 behavior carries its
own identifier in the Change Log. CR-1 to CR-14 and O1 to O4 are recorded, except CR-12 and CR-13,
which are deferred rather than adopted. The deployment region is the only open *input*; S1–S6 are the
tests that gate the first deploy — see Appendix A.

> **Product Vision:** WhatsApp is messaging for casual chat. TeamChat is messaging for work — structured, accountable, workflow-driven communication for organisations, franchises, and embedded business applications.

---

## Marker Convention

This document annotates every section that is not free to drift:

```
> **LOCKED** — <why it cannot change without a version bump>
> **OPEN** — <what has to be decided, and by whom>
> **CHANGED FROM v1.1** — <what changed and why> · see Change Log §A for its CR id and sign-off
```

**Decision identifiers.** Change requests are referenced as `CR-n`. Flow diagrams use `Flow X`
names. The two namespaces are deliberately separate — an earlier draft used `D4`/`D7` for decisions
while `Flow D2`/`Flow D3` existed for flows, which was ambiguous.

---

## Change Log — v1.3

v1.3 is **rebased on v1.1**. v1.2 was treated as an unapproved draft and superseded. The Flutter
frontend stack, the removal of the 30-day session timeout, the removal of the 90-day key rotation
rule, the cut webhook event catalog, and the collapsed provisioning payloads are all reverted —
none of them were approved changes to v1.1.

**CR-1 to CR-11 recorded 19 October 2026; CR-14 recorded the same day.** **CR-12 and CR-13 are
deferred and unsigned** — they stay in section A because they change behavior v1.1 locked, and
deferring is not adopting.

### A. Alters locked v1.1 behavior

Every row changes behavior v1.1 locked, so every row carries its own identifier and can be approved,
rejected, or reverted on its own. The failure this document exists to prevent is a change to locked
behavior that nobody can point at. CR-1 to CR-11 and CR-14 are signed off; **CR-12 and CR-13 are
deferred** — logged because they change locked behavior, retained because they may be needed later.

| ID | Change | Reason | Sign-off |
|----|--------|--------|----------|
| CR-1 | BYOS gains a **storage scope**; org is primary. Phase 1 is S3-compatible only; Google Drive deferred. | Per-user storage puts the organisation's evidence in an employee's personal cloud. When that employee leaves, the org's chat media leaves with them. | ✔ Darwin, 19 Oct 2026 |
| CR-2 | Direct messages exist **outside** the tree, as a named exception. | Connections (email, invite links, QR) need a 1:1 channel. Without DMs, Connections states capability but delivers none. | ✔ Darwin, 19 Oct 2026 |
| CR-3 | Action task lifecycle gains **`done`**, and the full transition table is specified. `done → claimed` (reopen) did not previously exist. | v1.1 promises "Mark as Done → sender reviews → close", but the state machine had no state between `claimed` and `closed`, and no send-back path for a review that rejects the work. | ✔ Darwin, 19 Oct 2026 |
| CR-4 | Flow C narrows to **Action Inbox rollup + single-child drill-down**. No merged message feed over a subtree. | A merged feed re-runs for every viewer on every descendant message — it directly amplifies the cost model problem. | ✔ Darwin, 19 Oct 2026 |
| CR-5 | **Closing authority** redefined: managers/owners at the task's group *or any ancestor group* may always close; the sender may close only when `senderMayClose` is true. Separation of duties applies. | v1.1 said "the original sender/manager closes the flag", which has no meaning when the sender is a widget customer. Nothing prevented an assignee-manager from closing their own work. | ✔ Darwin, 19 Oct 2026 |
| CR-6 | **Rate limiting is Phase 1 mandatory** (v1.1 described it as a Phase 2 default). | The OTP endpoint, the widget exchange, and the open API are public and cost real money when abused. | ✔ Darwin, 19 Oct 2026 (= O3) |
| CR-7 | **"Infinite scalability" claim removed** from Part 1 and Flow A. | One message is one write, but fan-out is N subscriber query re-runs. The old phrasing overstated the model and hid the cost question. | ✔ Darwin, 19 Oct 2026 |
| CR-8 | **Host App Guest Friction rewritten:** widget uploads are **blocked by default**; an org may opt in. | The v1.1 rule ("restricted until they link BYOS") no longer parses under org-scope storage. Widget customers writing into an org's bucket is a cost and abuse vector. | ✔ Darwin, 19 Oct 2026 (= O2) |
| CR-9 | **Phone-only restriction stated:** phone-only accounts can use the embedded widget but **cannot sign in to the standalone app in Phase 1**. Global phone lookup is deferred. | SMS OTP is deferred on cost grounds; without it a phone number cannot be verified. A host assertion would still leave an enumeration surface. | ✔ Darwin, 19 Oct 2026 (= O1) |
| CR-10 | **A manager of an ancestor group may close but may not claim** a task in a descendant group. | Ancestry confers oversight, not ownership of the work. Letting a regional manager claim a specific outlet's task also breaks the per-group "my tasks" list as a reliable queue. | ✔ Darwin, 19 Oct 2026 |
| CR-11 | **A customer reply on a `done` widget ticket auto-reopens it** to `claimed` with the same claimant. | A customer saying the problem is not fixed is stronger evidence than an agent's "done" click. Without this, a `done` ticket nobody reviews silently rots. | ✔ Darwin, 19 Oct 2026 |
| CR-12 | **Chat list becomes non-reactive.** Chat-list ordering refreshes on focus, on pull-to-refresh, and by push for background groups, instead of holding a live subscription per group. Two variants: **A** fully non-reactive; **B** live for the 5 most recent groups, everything else refreshed on focus. | A reactive list re-runs whenever any group the user belongs to changes — 30–60 subscriptions per client for a regional manager. **This trades away live updating, which v1.1 promises.** It needs one rule to work: re-evaluate the "most recent" set only on focus, refresh, or push, or the subscription set reshuffles continuously and the churn costs more than the subscriptions did. | ✔ Darwin, 19 Oct 2026 — **deferred by explicit confirmation. The chat list stays reactive.** Lever 1 alone fits the budget at fewer than 40 orgs (Appendix A). Revive if the deployment is non-US and sustained per-org cost approaches the ceiling. |
| CR-13 | **Announcement-style groups above a size threshold.** Posting restricted to managers and opted-in posters, thread replies allowed, non-live reads for non-posters. Proposed threshold ~300 members, conversion back below ~250. | Cost per message scales with concurrent viewers, so one large group can dominate an org's cost regardless of org size. The 300/250 thresholds are the reviewer's figures, not data. | ✔ Darwin, 19 Oct 2026 — **deferred.** Orgs above ~1,000 staff route to the Enterprise tier instead (CR-14), so the standard tier never hosts a group large enough to need the mode. Revive if a standard-tier org crosses the threshold. |
| CR-14 | **The free-forever commitment is bounded at about 1,000 staff per org.** Orgs up to that size run on the standard free design; larger organisations are a separate commercial conversation, and v1.1's self-hosted Enterprise option is their home. | Cost is superlinear in group size, so free-forever fails on the tail, not the average. Without a bound, the largest org sets the cost of the smallest. The bound is a tier rather than a wall, because 1,000+ staff organisations are the commercial opportunity. | ✔ Darwin, 19 Oct 2026 — **approved by explicit confirmation.** |

**Provenance of the sign-offs.** *Confirmed by Darwin Tjoe in the review conversation, 19 Oct 2026 —
"yes to all twelve."* The twelve are CR-1 to CR-5, CR-7, CR-10, CR-11, and O1 to O4. CR-6, CR-8, and
CR-9 restate O3, O2, and O1 respectively.

**Second confirmation round, same day.** Four inputs were put to Darwin directly and answered
explicitly: the Phase 1 org count (**fewer than 40**), **CR-14** (approved — free-forever bounded at
about 1,000 staff per org), **CR-12** (deferred — the chat list stays reactive), and the
**$1,000/month** infra ceiling read as a total, seats and hosting included. CR-13 is deferred as a
consequence of CR-14. The sign-off cells for CR-12, CR-13, and CR-14 cite that round rather than the
first.

### B. Additive or clarifying

| Change | Note |
|--------|------|
| `users.accountState` (`shadow` \| `provisioned` \| `active` \| `bot`) | Replaces the boolean `isShadowAccount` / `isBot` pair. Makes the distinction between a host-linked shadow user and an API-provisioned staff member explicit, which the provisioning flow previously conflated. |
| Full Action lifecycle transition table | Claim, forward, done, reopen, close, archive — with actor eligibility for each. |
| `actionEvents` typed per action | Each event carries its own fields (`forwarded` carries from/to; `closed` carries `selfClosed`). No `v.any()` catch-all. |
| `usedTokenIds` | `jti` replay protection for widget tokens, with a sweep. `aud` is now validated against the host app's expected audience. |
| ERP external references on `groups` and `orgMembers` | `externalRef` + `externalSource` + a scoped index, so ERP lookups resolve. `organizations` gains a `publicId` so the path's org segment is defined. |
| `idempotencyKeys` stores the original response | Status + body, replacing the opaque `resultRef`. |
| Upload `pending/` prefix with expiry | Unconfirmed uploads are written under an expiring prefix and never become reachable attachments. |
| `GET /v1/messages/{publicId}` specified | Previously referenced by the webhook contract but never defined. |
| Widget ticket threading | First message opens the ticket; later messages attach as replies. "Same conversation" is now defined precisely. |
| Flow D2 — widget trust model | Host-signed tokens verified against per-host **public keys**; `kid` lookup, `jti` replay protection, short expiry, `aud` validation. |
| Action audit trail | Append-only `actionEvents`; the workflow state change and its event are written in the same mutation. |
| Per-group unread | `memberships.lastReadAt`, server-derived from the last message the client has seen; bounded count query (`take(100)`, "99+"). |
| Chat-list ordering | Debounced `groupActivity.lastMessageAt` with a trailing flush so a second message inside the window is never lost. |
| `Idempotency-Key` on all write endpoints | Stored with a request-body hash; a reused key with different input returns `409`. |
| Webhook signing secrets | Shown once at creation; stored encrypted in a table no client-facing query reads. |
| Webhook delivery | Payload snapshot persisted before the first attempt; 10s/60s/300s retries; dead-letter state; retention sweep. |
| Webhook URL validation | `https` only, private/link-local ranges rejected at registration **and at delivery**. |
| API key rotation | Enforced by a stored `expiresAt` (90 days), not by convention. |
| `publicId` across the API | Internal Convex IDs never cross the API boundary. |
| Upload hardening | Server-generated `fileKey` under an org/group prefix; signed PUT scoped to that key with size and content-type limits; attachment recorded only after a confirm step. |
| Storage read authorization | Reads are authorized server-side against group access before a short-lived signed GET is issued. |
| Three design lints | See Part 1 §1 (lint 3) and Part 5 §7 (lints 1 and 2). |
| Attachment resolution | Every attachment carries its own typed `storageRef`; there is no resolution chain at read time. |

### C. Content restored from v1.1

A mechanical pass against v1.1 found material that this draft had dropped. Restored:

| Restored | v1.1 location |
|----------|---------------|
| Self-hosted deployment option for Enterprise (Phase 2) | Part 2, Infrastructure |
| Dropbox and Azure as Phase 2 BYOS providers | Part 2, External Integrations |
| "Offline read (last 100 cached messages)" and "edit/delete" in General Chat | Part 1 §3, Key Features |
| "Configurable per org" on the API rate limit | Part 5 §2 |

### D. Open items resolved in review — SIGNED OFF

These were **recommended by review and confirmed by Darwin on 19 Oct 2026**. They are recorded as
Darwin's decisions, not as the reviewer's.

| ID | Decision | Sign-off |
|----|----------|----------|
| O1 | **Global phone lookup is deferred in Phase 1.** A host assertion still leaves an enumeration surface, and email, invite links, and QR already cover Connections. In-org phone matching for provisioned users needs no discovery and remains. | ✔ Darwin, 19 Oct 2026 |
| O2 | **Widget uploads blocked by default.** Org-level opt-in with size, type, and rate limits. | ✔ Darwin, 19 Oct 2026 |
| O3 | **Rate limiting mandatory in Phase 1.** | ✔ Darwin, 19 Oct 2026 |
| O4 | **Separation of duties is a rule, not a setting.** A different eligible closer is required whenever one exists. When the assignee is the only eligible closer (typical for single-person MSMEs), self-close is permitted and recorded as `selfClosed` in the audit event. No configuration. | ✔ Darwin, 19 Oct 2026 |

### E. Open items carried into v1.3

| ID | Item | Notes |
|----|------|-------|
| O5 | Auth implementation | Convex Auth (beta) for email OTP behind a thin swappable wrapper, version-pinned. Widget exchange via the custom-credentials provider. Phone/SMS skipped in Phase 1. Deferred to implementation. |
| O6 | Google Drive support | Gated on merchant validation: can a typical low-tech merchant configure an org bucket with a guided setup? If not, the alternatives are a TeamChat-hosted storage tier (requires the cost model) or Drive-with-limits in Phase 2. |
| O7 | Cost model | Estimate cost per org per month before launch, under the locked free-forever strategy. Inputs, in rough order of sensitivity: (1) messages **sent** per user per day, plus machine-generated API volume; (2) group sizes across the org → region → outlet tree; (3) active users per org — DAU is the Convex driver, MAU is only the identity driver; (4) **peak concurrent viewers** of a group, because re-run cost follows clients subscribed right now, not membership, once the D6 lever applies; (5) groups per user, because the unread sweep is the other subscription surface. **See Appendix A** for the pricing basis, the input values, the lever results, and the budget. The infra ceiling is **$1,000/month**, the Phase 1 org count is **fewer than 40**, and the deployment region is **not yet chosen** — it carries a 1.3× multiplier, **Sydney is now live** and is the closest of the four regions to Jakarta, and it is the only input left that can change the design. See Appendix A and S6. |
| O8 | WorkOS AuthKit fallback | **RESOLVED — verified 19 Oct 2026** against WorkOS's own pricing page: AuthKit is free for the first **1,000,000 MAU**, then $2,500 per additional 1M MAU per month. WorkOS defines an MAU as a user who performs any action — sign up, sign in, or profile update — within a calendar month. Two limits on that figure. First, "widget traffic is free" holds only if the widget exchange creates no WorkOS user; if it did, each guest sign-up would count as an active user for that month. Second, **WorkOS is not in the Phase 1 path at all** — per O5, Phase 1 uses Convex Auth with a custom-credentials provider, and WorkOS is only the fallback. The defensible claim is that identity costs almost nothing at any plausible scale, not that a particular traffic type is free. Whether the binding cost is Convex is a question for O7 and is not asserted here. |
| O9 | Unread counter — reactive or on-demand? | The D6 lever assumes a group the user has not opened costs a "lightweight unread counter". That holds only if the counter reads two documents — `groupActivity.lastMessageAt` against `memberships.lastReadAt`. If it instead subscribes to a bounded `take(100)` scan of the group's messages, which is how the count is described in Flow A3 today, then every new message re-runs that scan for every member. That is **the same fan-out shape as subscribing to the feed, reading up to 100 documents per member instead of one**, and the lever buys nothing. Decide before S2: derive "has unread" from the two documents and run the bounded count on demand, only when a number is actually rendered. **The O7 model puts the reactive scan at roughly 4× the two-document version** (Appendix A), so this is the second-cheapest lever and is worth taking. |

### F. Added after the 19 Oct sign-off — cost-model levers

These arrived from the O7 cost model, after v1.3 was signed. Levers 1, 2, and 5 are **additive
hardening** and do not alter a locked v1.1 principle. **Levers 3 and 4 do** — lever 3 trades away the
real-time behavior v1.1 promises, and lever 4 introduces a new group mode — so they are **logged as
CR-12 and CR-13 in section A and deferred there**. Costed, not adopted. They appear here so the record
shows *when* each arrived, which is the whole point of this change log.

| Lever | Change | Why |
|---|---|---|
| Per-group send cap | The API enforces a maximum send rate **per target group**, on top of the 500/min per key. Enforced with the existing transactional rate-limiter component, keyed by group — **never** a counter document, which would violate the locked no-hot-per-group-document constraint. | The per-key limit alone permits 500 × 60 × 24 = **720,000 messages/day into a single group** from one key. |
| Digest mode for API alerts | An API caller may ask that repeated alerts sharing an `externalRef` collapse into one message carrying a count, instead of one message per event. | Emitting one message per invoice event is how the 720k figure becomes reachable in ordinary operation, rather than through abuse. |
| Live page window | The live message window is bounded to roughly 10–20 messages; older history is served by a non-reactive paginated query. | The live page is re-read on every message for every subscriber. It is the largest single term in the model. v1.1's "offline read (last 100 cached messages)" is unaffected — that is a client-side cache, not a live query. |
| Non-reactive chat list — **CR-12, DEFERRED** | Chat-list ordering refreshes on focus, on pull-to-refresh, and by push for background groups, rather than holding a live subscription per group. | A reactive list re-runs whenever any group the user belongs to changes — for a regional manager, 30–60 subscriptions per client. **This loses live updating, which v1.1 promises**, which is why it is a change request and not an adopted lever. Deferred: lever 1 alone fits the budget at fewer than 40 orgs. |
| Announcement-style large groups — **CR-13, DEFERRED** | Groups above a member threshold behave as announcement-style: posting restricted to managers and opted-in posters, thread replies allowed, non-live reads for non-posters. Proposed threshold ~300 members, conversion back below ~250. | Cost per message scales with concurrent viewers, so one large group can dominate an org's cost regardless of org size. Deferred: 1,000+ staff orgs route to Enterprise instead (CR-14), so the standard tier never hosts a group large enough to need the mode. |
| S1 | Smoke test — union-variant indexing | Does an index on a field present in only **one union variant** pass schema validation? Affects **four** variant-only indexed fields across two tables: `groups` (`path`, `dmKey`, `orgId`, `externalRef`) and `byosCredentials` (`orgId`, `userId`). `byosCredentials` is the cheapest probe — two variants, one indexed field each — and it has a trivial local fallback if it fails, since only org scope is built in Phase 1. The `groups` fallback is worse: flatten to optional fields and validate at the function boundary. Run this first. |
| S2 | Smoke test — message insert under load | Confirm a message insert in a busy test group stays conflict-free with no per-group counter write. |
| S3 | Smoke test — widget token exchange | Confirm the exchange works through Convex Auth's custom-credentials provider (`ConvexCredentials`). |
| S4 | Session durations | The 30-day inactivity rule depends on Convex Auth's total/inactivity session settings. Confirm against current docs before treating the rule as implemented. |
| S5 | Smoke test — concurrent sessions and concurrent queries | Professional runs the **S256** class: **10,000 concurrent sessions**, **256 concurrent queries**, **512 concurrent actions**, per deployment. Forty orgs × 400 users is 16,000 people — 2,400 sessions at 15% steady concurrency, but **9,600 at a 60% shift-start burst, which is 96% of the session ceiling** before second devices and widget guests are counted. The **256-query** cap binds sooner than the session cap for this design, because one message re-runs the feed for every live viewer. Confirm both under a burst. Escaping S256 means Business or Enterprise at a **$2,500/month minimum plus a per-deployment class fee** — 2.5× the entire Phase 1 budget. Cheapest mitigations: connect the widget only while it is open, and drop idle sessions. See Appendix A. |
| S6 | Latency test — region | **Asia Pacific (Sydney) is live**, at the same 30% surcharge as EU West, and it is the closest of the four regions to Jakarta. The choice is therefore a real trade — US East buys about 50 orgs of headroom, Sydney about 38 — not a wash. Deploy a trivial app in each candidate region, measure **median and p95 mutation round-trip from Jakarta**, and decide on the measurement. **A deployment's region cannot be changed after creation**; moving means export and import into a new project. See Appendix A. |

---

## Table of Contents

1. [Part 1: Product Requirements Document](#part-1-product-requirements-document)
2. [Part 2: Tech Stack](#part-2-tech-stack)
3. [Part 3: Database Design](#part-3-database-design)
4. [Part 4: Architecture Flow](#part-4-architecture-flow)
5. [Part 5: Open Integration Layer](#part-5-open-integration-layer)
6. [Appendix A: Cost Model (O7)](#appendix-a-cost-model-o7)

---

## Part 1: Product Requirements Document

### 1. Core Architecture Principles

**Pub/Sub (Topic-Based / Hashtag) Messaging**
Groups are not physical folders copying messages to individual inboxes. Groups act as "Topics".
Messages are published once to the topic, and subscribers (members) filter and view them.

**One message = one database write.** Fan-out is not free: N subscribers means N query re-runs, so
read cost scales with membership, not with message size. TeamChat does not claim infinite
scalability; the cost model (O7) is the instrument for that question.

> **LOCKED** — the single-write pub/sub model is the scalability foundation.

**Storage Abstraction Layer (SAL) / BYOS**
Bring Your Own Storage. Metadata (text, flags, routing) lives on TeamChat servers. Heavy media
routes via SAL directly to cloud storage that TeamChat never proxies.

BYOS has a **storage scope**:

- **org** (primary, built in Phase 1) — the organisation owns the bucket. Evidence stays with the
  business when staff leave.
- **user** (defined in the model, not built) — deferred to Phase 2.

Phase 1 supports **S3-compatible providers only**. Google Drive is deferred: Drive offers no
pre-signed read URL, so serving a file to a recipient would require either proxying the bytes
(breaking "servers never touch the file") or sharing to the recipient's Google identity, which
TeamChat cannot verify. Dropbox and Azure are Phase 2 candidates on the same footing.

The term **`byosProvider: none`** is retained and redefined as the derived state *no storage
configured*. It is no longer a stored field.

> **LOCKED** — metadata/bytes separation. TeamChat never proxies media bytes.
> **CHANGED FROM v1.1** — storage scope added; Phase 1 is S3-compatible only. See Change Log §A (CR-1).
> **OPEN** (O6) — Drive support is gated on merchant validation.

**Tree Hierarchy Only**
Strict top-down parent-child relationships. Parent groups can see and interact with child groups.
Child groups cannot see parent groups. Sibling groups are isolated.

**Named exception — direct messages (CR-2).** DM channels exist outside the tree. They carry no
path, are never returned by any tree, rollup, or org-admin query, and are governed by an org-level
`allowDirectMessages` policy.

Accountability caveat: managers cannot see work assigned inside a DM. That cuts against the
accountability positioning, which is why DMs are an **org-level policy a franchisor can switch
off**, forcing work into groups where it is visible.

> **LOCKED** — tree-only for *groups*.
> **CHANGED FROM v1.1** — DM exception added. See Change Log §A (CR-2).

**Constraint — no hot per-group document.**
No document scoped to a group may be written on every message. Per-message writes to a shared
document create write conflicts under concurrent senders and re-run every subscriber of that
document. Bounded-rate writes (for example, at most once every few seconds) are permitted.

> **LOCKED** — architectural constraint.

**Open Integration by Design**
TeamChat exposes a documented REST/Webhook API for bidirectional integration with external ERP and
business systems. Identity provisioning, group management, and message triggers must be automatable
via API. No closed-system architectural decision shall block this capability.

> **LOCKED** — stated as a locked principle in v1.1 and unchanged.

---

### 2. Message Modes — The Core Differentiator

**Message origin is server-set, never client-supplied:**

| origin | Set by | Effect |
|--------|--------|--------|
| `app` | First-party clients (mobile / web) | Member may choose Action or Discussion. |
| `widget` | Embedded widget token exchange | **Forced to Action mode.** Prevents multi-agent collisions on host-app tickets. |
| `api` | Open API (API key) | Message is **text-only in Phase 1** and is sent as the organisation's service user. Mode is supplied by the caller. |

#### Mode A: Action / Task (Single-Claim)

**Use Case:** Customer support tickets, direct assignments, urgent alerts.

- **Telephone Extension Rule:** When an Action message is sent, all members see it. The first member
  to click `[ ⚡ Claim Task ]` locks it to themselves — like the first person to pick up a ringing
  office extension. All others' claim buttons deactivate instantly.
- **Single Claim:** Once claimed, the task is locked. No one else can claim it unless it is formally
  Forwarded.
- **Confirmation UX:** Claiming requires a one-tap "Are you sure?" confirmation to prevent
  misclicks, without breaking the audit trail.
- **Widget Rule:** Any message originating from the Embedded Widget (`origin == "widget"`) is
  automatically and strictly locked into Action Mode.
- **Integrity Rule:** Once an Action message is claimed, text editing is disabled. Action messages
  cannot be hard-deleted; they can only be archived or closed.

**Who may claim (CR-10).** Claiming requires **membership of the task's group**. Specifically:

- A `member`, `manager`, or `owner` of that group may claim.
- A manager of an *ancestor* group may close but **may not claim** unless they are also a member of
  the task's own group. Ancestry confers oversight, not ownership of the work — and it keeps the
  per-group "my tasks" list a trustworthy queue rather than one a regional manager can drain.
- Users in `accountState: "shadow"` (widget customers) may **never** claim.
- Bots (`accountState: "bot"`) may never claim.
- Users in `accountState: "provisioned"` may not claim until activated.

**Closing authority (CR-5):**

- A group `manager` or `owner` — at the task's group **or any ancestor group** — may close.
- The message sender may also close **only** when `senderMayClose` is true, which is set at task
  creation and is true only for `origin == "app"` with a human, active sender.
- Widget ticket senders are customers, so they never hold closing authority. API-originated tasks
  likewise close on the agent side.
- **In a direct message** there is no manager and no ancestor, so the tree rules cannot be satisfied
  at all. For task purposes **both DM participants are treated as `owner` of that DM**: either may
  close, reopen, or archive. Without this, no DM task could ever leave `claimed`.

`senderMayClose` is **materialized at creation** rather than derived at read time, so a later account
change cannot retroactively alter who was entitled to close a finished task.

**Separation of duties (O4).** A different eligible closer is required whenever one exists. If the
only eligible closer is the assignee themselves — the common case for a single-person MSME —
self-close is permitted and is recorded as `selfClosed` in the audit event. This is a rule, not a
setting.

> **CHANGED FROM v1.1** — closing authority and separation of duties. See Change Log §A (CR-5).

**Forwarding and reassignment.** Forwarding normally means the holder passing the ball. It is also
the recovery path when the holder cannot continue:

- **Forward** — the current claimant passes the task on. The target must be an `active` member of the
  task's own group and must not be the current holder.
- **Reassign** — an eligible closer moves a `claimed` task off an assignee who has left, been
  deprovisioned, or is otherwise unavailable. Without this, a departure would strand every task that
  person held, because only the holder could forward.
- Both write the same `forwarded` event carrying `actorId`, `fromUserId`, and `toUserId`. For a
  self-forward `actorId == fromUserId`; for a reassignment they differ — which is how the audit trail
  tells "I passed it on" apart from "it was taken off me".
- Forwarding does not change `status`; the task stays `claimed`. Reassignment does not apply to
  `done` tasks — reopen those instead.

**Action lifecycle — transition table**

| From | Action | Who may perform it | To | Audit event |
|------|--------|--------------------|----|-------------|
| `open` | claim | Member of the task's group (CR-10) | `claimed` | `claimed` |
| `open` | close | Eligible closer | `closed` | `closed` |
| `open` | archive | Manager/owner at the group or an ancestor; either DM participant in a DM | `archived` | `archived` |
| `claimed` | forward | The current claimant, or an eligible closer reassigning an abandoned task | `claimed` (holder replaced) | `forwarded` (actor, from → to) |
| `claimed` | done | The current claimant | `done` | `done` |
| `claimed` | close | Eligible closer | `closed` | `closed` |
| `claimed` | archive | Manager/owner at the group or an ancestor; either DM participant in a DM | `archived` | `archived` |
| `done` | reopen | Eligible closer, or the sender when `senderMayClose` | `claimed` (same claimant) | `reopened` |
| `done` | close | Eligible closer | `closed` | `closed` |
| `done` | archive | Manager/owner at the group or an ancestor; either DM participant in a DM | `archived` | `archived` |
| `closed` | — | *Terminal for the workflow. A new ticket may open instead.* | — | — |
| `archived` | — | *Terminal. Cannot be reopened.* | — | — |

**Closing is terminal; hiding is not a transition.** There is deliberately **no `closed → archived`
transition.** Hiding a closed task from the default board is a *retention* operation: it sets
`actionInbox.archivedAt` and leaves `status: "closed"` untouched, so completion counts stay correct.
`status: "archived"` is reserved for tasks that were **withdrawn** — duplicates, spam, cancelled
work — and were never completed. A task hidden while closed is still counted as closed.

**Customer reply on a `done` ticket (CR-11).** If a widget customer replies in the thread while the
ticket is `done`, the task returns to `claimed` with the same claimant, and a `reopened` event is
recorded with reason `customer_reply`. A customer saying the problem is not fixed is stronger
evidence than an agent's "done" click — and without this rule a `done` ticket nobody reviews simply
rots.

**Customer reply on a `closed` ticket.** A `closed` ticket is terminal. A reply opens a **new
ticket** in the same conversation — see Flow D3.

**Definition of `archived`.** A terminal, read-only state for tasks that were withdrawn rather than
completed. Archived tasks are excluded from the Action Inbox rollup and from unread counts by
default, remain in the audit trail, and cannot be reopened. The distinction that matters:
**`closed` means the work was done; `archived` means the task was withdrawn.** Only `closed` counts
as completion.

#### Mode B: Open Discussion / Broadcast (Watercooler)

**Use Case:** Brainstorming, asking for opinions, general announcements.

- No claiming mechanism. Message stays in the normal chat stream.
- Encourages Threading (slide-out panel) to keep the main chat clean.
- Everyone can participate. No ownership assigned.

---

### 3. Key Features

| Feature | Description |
|---|---|
| **Action Inbox** | Dedicated task board. Tracks the ball: Sender → Claimed By → Forwarded To. Includes an append-only, immutable audit history and the full lifecycle above. |
| **Embeddable Chat SDK** | Shadow account identity mapping via host app identity. Zero friction. Limited white-labelling (colours/logo). |
| **Connections** | Email, Invite Links, QR Code. Acoustic handshake deferred to Phase 3. **Global phone lookup is deferred in Phase 1** — see Change Log §D. In-org phone matching for provisioned users remains available without discovery. |
| **Authentication** | Passwordless email OTP (3-min expiry). 30-day inactivity session timeout. Local PIN/Biometric to open the app. Phone-only accounts can use the embedded widget but **cannot sign in to the standalone app in Phase 1** (SMS OTP deferred — per-message SMS cost against a free-forever strategy). |
| **General Chat** | Multi-device sync, offline read (last 100 cached messages), edit/delete, threaded replies, rich attachments. |
| **Open API Layer** | REST + Webhook endpoints using stable `publicId` mappings. |

> **DECIDED (O1)** — global phone lookup deferred; host assertions would leave an enumeration
> surface, and email, invite links, and QR already cover Connections. Signed off 19 Oct 2026.

---

### 4. Edge Case Handling

- **Un-claiming:** A user cannot simply un-claim a task. They must use Forward to pass the ball to
  another user, maintaining the audit trail. Forwarding records the actor, the previous holder, and
  the new holder in the audit event. If the holder has left or been deprovisioned, an eligible closer
  reassigns the task instead — same event shape, different actor.

- **Closing Flags:** The assignee clicks "Mark as Done", moving the task to `done`. A closer then
  either **closes** it or **reopens** it, sending it back to `claimed` with the same claimant. For
  widget and API-originated tasks the sender is the customer or an external system, so closing is
  always the agent side's. The manager review queue is the Action Inbox rollup filtered to `done`.

- **Host App Guest Friction:** Embedded widget users can chat immediately via shadow accounts.
  **File uploads from the widget are blocked by default.** An organisation may opt in to accept
  widget uploads into its own bucket, subject to per-file size, type, and rate limits — widget
  customers writing into an org's storage is a cost and abuse vector, so blocked is the safe
  default. Linking a shadow account to a real account requires email OTP, so in Phase 1 a
  phone-only guest cannot be upgraded.

- **BYOS = `none` state:** An organisation with no storage configured operates in text-only mode.
  BYOS setup is an upgrade path, not a hard requirement for basic usage.

- **Provisioned accounts without email:** An account created through API provisioning that has no
  email address **cannot be activated in Phase 1** and is explicitly unusable for sign-in. Adding
  an email address later moves it to the normal activation path. This is a stated limitation, not
  an oversight: SMS OTP is deferred.

---

## Part 2: Tech Stack

### Frontend (Client Side)

- **Mobile App (iOS/Android):** React Native.
- **Web / PWA:** Next.js (React).
- **Embeddable Chat SDK:** Vanilla TypeScript + Convex JS Client. Lightweight, dependency-free
  snippet for host apps, rendered in a secure iframe / Shadow DOM.

> **LOCKED** — restored from v1.1. The v1.2 Flutter change was not approved.

### Backend & Database

- **Backend-as-a-Service:** Convex — Database, Real-time WebSocket Sync, Server Functions, Cron
  Jobs, Auth, and HTTP Actions for the Open API layer.
- **Language:** TypeScript — end-to-end type safety from database to client.

### External Integrations & Infrastructure

- **Email Provider:** SendGrid or AWS SES (OTP delivery).
- **Key Management:** Envelope encryption with a versioned master key held in an environment
  variable. AWS KMS / GCP KMS is a documented future step, wired in before the first paying
  franchise. Phase 1 does not depend on external KMS infrastructure.
- **BYOS Cloud Providers:** S3-compatible storage, organisation scope (Phase 1). Google Drive,
  Dropbox, and Azure are Phase 2 candidates; user scope is deferred.
- **Auth:** Convex Auth (beta) for email OTP with a custom sender, behind a thin wrapper so it can be
  swapped, version-pinned. See O5.
- **Hosting:** Convex Cloud (Managed) for Phase 1. **Self-hosted option for Enterprise (Phase 2).**
  Frontend hosting: Vercel.

---

## Part 3: Database Design

```typescript
// convex/schema.ts — v1.3
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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

export default defineSchema({

  // ============================== IDENTITY ==============================
  users: defineTable({
    publicId:      v.string(),
    email:         v.optional(v.string()),   // at least one of email|phone, enforced in the
    name:          v.string(),               // user-creation callback
    phone:         v.optional(v.string()),   // E.164 normalised
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
  .index("by_email",     ["email"])
  .index("by_public_id", ["publicId"])
  .index("by_phone",     ["phone"]),           // no global discovery in Phase 1 (O1)

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
  })
  .index("by_public_id", ["publicId"]),

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
  .index("by_org_external", ["orgId", "externalSource", "externalRef"]),

  // ============================= WIDGET HOSTS ===========================
  hostApps: defineTable({
    orgId:          v.id("organizations"),
    name:           v.string(),
    issuer:         v.string(),                // expected `iss`
    audience:       v.string(),                // expected `aud`
    allowedOrigins: v.array(v.string()),       // iframe origin allowlist
    supportGroupId: v.id("groups"),
    isActive:       v.boolean(),
  })
  .index("by_org", ["orgId"]),

  hostAppKeys: defineTable({                   // public keys only — no shared secret
    hostAppId: v.id("hostApps"),
    kid:       v.string(),
    alg:       v.union(v.literal("ES256"), v.literal("RS256")),
    publicKey: v.string(),
    notBefore: v.number(),
    notAfter:  v.optional(v.number()),
  })
  .index("by_hostapp_kid", ["hostAppId", "kid"]),

  usedTokenIds: defineTable({                  // jti replay protection; swept on expiry
    hostAppId: v.id("hostApps"),
    jti:       v.string(),
    usedAt:    v.number(),
    expiresAt: v.number(),
  })
  .index("by_hostapp_jti", ["hostAppId", "jti"])
  .index("by_expires",     ["expiresAt"]),

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
  .index("by_org_external", ["orgId", "externalSource", "externalRef"]),

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
      storageRef: v.id("storageConfigs"),           // typed reference, not an opaque string
      fileKey:    v.string(),
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
  .index("by_org_external", ["orgId", "externalSource", "externalRef"]),

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
    provider:      v.union(v.literal("s3"), v.literal("gdrive")),   // Phase 1 builds s3 only
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

  // ============================= INTEGRATION ============================
  apiKeys: defineTable({
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
  .index("by_key_hash", ["keyHash"]),          // every API request authenticates by hash

  webhooks: defineTable({
    orgId:     v.id("organizations"),
    url:       v.string(),                     // https only; private/link-local ranges rejected
    events:    v.array(webhookEventValidator),
    isActive:  v.boolean(),
    createdAt: v.number(),
    // no `secret` — see webhookSecrets
  })
  .index("by_org", ["orgId"]),

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
});
```

---

## Part 4: Architecture Flow

### 1. High-Level System Topology

```text
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
  ├── 🔐 Auth & Session Manager (email OTP, JWT validation, widget trust)
  └── 🌐 HTTP Actions (Open API / Webhook Layer / rate limiting)
         │
         ▼
[ EXTERNAL SERVICES LAYER ]
  ├── 📧 Email Provider (SendGrid / AWS SES)
  ├── 🔐 Key material (versioned env master key; KMS is a future step)
  ├── ☁️ BYOS Storage (S3-compatible, org scope; Drive deferred)
  └── 🏢 ERP / Business Systems
```

> **LOCKED** — the client layer, the reactive engine, and the external services boundary are the
> system's shape. KMS is drawn as a future step, not present infrastructure.

---

### 2. Core Data Flows

#### Flow A: Real-Time Pub/Sub Messaging

1. **Client:** User A sends a message to a 1,000-person group.
2. **Convex:** Mutation inserts **one** message tagged with `groupId` and a server-set `origin`.
3. **Convex:** Clients subscribed to that `groupId` receive it through the reactive query layer.
4. **Result:** one database write per message. Fan-out is 1,000 subscriber query re-runs — read
   cost scales with membership. This is the input to the cost model (O7).

> **CHANGED FROM v1.1** — the "scales infinitely" claim is removed. See Change Log §A (CR-7).

#### Flow A2: Chat-List Ordering (debounced, with trailing flush)

`groupActivity.lastMessageAt` drives chat-list ordering without every subscriber reading every
group's messages. The write is debounced to a 3-second window.

A skipped write schedules **one** follow-up flush if none is already pending. Without the flush, a
second message landing inside the window would never update `lastMessageAt`, and a user who then
marked the group read would see no badge for it. The flush recomputes the value from the group's
latest message rather than trusting the clock, so a debounced value is never wrong — only late.

> **DEFERRED — CR-12. Not adopted.** The chat list **stays reactive**. A non-reactive list was costed
> as a lever: it would refresh on focus, on pull-to-refresh, and by push for background groups, at
> the price of the live updating v1.1 promises. It is not needed — lever 1 alone fits the budget at
> fewer than 40 orgs (Appendix A).

#### Flow A3: Marking a Group Read

1. **Client** sends the **last message ID it has seen** — never a client timestamp.
2. **Server** validates that the message belongs to that group and that its `_creationTime` is
   **not older than** the current `lastReadAt`, then stores it. A stale client cannot move the
   pointer backwards.
3. **Sender exception:** when a user sends a message, the same mutation advances their own
   `lastReadAt` to that message's creation time, so a user's own messages never count as unread.
   This writes one membership row belonging to the sender — not a hot per-group document.

Unread count is a bounded query of messages in the group with `_creationTime > lastReadAt`,
`take(100)`, displayed as "99+".

> **OPEN** — exact unread counts (beyond the bounded approximation) would need per-member counters
> and are deferred.

---

#### Flow B: Telephone Extension (Claiming a Task)

1. **Client:** User B clicks `[ ⚡ Claim Task ]` on an Action Mode message.
2. **UX:** A confirmation prompt appears — "Claim this task?" — preventing misclicks.
3. **Convex:** Calls a mutation wrapped in an ACID transaction.
4. **Transaction logic:** Verifies User B is a member of the task's group and eligible to claim
   (see Part 1 §2), then checks `claimedBy` is unset. If yes → updates to User B, sets status
   `claimed`, and appends a typed `claimed` event to `actionEvents` **in the same mutation**. If
   no → throws (someone else was 1 ms faster).
5. **Real-time update:** All group members' screens update to show "Claimed by User B".

---

#### Flow C: Tree Hierarchy Visibility (Materialised Path)

**Scope (CR-4):** the Action Inbox rollup, plus drill-down into any single child group. There is
**no merged message feed over a subtree.**

1. Convex has no `LIKE`. A subtree query is an index range:
   `gte("groupPath", prefix)` / `lt("groupPath", prefix + "\uffff")`, where `prefix` ends in `/` so
   `/sales/` cannot match `/sales2/`.
2. The prefix matches **descendants only**. The group's own rows are a separate equality query on
   its exact path, merged into the rollup.
3. `groupPath` is denormalised onto `actionInbox` — **not** onto `messages`. The Action Inbox is the
   rollup surface and is far lower-volume than the message stream.
4. Direct messages carry no path. Because `undefined` sorts below every real value in Convex's
   ordering, a DM row can never match a path prefix — the exclusion is structural, not a filter
   someone can forget.
5. Roots are found via `organizations.rootGroupId`, not via `parentGroupId == null` (a DM also has
   no parent).
6. Reparenting is **disabled in Phase 1**, so paths are immutable and no rewrite path is built.
   Paths are built from `publicId` segments — the org segment from `organizations.publicId`, group
   segments from each group's `publicId` — never `_id`, which does not exist until after insert. A
   group rename therefore changes only the display name.

> **LOCKED** — tree-only for groups.
> **CHANGED FROM v1.1** — scope narrowed to the Action Inbox rollup plus single-child drill-down.
> See Change Log §A (CR-4).

---

#### Flow D: BYOS Media Upload (Phase 1)

**Upload**

1. **Client:** sends an upload intent for the group.
2. **Convex Action:** resolves the **org's** `storageConfigs` row (scope: org, provider:
   S3-compatible). If none exists, the org is in `byosProvider: none` state.
3. **Credentials:** fetched from a secrets-only table and decrypted in memory using the versioned
   master key. Tokens never appear on a document any client query can read.
4. **Server generates `fileKey`** under an org/group prefix. The client never chooses the key.
   Unconfirmed uploads are written under an **expiring `pending/` prefix** and are swept if the
   confirm step never arrives.
5. **Pre-signed PUT** is issued, scoped to that exact key, with size and content-type limits.
6. **Client uploads directly.** TeamChat servers never touch the bytes.
7. **Confirm step:** the client confirms, the server promotes the object out of the `pending/`
   prefix, and **only then** is the attachment recorded on the message. An unconfirmed upload never
   becomes a reachable attachment.

**Read**

1. **Server action** checks the reader's access to the group.
2. Only then is a **short-lived signed GET** issued for the attachment. A file key alone grants
   nothing, so group permissions cannot be bypassed.

**Resolution:** the reader resolves the attachment's own `storageRef`. There is no org→user→none
resolution chain at read time — an attachment always states where it lives.

**Not built in Phase 1:** user-scope storage, Google Drive, Dropbox, Azure.

**Setup guide requirement:** recommend a least-privilege bucket policy scoped to the configured
`keyPrefix`, so a leaked credential cannot reach the rest of the org's bucket.

---

#### Flow D2: Embedded Widget Trust (JWT)

1. **Host App** signs a short-lived token with its **private key** (ES256/RS256). The token carries
   the user's identity, a `kid`, a `jti`, `iss`, `aud`, and a short expiry.
2. **Widget** passes the token to TeamChat.
3. **Convex HTTP Action** validates: `kid` against the host app's stored **public key**, the
   signature, `iss` against the expected issuer, `aud` against the expected audience, the expiry
   window, and the `jti` against the `usedTokenIds` table for replay. The iframe origin is validated
   against the host app's `allowedOrigins`.
4. **If valid:** the shadow account is resolved by `hostAppId + externalUserId` — **not by email**.
   Email is an attribute only. Linking a shadow account to a real account requires email OTP.
5. **Shadow accounts** (`accountState: "shadow"`) are confined to their support group, may not
   create DMs, may not claim tasks, and their messages are forced into Action mode server-side.

> **LOCKED** — widget identity never resolves by email. A host asserting an arbitrary address must
> not be able to land in that person's real account.

---

#### Flow D3: Widget Ticket Threading

The first message from a widget conversation **opens the ticket**. Later messages from the same
conversation **attach to the open ticket as thread replies**. A new ticket opens only after the
previous one is closed.

**"Same conversation" is defined precisely:** a ticket is considered open if the shadow user has a
task in that host app's support group whose status is not `closed` or `archived`. That is a single
scoped lookup on `actionInbox` by sender and status — no session, cookie, or host-supplied
conversation ID is trusted, because none of those are verifiable.

Without this rule, every customer message would become its own claimable task — the exact
multi-agent collision that the Action-mode rule exists to prevent. This implements the locked rule
rather than changing it.

---

## Part 5: Open Integration Layer

> TeamChat is designed as an open platform. Any ERP, POS, CRM, or custom business system can trigger
> messages, provision users, and receive status callbacks via this API layer — without embedding the
> full SDK.

### 1. Architecture Principle

**Locked principle:** no architectural decision shall create a closed system. Identity provisioning,
group management, and message triggers must always be automatable via API. This enables franchise
head offices, ERP vendors, and enterprise IT teams to integrate TeamChat without manual onboarding.

> **LOCKED** — unchanged from v1.1.

---

### 2. Authentication — API Keys

External systems authenticate using organisation-scoped API keys, not user sessions.

| Property | Detail |
|---|---|
| **Format** | `tc_live_xxxxxxxxxxxxxxxx` (prefixed, 32-char random) |
| **Storage** | SHA-256 hash only. Plaintext is never stored. Lookup is by hash index — never a table scan. |
| **Scopes** | `messages:write`, `messages:read`, `users:provision`, `groups:manage`, `tasks:read` |
| **Management** | Created and revoked via the Admin Dashboard. One key per integration recommended. |
| **Rotation** | 90 days, enforced by a stored `expiresAt` rather than a documented convention. The dashboard shows last-used to surface stale keys. |
| **Rate Limit** | 500 requests/minute per key, **Phase 1 mandatory**, configurable per org above that floor, enforced with a transactional rate-limiter component. No external Redis, no hand-rolled counter table. |

> **CHANGED FROM v1.1** — the rate limit was described as a Phase 2 default. It ships in Phase 1.
> See Change Log §A (CR-6).
> **DECIDED (O3)** — confirmed mandatory in Phase 1. Signed off 19 Oct 2026.

---

### 3. REST API Endpoints

**Base URL:** `https://api.teamchat.app/v1/`

**Identity:** every request and response uses stable `publicId` strings. Internal Convex IDs never
cross the API boundary.

**Idempotency:** all write endpoints accept an `Idempotency-Key` header. The stored record includes a
hash of the request body, so a reused key with different input returns `409` instead of silently
replaying the first result. A matching replay returns the **original** stored response verbatim.
Keys expire and are swept on a schedule.

#### 3a. Message Triggers (ERP → TeamChat)

Allows external systems to push Action or Discussion messages into any group. API-originated
messages are **text-only in Phase 1** and are sent as the organisation's service user.

```http
POST /v1/messages
Authorization: Bearer tc_live_xxxxx
Idempotency-Key: 8f2c1b74-...
Content-Type: application/json

{
  "groupPublicId":  "grp_abc123",
  "text":           "New purchase order #PO-8821 requires approval.",
  "mode":           "action",
  "externalRef":    "PO-8821",
  "externalSource": "accurate_erp"
}

// Response 201 Created
{
  "messagePublicId": "msg_xyz789",
  "status":          "open"
}
```

#### 3b. Task Status Query (ERP ← TeamChat)

```http
GET /v1/tasks?externalRef=PO-8821
Authorization: Bearer tc_live_xxxxx

// Response 200 OK
{
  "messagePublicId": "msg_xyz789",
  "status":          "claimed",
  "claimedBy":       { "publicId": "usr_111", "name": "Budi Santoso" },
  "claimedAt":       "2026-10-19T09:14:22Z",
  "forwardedTo":     null
}
```

#### 3c. Message Content Fetch

```http
GET /v1/messages/{publicId}
Authorization: Bearer tc_live_xxxxx
// requires scope: messages:read

// Response 200 OK
{
  "messagePublicId": "msg_xyz789",
  "groupPublicId":   "grp_outlet7",
  "text":            "New purchase order #PO-8821 requires approval.",
  "mode":            "action",
  "origin":          "api",
  "externalRef":     "PO-8821",
  "externalSource":  "accurate_erp",
  "createdAt":       "2026-10-19T09:14:22Z",
  "attachments":     []
}
```

This is the endpoint the webhook contract points to. Webhook payloads deliberately carry no message
content; an ERP that needs the text calls this route, which is scope-gated and audited.

#### 3d. User Provisioning (Batch)

Allows ERP/POS systems to auto-create TeamChat accounts, eliminating manual onboarding for large
organisations.

```http
POST /v1/users/provision
Authorization: Bearer tc_live_xxxxx
Idempotency-Key: b71e...

{
  "users": [
    { "email": "budi@franchise-outlet-7.com", "name": "Budi Santoso",
      "externalRef": "ACC-EMP-0007", "groupPublicIds": ["grp_outlet7"] },
    { "phone": "+628123456789", "name": "Sari Dewi",
      "externalRef": "ACC-EMP-0008", "groupPublicIds": ["grp_outlet7"] }
  ]
}

// Response 201 Created
{
  "created": [
    { "userPublicId": "usr_201", "state": "provisioned", "activatable": true  },
    { "userPublicId": "usr_202", "state": "provisioned", "activatable": false }
  ]
}
```

**Account state, not "shadow".** Provisioned staff are created in `accountState: "provisioned"`.
This is deliberately distinct from `shadow`, which means a host-linked widget user confined to a
support group. A provisioned staff member is a full org member awaiting activation.

**Org membership.** Provisioning also creates an `orgMembers` row with `orgRole: "member"`, carrying
the supplied `externalRef` and `externalSource`. This is not bookkeeping — it is what makes
`GET /v1/users?externalRef=` resolve in §3f. Creating the user without the org row would leave the
ERP unable to look up the staff it had just provisioned.

**Activation.** At least one of `email` or `phone` is required. Activation in Phase 1 is by **email
OTP only**:

- `activatable: true` — has an email; receives an OTP invite and becomes `active` on verification.
- `activatable: false` — phone-only. The account exists and is a valid member for routing and audit
  purposes, but **cannot be activated or signed in to in Phase 1**. Adding an email later moves it
  onto the normal activation path.

Returning `activatable` explicitly means the ERP learns immediately which staff cannot sign in,
rather than discovering it when nobody can log in.

#### 3e. Group / Tree Provisioning

Allows franchise head offices or enterprise IT to replicate their org chart programmatically.

```http
POST /v1/groups
Authorization: Bearer tc_live_xxxxx
Idempotency-Key: 4c9a...

{
  "name":            "Outlet Jakarta Selatan 07",
  "parentPublicId":  "grp_jakarta_region",
  "memberEmails":    ["budi@franchise-outlet-7.com"],
  "externalRef":     "ACC-BRANCH-007",
  "externalSource":  "accurate_erp"
}

// Response 201 Created
{
  "groupPublicId": "grp_outlet7",
  "path":          "/org_acme/grp_jakarta/grp_outlet7"
}
```

`externalRef` and `externalSource` are stored on the group and indexed by org, so an ERP can resolve
one of its own identifiers to a TeamChat group without keeping its own mapping table. The same pair
is available on org membership records for user lookup. Lookups are org-scoped: two organisations
may both use the ref `"PO-8821"` without collision.

#### 3f. Lookup by external reference

```http
GET /v1/groups?externalRef=ACC-BRANCH-007&externalSource=accurate_erp
GET /v1/users?externalRef=ACC-EMP-0007&externalSource=accurate_erp
```

Group references resolve on `groups`; user references resolve on `orgMembers`. Both are scoped to the
calling key's organisation through a `by_org_external` index, so two tenants may use the same
reference string without collision.

---

### 4. Outbound Webhooks (TeamChat → ERP)

TeamChat pushes real-time status events to external systems via HMAC-signed POST requests.

| Event | Triggered when |
|---|---|
| `task.claimed` | A member claims an Action message |
| `task.forwarded` | A task is forwarded to another user |
| `task.done` | Assignee clicks Mark as Done (pending review) |
| `task.reopened` | A closer sends a `done` task back, or a customer replies on a `done` ticket |
| `task.closed` | An eligible closer officially closes the task |
| `message.created` | Any new message posted (opt-in, high volume) |

#### Webhook Payload Example

```http
POST https://your-erp.com/teamchat-webhook
X-TeamChat-Signature: sha256=abc123...
Content-Type: application/json

{
  "event":      "task.claimed",
  "occurredAt": "2026-10-19T09:14:22Z",
  "data": {
    "messagePublicId": "msg_xyz789",
    "externalRef":     "PO-8821",
    "groupPublicId":   "grp_outlet7",
    "claimedBy":       { "publicId": "usr_111", "email": "budi@outlet7.com" }
  }
}
```

**Signing secrets** are generated once and shown once at creation. They are stored encrypted in a
table no client-facing query reads. A secret sitting on a listable record is the same defect class
as a storage token sitting on a user record.

**URL validation:** `https` only; private and link-local address ranges are rejected at registration
**and at delivery**, since DNS rebinding defeats registration-time checks.

**Payloads carry no message content**, and this is enforced by the payload validator rather than by
convention. Payloads reference entities only by `publicId`, so internal identifiers cannot leak. ERP
systems call `GET /v1/messages/{publicId}` when content is genuinely needed.

**Delivery is a promise.** Outbound events are persisted with their payload snapshot before the
first attempt, retried on the 10s / 60s / 300s schedule, and moved to a dead-letter state on
exhaustion. A retry sends the **original** payload snapshot, never a re-read of current state.
Delivered rows are swept on a retention schedule; this is the fastest-growing table in the system.

---

### 5. Flow E: ERP-Triggered Action Message (Complete Loop)

1. **ERP System:** an event fires (new support ticket, new PO, stock alert).
2. **ERP calls** `POST /v1/messages` with an `externalRef`, a mode of `action`, and an
   `Idempotency-Key`.
3. **Convex HTTP Action:** validates the key's scope and rate limit, writes the message as the
   org's service user with `origin: "api"`, and records the idempotency key with the response.
4. **Real-time:** all group members see the Action message with `[ ⚡ Claim Task ]`.
5. **Agent claims:** the first agent claims it (Telephone Extension logic applies). A `claimed`
   event is appended to `actionEvents` in the same mutation.
6. **Webhook fires:** TeamChat POSTs `task.claimed` to the ERP's registered webhook URL.
7. **ERP updates:** the ERP marks its record in progress, stamped with the agent's identity.
8. **Closure:** the agent marks Done → a closer either closes it or reopens it → the corresponding
   `task.closed` or `task.reopened` event fires → the ERP record reflects the outcome.

---

### 6. Target Integration Use Cases

**Phase 1 — franchise-first sequencing.** Franchise and chain-store provisioning is the Phase 1
integration, shipped with the API layer, not deferred. Franchise head offices replicate their outlet
tree and staff through the endpoints above, and daily ops alerts flow to regional managers.

| System / Market | Phase | Integration Use Case |
|---|---|---|
| **Franchise / Chain Store** | **Phase 1** | Head office provisions the entire outlet tree and staff via API. Daily ops alerts flow to regional managers. |
| **Accurate Accounting** | Phase 2+ | New AP invoice → Action message to the finance group for approval |
| **SellMore POS** | Phase 2+ | Customer complaint from POS → Action message to the support group |
| **SAP / Oracle ERP** | Phase 2+ | Purchase order approval workflow routed through the TeamChat Action Inbox |
| **Custom App Developers** | Phase 2+ | Any REST-capable app can send alerts and receive status updates |

---

### 7. Design Constraints & Guardrails

- **No message content in webhooks.** Payloads carry metadata and `externalRef` only. ERP must call
  `GET /v1/messages/{publicId}` to fetch content if needed. Enforced structurally by the payload
  validator, not by convention.

- **Webhook retry policy:** 3 retries with exponential backoff (10s, 60s, 300s). Dead-letter queue
  for failed deliveries. Payload snapshots are retained and swept on a schedule.

- **API key rotation:** 90 days, enforced by stored `expiresAt`. The dashboard shows last-used
  timestamps to identify stale keys.

- **Scope enforcement:** every API call is validated against the key's scopes. Writing messages with
  a read-only key returns `403`.

- **Per-group send cap.** On top of the 500/min per key, the API enforces a maximum send rate **per
  target group**, so one key cannot flood one group. The per-key limit alone permits up to 720,000
  messages/day into a single group. Enforced with the transactional rate-limiter component keyed by
  group — **never** a counter document, which would break the locked no-hot-per-group-document
  constraint.

- **Digest mode.** An API caller may collapse repeated alerts that share an `externalRef` into a
  single message carrying a count, instead of emitting one message per event.

- **BYOS not required for API messages:** text-only Action messages triggered via the API do not
  require BYOS. Media attachments via the API are a Phase 3 consideration.

- **Lint — no secret on a client-readable document.** No credential, token, signing key, or private
  key may live on a document that any client-facing query can return. Secrets live in dedicated
  tables read only by server functions.
  *(Violated three times during design: the widget signing secret, the BYOS refresh token, and the
  webhook signing secret.)*

- **Lint — no opaque string where a typed reference belongs.** Identifiers that point at a record are
  typed references, not free-form strings. A stored response is stored as a response, not as a
  reference to one.
  *(Violated three times: the flat media URL list, the untyped storage reference, and the
  idempotency result reference.)*

> Lint 3 — *no document written on every message* — lives in Part 1 §1, because it constrains
> architecture rather than integration.

---

## Appendix A: Cost Model (O7)

**Status: order-of-magnitude estimate, not a forecast.** Placeholder inputs, Convex pricing and
limits checked 19 Oct 2026. Its job is to locate the order of magnitude and identify the sensitive
levers, not to predict an invoice. **Treat the ratios as more reliable than the dollar figures.**

### Budget

| Item | Value |
|---|---|
| Total monthly infra Darwin will absorb in Phase 1 | **$1,000 / month** |
| Fixed costs — Convex dev seats, hosting, email OTP | ≈ $100 / month — **an assumption, to be checked against real bills** |
| Remaining for metered usage | ≈ $850–900 / month |
| Active orgs in Phase 1 | **Fewer than 40** — confirmed 19 Oct 2026 |

### Pricing basis

| Item | Basis |
|---|---|
| Convex Professional seat | **$25 per developer / month** (1–20 developers). Seat fees are **excluded** from spending limits. |
| Function calls | 25M/month included, then **$2 per additional million** |
| Database I/O | 50 GB/month included, then **$0.20 per additional GB** |
| Database storage | 50 GB included, then **$0.20 per additional GB** — and **each index is priced as another copy of the table** |
| File storage | 100 GB included, then $0.03 per additional GB |
| Data egress | 50 GB included, then $0.12 per additional GB |
| Action compute | 250 GB-hours included, then $0.30 per additional GB-hour |
| Subscription updates | Count as **function calls** — so every reactive re-run is billed twice: once as a call, and again for the documents it re-reads |
| Measurement scope | Per **Convex team**, not per org. The included amounts are the sum of every project on the team. |
| Region | The figures above are **US region pricing; other regions are 1.3×** *(Convex docs, **Limits**, checked 19 Oct 2026)* |
| Business & Enterprise | **$2,500/month minimum** — the dedicated-hardware tier |
| WorkOS AuthKit *(fallback only, O8)* | Free to 1M MAU, then $2,500 per additional 1M MAU/month |

Three of these are load-bearing and were not in the first pass:

- **Region multiplier — UNRESOLVED.** The region is not yet chosen. A non-US deployment raises every
  figure here by 30%, which is a larger swing than the gap between the chat-list options and is
  enough to change the answer at the Phase 1 org count. See "Where the ceiling binds".

  *Source:* Convex docs, **Limits** — "Unless otherwise noted, pricing quoted on this page is for US
  regions. Pricing in other regions is 1.3x." (`docs.convex.dev/production/state/limits`, checked
  19 Oct 2026.)
- **Indexes are billed as extra copies of the table.** TeamChat's schema is index-heavy — `groups`,
  `messages`, `actionInbox`, and `actionEvents` each carry several. Database storage is therefore a
  multiple of the row data, not a rounding error.
- **Per-team measurement.** One bucket shared by every tenant, so one badly-shaped org consumes the
  allowance every other org depends on.

### Inputs

| Input | Typical franchise chain | Worst case |
|---|---|---|
| Messages **sent** per user per day | 15 | 60 human; machine-generated volume is separate and can exceed it |
| Group sizes | outlet 5–15 · region 20–80 · org-wide 200–1,000 | org-wide 5,000 |
| Active users per org (DAU) | 100–500 | 5,000 |
| Peak concurrent viewers of a group | 15% of members | 60% at shift start, weighted by duration |
| Groups per user | 3–6 staff · 8–15 outlet manager · 30–60 regional manager | — |

### Shape of the cost

```
re-runs per message = concurrent viewers of that group
```

Cost per message scales with group size, and cost per org scales with `Σ (messages_g × viewers_g)`.
The three-tier tree is what keeps this tractable: most messages land in ten-person outlet groups
where a message costs about two re-runs, not in the org-wide group where it costs 150.

**A single 5,000-member group carrying a meaningful share of traffic breaks the model on its own,
independent of how many users the org has.** That is why large groups need a design limit rather
than a price. The bound is **CR-14**, which routes those orgs to Enterprise; CR-13
(announcement-style groups) is the in-product fallback and is deferred.

### Baseline result

400 users, 15 sent/user/day, a 50-message live page at 0.8 KB/document, 15% of members viewing a
group at once. Outlet groups 40 × 10 at 70% of volume, region groups 8 × 40 at 20%, one org-wide
group of 400 at 10%.

| Design | Per org per month | Per active user per month |
|---|---|---|
| Unread from two documents (the O9 fix) | ≈ $26 | ≈ $0.06 |
| Unread as a reactive `take(100)` scan | ≈ $100 | ≈ $0.25 |

O9 is confirmed by the numbers — the reactive scan costs about **4×** the two-document version. Even
in the fixed design, most of the cost is feed re-reads (the live page re-read on every message) and
chat-list re-runs, not the messages themselves.

A 5,000-user org at 60 sent/day through the same design came out in the tens of thousands of dollars
a month. That is a signal that huge groups need design limits, not a price.

### Levers, ordered by saving

Same placeholder inputs, 400 users. **Ordered by what each actually saves, not by convenience.**

| Step | Per org per month | Saving from previous |
|---|---|---|
| Baseline — two-document unread, reactive list, 50-message page | ≈ $26 | — |
| + live page of 15 messages | ≈ $18 | ≈ $8 |
| + non-reactive chat list | ≈ $6 | **≈ $12 — the largest single saving, and the one that costs product feel** |
| + org-wide group announcement-style *(assumes 4× fewer live viewers — a guess)* | ≈ $3 | ≈ $3 |

### What $900 a month buys

*$900 is the top of the $850–900 usage estimate. At $850 every count below falls by roughly 6%.*

| Design | Per org per month | Orgs that fit in $900 |
|---|---|---|
| Baseline (50-message page, reactive list) | ≈ $26 | ≈ 37 |
| Page of 15, option B (live set of 5) | ≈ $17 | ≈ 57 |
| B + announcement-style org-wide group | ≈ $13 | ≈ 73 |
| Page of 15, fully non-reactive list (A) | ≈ $6 | ≈ 150 |
| A + announcement-style org-wide group | ≈ $3 | ≈ 330 |

**Correction worth keeping.** Option B was first proposed on the assumption that it captured most of
the saving. It does not. Ordinary staff belong to only 3–6 groups, so a live set of 5 covers nearly
all of them and B saves roughly **10%** of the chat-list re-runs, not most of them. The ≈ $6 row is
the fully non-reactive design, A, not B.

So the choice reduces to one number. **If Phase 1 is a pilot of a few dozen orgs, B fits the budget
and keeps the live feel. Past roughly 60–70 active orgs, B does not fit, and the choice is A,
announcement-style groups, or both.**

### Where the ceiling actually binds

The Phase 1 org count was confirmed at **fewer than 40**. Against that number, lever 1 alone is
enough and the chat-list lever is not needed at all:

| Design (two-document unread throughout) | Per org | Orgs that fit in $900 |
|---|---|---|
| Benchmark: 50-message page, reactive list | ≈ $26 | ≈ 35 |
| **Lever 1 only: page of 15, reactive list** | **≈ $18** | **≈ 50 (US) · ≈ 38 (non-US at 1.3×)** |

So the recommendation is **lever 1 only** — keep the reactive chat list, keep the live updating that
v1.1 promises, and still fit the budget at fewer than 40 orgs. CR-12 is deferred rather than adopted
because at this scale it buys a product regression for headroom that is not needed.

**The region is the one thing that can disturb that.** At $18 per org:

- US region — the ceiling is reached at **about 50 orgs**.
- Non-US region (1.3×) — the ceiling is reached at **about 38 orgs**.

If the deployment lands in a non-US region *and* Phase 1 reaches 39–40 orgs, lever 1 alone no longer
fits and CR-12 or CR-13 comes back onto the table. Until the region is chosen, **treat 38 orgs as the
working ceiling, not 50.** Which non-US region, and whether the extra 30% is worth buying, is the
subject of *The region* below.

### The region — the last open input

Verified against Convex's **Regions** page, 19 Oct 2026:

| Region | Location | Pricing |
|---|---|---|
| `aws-us-east-1` | US East (N. Virginia) | Standard |
| `aws-eu-west-1` | Europe (Ireland) | 30% surcharge |
| `aws-ap-southeast-2` | **Asia Pacific (Sydney)** | 30% surcharge |
| `aws-ca-central-1` | Canada (Central) | 30% surcharge |

**Sydney is live, and that changes the answer.** The earlier recommendation was US East, on the
reasoning that neither the US nor the EU is near Jakarta so latency did not clearly favour either.
That premise is now out of date. Sydney is on the customers' side of the Pacific and carries the same
30% surcharge as the EU, so the choice is a genuine trade rather than a wash:

| Region | Position relative to Jakarta | Orgs that fit in $850–900 |
|---|---|---|
| US East | furthest of the four | ≈ 50 |
| **Sydney** | **closest of the four** | ≈ 38 |
| EU West | furthest | ≈ 38 |
| Canada (Central) | furthest | ≈ 38 |

At **fewer than 40 orgs**, Sydney's ceiling of about 38 is either comfortable or just short depending
on where inside "fewer than 40" Phase 1 actually lands. So the recommendation is **not to lock US
East on the old premise**, and not to assume Sydney wins either — run **S6**: deploy a trivial app in
each candidate region, measure median and p95 mutation round-trip from Jakarta, and decide on the
measurement. Distance is a reason to test Sydney, not a reason to presume it.

Two facts hold regardless of the choice:

- **A deployment's region cannot be changed after creation.** Moving later means a new project and a
  migration by export and import. This is a decision made once.
- **The data lives where the deployment lives.** Indonesian personal-data transfer rules follow the
  data, not the latency, so counsel should be asked about cross-border transfer before the Enterprise
  tier is offered. Note that v1.1's **self-hosted Enterprise option sidesteps the question entirely**
  for exactly the customers most likely to raise it.

### Concurrent sessions — a second ceiling, and money does not buy it

Everything above prices *work*. The S256 class also caps *simultaneity*.

| S256 limit | Cap | TeamChat at 40 orgs × 400 users |
|---|---|---|
| Concurrent sessions | 10,000 | 16,000 people; 2,400 at 15% steady, **9,600 at a 60% shift-start burst** |
| Concurrent queries | 256 | binds sooner — one message re-runs the feed for every live viewer |
| Concurrent actions | 512 | API ingest, webhook dispatch, scheduled sweeps |

A 60% burst reaches about **96% of the session ceiling** before second devices and widget guests are
counted, and it does so at a spend the budget calls comfortable. **The two ceilings are unrelated:
staying under $1,000 does not keep the deployment under 10,000 sessions.**

Cheap mitigations, in order: connect the widget only while it is open; drop idle sessions instead of
holding them in the background; and keep the live-page window (lever 1), which directly reduces
concurrent query pressure.

Escaping S256 means Business or Enterprise — a **$2,500/month minimum plus a per-deployment fee that
varies by class**, on top of a $1,000 budget. D1024 gives 100,000 sessions and 1,024 concurrent
queries; D2048 gives 200,000 and 2,048. **S5 is the test.**

### Storage — the line the first model missed

The $18 and $26 figures price function calls and database I/O. They do **not** include database
storage, and storage is the one line that only ever grows.

Convex bills **each index as another copy of the table**. `messages` carries four indexes
(`by_group`, `by_parent`, `by_public_id`, `by_org_external`), so every message is stored roughly five
times over.

On the placeholder inputs: 400 users × 15 sent/day = 180,000 messages/month at 0.8 KB = 144 MB of row
data, giving **≈ 0.7 GB/month per org** once the index copies are counted.

| | Cumulative | Billable over the 50 GB included | Monthly cost |
|---|---|---|---|
| 40 orgs, month 2 | 56 GB | 6 GB | ≈ $1 |
| 40 orgs, month 12 | 336 GB | 286 GB | **≈ $60** |
| 40 orgs, month 24 | 672 GB | 622 GB | ≈ $124 |

At 40 orgs, $720 of usage plus ≈$60 of storage is still inside $900 in month 12 — but storage adds
roughly **$5.60 a month, every month, and never plateaus**. It is the only line in this appendix with
no ceiling. Two decisions, both before launch:

1. **A retention policy for `messages`.** Attachments already live in the org's own bucket (BYOS), so
   a message row is small and cheap to keep; the real question is how far back history stays
   queryable, not what is stored. Note this also interacts with the audit-trail intent in Part 3 —
   deleting messages is a product decision, not only a cost one.
2. **Prune unused indexes on `messages`.** Each one removed saves about a fifth of that table's
   storage and a slice of write cost. But **two of the four are load-bearing:**
   - `by_public_id` is **not** prunable. `GET /v1/messages/{publicId}` is how the ERP fetches content
     from a webhook, and that contract is locked in Part 5 §7.
   - `by_org_external` resolves **no specified Phase 1 endpoint** — both `?externalRef=` lookups
     resolve on `groups` and `orgMembers` (Part 5 §3f). Confirm nothing else needs it, then prune it.
     It is the strongest candidate, and the only one.

### Budget enforcement

The $1,000 ceiling is a **total** — Convex seats, hosting, and email OTP all come out of it. That
matters when setting Convex's own controls, because **seat fees are excluded from Convex spending
limits**: a $1,000 spending limit is therefore not a $1,000 bill, and the limit should be set below
the ceiling by the seat cost. The fixed-cost figure above is an assumption and should be checked
against real bills before the limit is set.

**What the platform gives you — turn both on.**

- **A usage-limit warning threshold** at about **70%** of the usage budget, per metric, per day or
  month. Convex emails every team member when it trips. This is a per-*deployment* control, measured
  in resources rather than dollars — but resources are measured per *team*, so in a single shared
  deployment it warns about the whole product, not one tenant.
- **An emergency disable threshold** — a Convex *spending* disable limit at a circuit-breaker multiple
  of the ceiling (≈1.5×), understood for exactly what it is: **exceeding it disables every project on
  the team.** All tenants stop at once. It is a last resort against a runaway, not a budget gate, and
  never the first line of defence.
- **Spending limits apply only to usage beyond the included amounts.** The included allowances are
  free headroom, but they are invisible to the limit and have to be counted separately when
  projecting.

**What the platform cannot do.** It cannot isolate a tenant. Usage is measured per team and limits are
per deployment, so no platform setting caps one org without capping the product. The only native route
to per-tenant limits is one project per tenant — which the multi-tenant schema design does not do, and
which Professional caps at 300 deployments. It would also give per-tenant *limits* without per-tenant
*billing*, since cost is still summed per team. Not recommended, but it is the alternative and it
should be a decision rather than an oversight.

**What to build.**

1. Per-org usage rollups, **scheduled or sampled — never a per-message counter**, which would break
   the locked no-hot-per-group-document rule.
2. An alert at about **70%** of budget, driven by those rollups — separate from, and in addition to,
   the Convex warning above.
3. An onboarding gate on **projected cost, not on org count.** Orgs differ too much in size for a
   count to hold: a hundred ten-person outlets and a single thousand-user chain are not the same
   admission. Project each candidate org from its **active users and its group sizes**, and admit it
   only if the projection keeps total projected spend under the ceiling. The org-count figures in
   "Where the ceiling binds" are a coarse proxy for that same budget, not the gate itself.

### Revenue side

Under the locked free-forever strategy TeamChat earns **$0 per org as well as $0 per user** — so
there is no direct revenue to net the cost against. The return is indirect: retention and upsell on
Accurate and SellMore. The ceiling is therefore a share of what an org already pays for its ERP.

Illustration only, not data: if infra were capped at **3% of ARPA**, a $26/org/month design needs
about **$870/month of ARPA per org**. The 3% is the reviewer's figure, chosen for the arithmetic.
Darwin's CAC and cost-centre figures from the CPS analysis are the natural yardstick.

### The tail, and the answer to it

Cost is superlinear in group size, so the average org size is uninformative — free-forever fails on
the tail, not the mean. **The tail count is answered: none today.** No current Accurate customer
exceeds about 1,000 staff, so there is no tail cost to defend against. Large customers are the
opportunity rather than a present liability — which is precisely why the limit is written as a tier
and not as a cap.

**Position — adopted 19 Oct 2026.** There is no tail problem today, so free-forever is safe now. But
1,000+ staff organisations are the commercial opportunity, so the design limit must not read as a
wall. It is a tier:

- Orgs up to about **1,000 staff** run on the standard free design.
- Larger orgs are a **separate commercial conversation**, and v1.1's **self-hosted Enterprise option**
  is their natural home. They also have the budget to pay.

Bounding a locked free-forever commitment at a staff count is a change to that commitment, not a
footnote to it — which is why it is **CR-14** in section A rather than a line in this appendix.

Consequence for CR-13: announcement-style groups existed to stop one large group dominating an org's
cost. If 1,000+ staff orgs route to Enterprise instead, the standard tier never hosts a group large
enough to need the mode, and CR-13 stays deferred.

### Open

| Question | Owner | Status |
|---|---|---|
| Active orgs in Phase 1 | Darwin | **Answered — fewer than 40** |
| Tail policy: a bound on free-forever, with 1,000+ staff orgs on Enterprise | Darwin | **Answered — adopted 19 Oct 2026, logged as CR-14** |
| Deployment region | Darwin / build | **OPEN — the only open input.** Four regions exist; **Sydney is live** at the same 30% surcharge as the EU. Decided by **S6**, and unchangeable after the deployment is created |
| Who pays — TeamChat absorbs it, the franchisor, or the ERP vendor | Darwin | **Answered for Phase 1 — TeamChat absorbs it.** The $1,000 is a total, seats and hosting included |
| The Accurate tail count: how many customers exceed ~1,000 staff | Darwin | **Answered — none today.** Large customers are the opportunity, which is why the bound is a tier |
| CR-13 thresholds (~300 / ~250) against real group sizes | Darwin | **Deferred with CR-13** |
| Option A versus B for CR-12 | superseded | **Closed — neither. Lever 1 alone fits at fewer than 40 orgs.** |

**A per-user figure is deliberately not stated here.** Under free-forever a staff user generates $0,
so there is no per-user revenue to net against; the meaningful comparison is cost per org per month
against revenue per org per month. Per-user numbers are useful only for comparing orgs of different
sizes.

### Order of work

1. **S1 first** — the union-variant indexing test, on the first deploy and before any other code. It
   probes the `groups` index variants (`path`, `dmKey`, `orgId`, `externalRef`) and the
   `byosCredentials` union. If it fails, the fallback is flattening to optional fields with
   function-boundary validation, and every schema decision downstream depends on which shape wins.
2. **S6 alongside S1** — the first deploy doubles as the latency test. Run it in every candidate
   region, because the region cannot be changed later and it is the last open input.
3. **S2 and S3** — the message-insert load test without a per-group counter, and the widget token
   exchange through `ConvexCredentials`.
4. **S5 before onboarding the first real org** — concurrent sessions and concurrent queries under a
   simulated shift-start burst. This is the one test whose failure cannot be fixed with money inside
   the Phase 1 budget.
5. **Decide retention, and prune `by_org_external` on `messages`** — before launch, while the schema
   is still cheap to change.
6. **Instrument the first 5–10 real orgs.** Per-org usage rollups turn this appendix from a
   placeholder model into a measured one. Recalibrate **messages sent per user per day** and **peak
   concurrent viewers per group** first — those two drive every other figure here.

---

*— End of Document —*

**TeamChat Confidential | Version 1.3 | October 19, 2026**

*Recorded by Darwin Tjoe on 19 October 2026: CR-1 to CR-11, CR-14, and O1 to O4. **CR-12 and CR-13
are deferred, not adopted** — the chat list stays reactive. Levers added after the sign-off are in §F.
What still requires work is in §E (O5–O7, O9), Appendix A (Order of work), and smoke tests S1–S6. The
only open input is the deployment region. (O8 was verified and closed 19 Oct 2026.)*
