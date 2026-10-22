# TeamChat PRD: Gap Review and Recommendations

Prepared for Darwin Tjoe · Review of the 10 open gaps in TeamChat PRD · October 18, 2026

> **Scope note:** The PRD file in the project is v1.0. It has no Part 5, no API keys, and no rate-limit section, so items 5 and 8 could not be checked against the text and are answered from the description of them.

## Summary

Most of the 10 gaps are real, and a few are more serious than first rated. They fall into three groups:

- **Fix before writing any schema** (they shape the data model): items 1, 2, 4, 10.
- **Settle before the widget ships** (security): items 7, 9.
- **Can wait, but need decisions:** items 3, 5, 6, 8.

Two further gaps were not on the original list: the Flow C hierarchy query, and the Flow D media read step for Google Drive.

## Fix before writing any schema

### 1. groups.memberIds array

The problem is bigger than update cost. Convex caps arrays at 8,192 elements, and a franchise root group could exceed that. Every join or leave also rewrites the group document, which re-runs every subscribed client's query on that group.

**Recommendation:** use a `memberships` table with `groupId`, `userId`, `role`, and `lastReadAt`, indexed by group, by user, and by group + user. This does not touch the locked pub/sub model, because messages are still one write.

### 2. Manager and close authority

Put `role` on `memberships` and derive authority from the tree: a manager in a group or in any ancestor group can close its tasks.

The PRD also has a hole here. "The original sender closes" breaks for widget tickets, because the sender is the customer.

**Recommendation:** for widget-origin tasks, closing belongs to the agent side, with optional customer confirmation.

### 4. Flags: flagType and messages.flags

`messages.flags` and `actionInbox.flagType` are two representations of one concept.

**Recommendation:** make the `actionInbox` row the source of truth for workflow, and keep message-level flags as plain labels, or drop them.

A related gap: "Mark as Done, then sender reviews, then close" needs a state between claimed and closed, but the schema only has `open`, `claimed`, and `closed`. Adding a `done` state is additive and does not conflict with any locked item.

### 10. Edit and delete audit trail

This is the biggest gap. The PRD promises an audit trail for the forward chain, but `forwardedTo` is a single overwritten field, so the schema cannot produce one.

**Recommendation:**

- Add an append-only `actionEvents` table (claim, forward, done, close, with actor and timestamp).
- Make Mode A message text immutable once claimed, or keep revisions in a `messageRevisions` table.
- Make deletes soft deletes (tombstones) whenever an `actionInbox` row exists.

Otherwise a sender can change "5 units" to "50" after someone claims the task.

## Security: settle before the widget ships

### 7. Shadow accounts and host-app email trust

The danger is email collision. If the host app can assert any email, it can assert `ceo@company.com` and land in that person's real TeamChat account.

**Three rules:**

1. Identity must come from a short-lived token signed by the host's backend, never from client-side parameters.
2. Key shadow accounts on `hostAppId + externalUserId`, with email as an attribute only.
3. Linking a shadow account to a real one requires the user to verify the email by OTP.

Also confine shadow users to their support group, enforce Action mode server-side, and check iframe origins. This matters more for the third-party developer revenue line than for Accurate or SellMore as first-party hosts.

### 9. BYOS refresh token encryption

Convex has no built-in KMS.

**Recommendation:** use AES-GCM in an action, with the master key in an environment variable and a `keyVersion` field for rotation.

The easiest leak is that `ctx.db.get(user)` returns the whole document, token included. Move tokens into a separate `byosCredentials` table that no client-facing query reads.

## Can wait, with decisions needed

### 3. Circular reference (organizations and groups)

The circular reference is harmless: create the org, then the group, then patch `rootGroupId`, which should be optional.

The real problem is `users.orgId` being singular. A franchisee can belong to several chains, and an Accurate user can be invited elsewhere. Org membership should come from `memberships`.

### 5. External and internal ID mapping

Prefix-style public IDs can be skipped. Add `externalRef` on groups and users instead. What ERP integrations need is a way to attach their own keys (an Accurate branch ID, for example) and idempotency keys on writes.

### 6. Auth: custom OTP vs Convex Auth

Convex Auth can do email OTP with a custom sender, which would cover SendGrid or SES. Check its current maturity in the docs. The widget needs a separate custom-JWT path regardless.

Open question: many SellMore merchants are phone-first, not email-first. If most users enter through the embedded widget, the host-signed identity path in item 7 is the main door and OTP is the side door.

### 8. Rate limits

A minimal version should be P1, because the OTP endpoint, the widget, and the open API are public and cost real money when abused. Convex has a rate-limiter component for this.

- **P1:** fixed, generous abuse limits.
- **P2:** product-tier quotas.

## Two gaps not on the original list

### Flow C will not work as written

Convex has no `LIKE`, so the subtree query would be a range query on the path index. Also, `messages` is indexed by `groupId`, not path. A director's "all nested messages" query means either fanning out across descendant groups or denormalizing `groupPath` onto messages. Paths built from names also break on rename, so use IDs.

### Flow D's read step does not exist for Google Drive

Drive has no pre-signed read URLs, and S3 does. A recipient cannot stream a file from the sender's Drive unless the sender shares it with them, makes it public, or TeamChat proxies the bytes. That last option breaks "servers never touch the file."

Related franchise risk: when an employee leaves and their Drive goes away, the org's chat media goes with it. Org-level BYOS (a bucket owned by the company) may fit the franchise-first sequencing better. It is a BYOS variant, so it does not contradict the locked decisions, and `byosProvider: none` stays as is.

## Cost check on "scales infinitely"

Free-forever is a locked strategy, so this matters. Flow A is one write, but the reactive fan-out is still N query re-runs, so "scales infinitely" overstates it. Before launch, estimate Convex cost per active user, because that decides whether free-forever is sustainable at Accurate or SellMore scale.

## Suggested next step

Start the schema revision with items 1, 2, 4, and 10 together, since they all land in the same tables.
