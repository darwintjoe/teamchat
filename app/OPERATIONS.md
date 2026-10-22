# TeamChat Pilot Operations

Production deployment: `benevolent-crocodile-386` (reference `teamchat-prod`), region
`aws-us-east-1`. This document records the operating decisions that are not visible in the
product UI.

---

## 1. Key custody

### 1.1 What each key does

| Key | Where it lives | What it protects | Loss effect |
|---|---|---|---|
| `TEAMCHAT_MASTER_KEY` | Production Convex env; primary copy `app/.storage/prod-master-key.txt` | AES-GCM envelope key for `byosCredentials` (organisation S3 keys) and `webhookSecrets` (outbound signing secrets) | Every stored S3 credential and webhook secret becomes undecryptable. Existing attachments still exist in the organisation's bucket, but TeamChat cannot sign new reads or deliver webhooks until each credential/secret is re-entered. |
| `JWT_PRIVATE_KEY` / `JWKS` | Production Convex env; private key `app/.storage/prod-jwt-private.pem` | Convex Auth RS256 session tokens | All sessions become invalid. Users can sign in again after a new pair is set, but the old pair cannot be recovered. |
| `CONVEX_DEPLOY_KEY` | `app/.storage/prod.env` | Deploying to `benevolent-crocodile-386` | The holder cannot deploy from this machine; issue a new deploy key in the dashboard. |
| `SENDGRID_API_KEY` | Production Convex env | OTP delivery | Sign-in fails closed. Issue a replacement at SendGrid and set it; no data loss. |

The master key is 32 random bytes, base64-encoded. It is versioned as version 1 in the ciphertext
envelope. This build does not implement master-key rotation: changing the env value makes every
existing `byosCredentials` and `webhookSecrets` row undecryptable. Treat it as a long-lived key
for the pilot.

### 1.2 Holder and backups

Current holder: the pilot build operator (repository owner `darwin-tjoe`). The holder is the only
person who may read the key material.

Required before the first real organisation:

1. **Primary**: the files in `app/.storage/` on the operator's machine. This directory is
   gitignored and must never be committed, zipped into `evidence/`, or attached to a ticket.
2. **Backup A**: a password-manager item (or equivalent sealed secret store) containing
   `TEAMCHAT_MASTER_KEY`, `JWT_PRIVATE_KEY`, and `JWKS`. Record the item name, not the values.
3. **Backup B**: an offline encrypted copy on removable media held by a second named custodian.
   Record the custodian's name and the media location in the pilot access register.

Backups are useless if they are stored next to the deployment's only copy. Keep A and B under
different control. Test restore into a non-production deployment once before the pilot: set the
copied values, decrypt one test credential, and discard the test deployment. The full drill is
§2.4; it is **UNRUN** as of 2026-10-22.

Do not rotate the master key during the pilot. If it is exposed, stop onboarding, treat every
stored S3 credential and webhook secret as compromised, rotate those at the source, re-enter
them, and only then resume.

---

## 2. Export and backup

### 2.1 What is and is not in a Convex export

`convex export` contains Convex database documents and, with `--include-file-storage`, Convex
file storage. TeamChat attachments are **not** in Convex file storage: they live in each
organisation's S3-compatible bucket under its `keyPrefix`. A Convex export therefore backs up
message metadata, attachment records, users, orgs, groups, tasks, API keys (hashes), webhook
configuration, and encrypted credentials — not the attachment bytes.

The organisation's bucket backup is the organisation's responsibility. The pilot agreement must
say so. TeamChat's own export is not a substitute.

### 2.2 Cadence

| What | When | Retention |
|---|---|---|
| Convex export, no file storage | Daily at 02:00 UTC | 30 daily, 12 weekly, 6 monthly |
| Convex export, with file storage | Weekly, Sunday 02:00 UTC | 8 weekly |
| Pre-deploy export | Before every production deploy that changes schema or migration code | Until the next successful deploy + 7 days |
| Bucket backup | Per organisation's own policy | Per organisation's own policy |

Run the export from a machine that holds the deploy key:

```powershell
cd C:\workspace\TeamChat\app
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
New-Item -ItemType Directory -Force -Path "..\backups\convex" | Out-Null
npx convex export `
  --deployment benevolent-crocodile-386 `
  --path "..\backups\convex\teamchat-prod-$stamp.zip"
```

Weekly with Convex file storage:

```powershell
npx convex export `
  --deployment benevolent-crocodile-386 `
  --include-file-storage `
  --path "..\backups\convex\teamchat-prod-$stamp-with-files.zip"
