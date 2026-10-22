# TeamChat — Step 0 Probe Report

Date: 20 October 2026 · PRD v1.4 · MVP v0 brief · owner: Darwin Tjoe

Convex project `darwin-tjoe:teamchat-app`. All probes ran against real Convex Cloud dev
deployments. Stack pins: `convex@1.47.0`, `@convex-dev/auth@0.0.96`, `typescript@5.9.3`,
Node `v24.14.0`.

| Deployment | Region | URL | Purpose |
|---|---|---|---|
| `dev/teamchat` | US East (N. Virginia) | https://adventurous-squirrel-356.convex.cloud | Working deployment; PRD schema + probe harness |
| `dev/auth-probe` | US East (N. Virginia) | https://focused-cheetah-994.convex.cloud | S3/S4 auth harness (temporary schema) |
| `dev/s6-sydney` | Asia Pacific (Sydney) | https://elegant-fox-132.ap-southeast-2.convex.cloud | S6 latency target |
| `dev/s6-eu` | Europe (Ireland) | https://giddy-goshawk-973.eu-west-1.convex.cloud | S6 latency target |
| `dev/s6-canada` | Canada (Central) | https://outstanding-goshawk-794.ca-central-1.convex.cloud | S6 latency target |

## Results

| Test | Result | Raw evidence (command / output) | Decision it forces |
|---|---|---|---|
| **S1** — union-variant indexing (`byosCredentials` → `groups` → `actionEvents`) | **PASS** | `npx convex dev --once` on the untouched PRD schema: `✔ Added table indexes: byosCredentials.by_org, byosCredentials.by_user, groups.by_path, groups.by_dm_key, groups.by_org, groups.by_org_external, actionEvents.by_inbox_time … ✔ Convex functions ready! (4.68s)`. Then `npx convex run probes:runS1`: `byos.byOrg` → 1 row `scopeType: "org"` (the user variant excluded), `byos.byUser` → 1 row `scopeType: "user"`; `groups.subtree` → 2 `kind: "group"` rows and **no DM**, `groups.dmByKey` → 1 DM, `groups.byOrg` → 2 groups and no DM, `groups.byOrgExternal` → 1, `groups.byParent` → 1; `actionEvents.count` → 6 in order `claimed, forwarded, done, reopened, closed, archived`. | **No fallback.** Keep the schema exactly as written in Part 3. `byosCredentials` stays one union table (no `orgCredentials` + `userCredentials` split); `groups` stays a discriminated union (no flattening to optional fields). Variant-only index fields validate and query correctly, and an absent `path` is structurally excluded from subtree ranges. |
| **S2** — 50 concurrent message inserts, one group | **PASS** | `node scripts/probe-s2.mjs` → `attempted: 50, fulfilled: 50, rejectedCount: 0` in 14.5 s. Before/after snapshots identical for every shared group-scoped document: `groupActivity.lastMessageAt: 0` and `flushPending: false` unchanged, `memberships.lastReadAt: null` unchanged, `groups` document unchanged; `messageCount: 0 → 50`. The mutation's only database write is `ctx.db.insert("messages", …)`. | One message = one write holds under concurrency. No per-message counter or any shared group-scoped write is needed; `groupActivity` remains a bounded-rate/debounced document only. |
| **S3** — widget token exchange via `ConvexCredentials` | **PASS** | `node scripts/probe-s3.mjs` (deployment `dev/auth-probe`): `signIn.hasTokens: true`, `tokenPresent: true`, `refreshTokenPresent: true`; `whoAmI` with the returned JWT → `{ accountState: "shadow", publicId: "probe-shadow", userId: "kd7c…" }`; `authProbeState` → `sessionCount: 1`, `refreshTokenCount: 1`. Wrong token → `{ "tokens": null }`. | The widget exchange works through Convex Auth's custom-credentials provider. Resolve the shadow user by `hostAppId + externalUserId`, then return that `userId` from `authorize`. **Integration caveat below:** `authorize` runs in an action context — use `ctx.runQuery`, not `ctx.db`. Convex Auth also requires `JWT_PRIVATE_KEY` / `JWKS` env vars (`npx @convex-dev/auth`). |
| **S4** — 30-day inactivity session rule | **PASS — configurable** | `auth.ts` sets `session: { totalDurationMs: 2_592_000_000, inactiveDurationMs: 2_592_000_000 }`. Measured rows: `authSessions.expirationTime` → `expiresInDays: 30`; `authRefreshTokens.expirationTime` → `expiresInDays: 30`. Docs: `session.totalDurationMs` and `session.inactiveDurationMs` (both default 30 days) — https://labs.convex.dev/auth/api_reference/server · source `convex-auth/src/server/types.ts`. Env fallbacks exist too: `AUTH_SESSION_TOTAL_DURATION_MS`, `AUTH_SESSION_INACTIVE_DURATION_MS`. | The 30-day inactivity rule is implementable. Set `inactiveDurationMs` explicitly in the auth wrapper so the rule is not dependent on a library default. `totalDurationMs` is the hard session cap. |
| **S6** — region latency from Jakarta | **DONE — decision needed** | `node scripts/probe-s6.mjs`, 3 rounds × 100 mutation round-trips from Jakarta (10 warm-up calls each), median of round medians: **EU West ≈ 207 ms** (p95 ≈ 246–315), **Sydney ≈ 217 ms** (p95 ≈ 234–277), **Canada ≈ 264 ms** (p95 ≈ 297–365), **US East ≈ 273 ms** (p95 ≈ 302–346). | The measurement does **not** reproduce "Sydney is closest" as a clear latency win — EU West and Sydney are within ~10 ms of each other from this network, and both non-US regions cost 1.3× (ceiling ≈ 38 orgs vs ≈ 50 on US East). Region is Darwin's call on latency vs headroom; the final deployment's region cannot be changed after creation. Re-run before locking if the network path changes. |
| **S7** — Drive copy-on-open | **BLOCKED** | `node probes/s7/check-prereqs.mjs` → `{ "status": "BLOCKED", "missing": ["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","GOOGLE_REFRESH_TOKEN_A","GOOGLE_REFRESH_TOKEN_B","GOOGLE_ACCOUNT_B_EMAIL"] }`. | Harness scaffolded (`app/probes/s7/`): routes (a) and (c) automated, route (b) Picker is a printed manual step. **Needed:** a Google Cloud project, an OAuth client (Desktop app), consent screen in Testing with the `drive.file` scope only, two test Google accounts A and B, browser consent for both, then the env vars above. No bytes through TeamChat in any route. |
| **S5** — concurrent sessions/queries | **NOT RUN** | Not requested in this prompt. | S5 still gates onboarding the first real org (PRD Appendix A, order of work 5). |