```

Archive location: `C:\workspace\TeamChat\backups\convex\` is the local staging area. It is not
the archive. Copy each completed export to the pilot's encrypted object-storage archive (the
`teamchat-pilot-backups` bucket/prefix chosen by the operator) and record the object key, size,
SHA-256, and export timestamp in the backup log. A local file on one laptop is not a backup.

Verify an export before relying on it:

```powershell
Get-FileHash "..\backups\convex\teamchat-prod-$stamp.zip" -Algorithm SHA256
```

Restore test (non-production only):

```powershell
npx convex import `
  --deployment <staging-deployment> `
  --replace-all `
  --yes `
  "..\backups\convex\teamchat-prod-$stamp.zip"
```

The restored deployment also needs the same `TEAMCHAT_MASTER_KEY` to decrypt credentials and
webhook secrets. Without it the restored rows are present but unusable. §2.4 is the full
decryption/signing drill; it is **UNRUN**.

### 2.3 Region move

To move the pilot to another Convex region:

1. Create a new Convex project/deployment in the target region (the region is fixed at project
   creation; it cannot be changed in place).
2. Set the production environment on the new deployment: `TEAMCHAT_BUILD_CHANNEL=production`,
   `TEAMCHAT_OTP_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `TEAMCHAT_OTP_FROM`, `SITE_URL`,
   `CONVEX_SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`, `TEAMCHAT_MASTER_KEY`.
3. Deploy the same commit with `npm run deploy:prod` pointed at the new deployment key.
4. Export from the old deployment and import into the new one:
   `npx convex export --deployment <old> --path move.zip`, then
   `npx convex import --deployment <new> --replace-all --yes move.zip`.
5. Copy the master key unchanged. If it changes, all `byosCredentials` and `webhookSecrets` rows
   must be re-entered.
6. Keep the same `SITE_URL` or update it everywhere. Changing it invalidates existing auth
   sessions and any host-app issuers that embed it.
7. Re-point the web/mobile clients, run `npm run guard:prod` against the new cloud URL, then run
   one sign-in, one upload/read round-trip, and one webhook delivery.
8. Freeze writes on the old deployment before the final export/import; otherwise messages written
   after the export are lost. A region move is a maintenance window, not a live migration.

BYOS bucket data does not move. The new deployment reaches the same buckets with the same
credentials; only the Convex database moves.

### 2.4 Backup/restore drill — UNRUN

**Status: UNRUN as of 2026-10-22.** This is an open pilot gate. Do not mark it passed because an
export file exists, because an import command was reviewed, or because the code typechecks.

It was not run for three reasons:

- There is no separate scratch deployment. Importing with `--replace-all` into
  `benevolent-crocodile-386` would destroy the only production data copy.
- Production currently has **0 organisations** and no stored `byosCredentials` or
  `webhookSecrets` rows, so even a successful import would not prove that restored ciphertext can
  be decrypted.
- Backups A and B have not been created yet, so there is no independent backup to restore from.

Run this drill before the first real organisation, after Backups A/B exist and at least one
organisation has a stored bucket credential and webhook secret:

1. Create a scratch Convex deployment in the same region. It must not be
   `benevolent-crocodile-386` and must not share its data.
2. Export production with `npx convex export --deployment benevolent-crocodile-386 --path <file>`
   and record the file's SHA-256.
3. Set the scratch deployment's env to the **same** `TEAMCHAT_MASTER_KEY`, `JWT_PRIVATE_KEY`, and
   `JWKS` values used in production. Do not print them.
4. Import with `npx convex import --deployment <scratch> --replace-all --yes <file>`.
5. Prove decryption through existing paths, not just row presence. There is no internal
   decrypt-probe action in this build, and none may be added for the drill. Use:
   - **storage credential:** sign in on scratch, request a read URL for one restored attachment,
     and fetch the object bytes from the organisation's bucket. A successful signed GET proves the
     restored `byosCredentials` row decrypted with the restored master key.
   - **webhook secret:** point one restored webhook at a test receiver, trigger one delivery, and
     verify the HMAC with the restored secret. A 2xx plus a valid signature proves the restored
     `webhookSecrets` row decrypted.
6. Record `pass`/`fail` for each path. Never write a plaintext credential, secret, or key to a
   file, ticket, or `evidence/`.
7. Destroy the scratch deployment. Confirm it is gone from the dashboard.
8. Record in the pilot access register: date, operator, scratch deployment name, export SHA-256,
   import result, storage-read result, webhook result, and destruction confirmation.

If either proof fails, stop. Do not onboard an organisation until the correct `TEAMCHAT_MASTER_KEY`
is restored and the drill passes; re-entering credentials is possible but the lost webhook secrets
cannot be recovered.

---

## 3. Convex platform spend controls

These are Convex account controls, not TeamChat controls:

- Convex warns at approximately **70%** of the team's usage/spend allowance.
- Convex can disable projects at approximately **1.5×** the spending limit.
- Seat fees are **excluded** from the spend limit; they are billed separately.
- A disable applies to **every project on the team**, not just TeamChat.

Consequences for the pilot:

- Keep the TeamChat production project on a team that does not host unrelated production
  workloads if a platform-level disable would be unacceptable.
- The TeamChat model alert at 70% of the **$1,000 internal ceiling** is earlier and narrower
  than the platform warning. It is a projection across active organisations, surfaced in the
  admin UI and the deployment log; it is not a bill and it does not depend on email.
- The platform's 1.5× disable is the hard stop. TeamChat's onboarding gate refuses a candidate
  organisation when its projected spend would take the projected total across the $1,000
  ceiling. Org count is a proxy for planning, not the gate.
- Seat fees are outside the model. Add them separately when comparing the model to an invoice.

Record the account's actual warning/limit values in the pilot access register when the Convex
team is created; the approximate figures above are the platform defaults, not a contractual
guarantee.

---

## 4. Retention decision

**Decision: keep all messages for the MVP. No deletion cron, no automatic expiry, no per-org
retention override.**

Reasons:

- The pilot needs a complete audit trail for Action tasks and for the cross-tenant isolation
  checks.
- Deleting messages would also require deciding what happens to `actionInbox`, `actionEvents`,
  webhook payload snapshots, attachments, and the sender's read pointer. None of that is in the
  MVP scope.
- Storage growth is bounded by the per-organisation cap for attachments; message text is small
  relative to Convex's document costs.

**Revisit at month 12 of the pilot**, or earlier if an organisation's contract requires deletion,
a data-subject request requires erasure, or measured message storage becomes a material part of
the cost model. At that point decide: per-org retention window, soft-delete retention, attachment
deletion, and whether `usageRollups` must retain aggregates after message deletion.

This decision does not override a legal erasure request. The current build has no self-service
erasure; handle such a request as a manual, audited operation and record it.

---

## 5. `messages.by_org_external` decision

**Decision: keep the `messages.by_org_external` index.**

Appendix A's prune recommendation is contradicted by Part 5 §3b. `GET /v1/tasks?externalRef=`
resolves an organisation-scoped external reference through this index; removing it would make
the documented API path a table scan or break the lookup. The index is retained.

The cost model accounts for the index's write cost in the per-message estimate. It is not a
per-message counter and it does not create a hot per-group document.

---

## 6. Production auth and OTP provider

- The production build refuses to compile or start with the echoed-OTP stub enabled (CR-16).
- Production requires `TEAMCHAT_OTP_PROVIDER=sendgrid`, a non-empty `SENDGRID_API_KEY`, and
  `TEAMCHAT_OTP_FROM`; it refuses to serve auth without them. The runtime check rejects an empty
  key; `npm run guard:prod` additionally rejects the known placeholder. A placeholder therefore
  starts the deployment but every real send fails at SendGrid. The request limits still apply: 3
  requests per email and 20 per IP per 10 minutes, plus 10 verification attempts per email per 10
  minutes.
- The demo build keeps the echoed stub. Do not deploy demo flags to production; `npm run
  deploy:prod` is the only supported path.
- SES is documented as an alternative provider behind the same wrapper, but it is not implemented
  in this build. The production guard accepts SendGrid only.
- Real Gmail/Outlook deliverability, SPF/DKIM/DMARC alignment for the from-domain, and bounce
  handling are manual gates. The application can confirm that the provider was called and that
  the code expired after 180 seconds; it cannot prove inbox placement.

---

## 7. Known limits and manual gates

These are not automated by the pilot build and must be signed off by a human:

1. Native iOS and Android device pass on real hardware (the mobile client typechecks and builds,
   but no native device/emulator was available).
2. Real Gmail and Outlook deliverability for the production from-domain.
3. Review of the organisation's bucket policy by that organisation's administrator.
4. Counsel review of any cross-border transfer of personal data implied by the chosen region and
   the organisation's bucket location.
5. A real SendGrid key and a successful real OTP sign-in.
6. A restore test of the key backups into a non-production deployment. The drill in §2.4 is
   **UNRUN**; treat it as open until the restored storage read and webhook signature both pass.

The final pilot report records which of these were completed and which remain open. Do not mark a
manual gate complete because a mock, a local test, or a typecheck passed.

**Known S5 fan-out limit:** production S5 measured a clean 200-viewer single group (p95 425 ms),
but 500 viewers p95 2.65 s, 2,000 stably non-interactive at 9.6–9.8 s, and 40 groups × 200 failed in
both runs (the original 2,385/8,000 subscribers, p95 62.8 s; the instrumented rerun 7,222/8,000,
671 missing, ~199 s send debt). Cap total concurrent live viewers across the pilot at 200 until the
fan-out design is changed. This is a product/deployment limit, not a manual sign-off item.

**Provisional member limit:** 300 members per organisation or group, revisited before organisation
#4 or before any org/group exceeds 300. At a 60% burst that projects 180 concurrent viewers, under
the tested 200-viewer point; this is an extrapolation, not a measured 300-member result. The
pre-onboarding check and group-size flag are in `PILOT_RUNBOOK.md` §1.4 and §5.2.