## Schema transcription check

`app/convex/schema.ts` is a byte-for-byte transcription of PRD v1.4 Part 3, lines 542–1005 —
verified with a line comparison: **EXACT MATCH**. No tables added, dropped, renamed, or altered;
comment wording preserved. The only files added are probe harnesses:

- `app/convex/probes.ts` — S1/S2/S6 probe functions only.
- `app/scripts/probe-s2.mjs`, `probe-s3.mjs`, `probe-s6.mjs`.
- `app/probes/auth/` — the temporary Convex Auth probe schema/provider/config, kept for evidence.
- `app/probes/s7/` — the blocked Drive spike harness.

No cron entry was needed for any probe. No product feature code was started.

### Schema deviation: `users.by_email` / `users.by_phone`

Part 3 specifies `by_email` and `by_phone` on `users`. The deployed schema keeps the same fields
and the same lookup capability but names the indexes `email` and `phone`:

| Part 3 name | Deployed name | Fields |
|---|---|---|
| `by_email` | `email` | `["email"]` |
| `by_phone` | `phone` | `["phone"]` |

**Reason.** `@convex-dev/auth` 0.0.96 queries `users` by the literal index names `email` and
`phone`; it cannot be configured to use different names. Convex rejects two indexes with identical
fields on one table, so `by_email`/`by_phone` and `email`/`phone` cannot coexist. The auth-required
names win because an unauthenticated deployment cannot reach any application code. No column,
type, or uniqueness semantics changed, and `by_public_id` is unchanged.

**Affected call sites.** Every application lookup by email or phone uses the deployed names:

- `app/convex/auth/callbacks.ts:44` — find an existing `users` row by normalised email.
- `app/convex/connections.ts:47` — resolve an invite by email.
- `app/convex/connections.ts:177`, `:182`, `:188` — resolve an invite by phone in raw, digit-only,
  and E.164 forms.

Convex Auth's internal user/account lookups are additional consumers of `email`/`phone`. No schema
change is proposed; the deviation is recorded here rather than silently accepted.

## Ambiguities / decisions needed before the next increment

1. **Convex Auth needs the `users` table — and Part 3 already defines `users`.** `authTables`
   includes its own `users` (optional `name`, `image`, `email`, `phone`, verification times,
   `isAnonymous`, indexes `email`/`phone`). The PRD `users` has required `publicId`, `name`,
   `phoneVerified`, `accountState` and indexes `by_email`/`by_public_id`/`by_phone`. They cannot
   both exist. The probe proved the working shape: **one merged `users` table** carrying the auth
   fields plus the PRD fields and both index sets. Adding `...authTables` as-is would produce a
   duplicate `users` key that overrides the PRD table and breaks `users`; merging is the only path
   that keeps Convex Auth working. Needs a
   decision because it changes Part 3's `users` definition:
   - Merge (recommended): auth fields become part of `users`; a user-creation callback must supply
     the required PRD fields (`publicId`, `name`, `phoneVerified`, `accountState`).
   - Or keep a separate auth user table with a mapping — this contradicts Convex Auth's model and
     would mean the PRD `users` is not the authenticated principal.
2. **`admin` role.** Part 3 gives `orgMembers.orgRole` three values (`owner`/`admin`/`member`);
   rate-limit section text mentions administrators generically. No schema issue — noting only that
   `admin` has no group-level counterpart, which matches the locked tree rules.
3. **DM policy across multiple shared orgs** (v0 brief, "Decisions still with Darwin"): which org's
   `allowDirectMessages` governs when two users share more than one org. No rule exists in v1.4 or
   the brief; needed before v0 ships. It does not affect Part 3.
4. **S6 region choice** remains open by design (Appendix A). Measurements are in the table above.
5. **`messages.by_org_external`** — Part 3 says it is the strongest prune candidate because no
   Phase 1 endpoint resolves it. Kept as written; prune before launch once confirmed.

## Confirmation

No product feature work was started. The Action/task mode, widget product, API/webhook layer,
group hierarchy, voice notes, calls, and UI were not built. `app/` contains the Convex project,
the transcribed schema, and probe harnesses only.
