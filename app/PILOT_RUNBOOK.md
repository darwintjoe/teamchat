# TeamChat Pilot Runbook

Production deployment: `benevolent-crocodile-386` (reference `teamchat-prod`)  
Region: `aws-us-east-1`  
Cloud URL: `https://benevolent-crocodile-386.convex.cloud`  
HTTP site: `https://benevolent-crocodile-386.convex.site`

Run the eight steps in order. Steps 1–2 are one-time platform checks. Steps 3–8 are repeated for
each pilot organisation. Commands are run from `app/`.

Before the first real organisation, the production `SENDGRID_API_KEY` must be a real key. A
placeholder key makes every real sign-in fail closed; it does not silently fall back to the echoed
OTP stub. `npm run guard:prod` is the gate.

**Fan-out limit:** production S5 measured a clean 200-viewer single group (p95 425 ms), but 500
viewers p95 2.65 s and **40 groups × 200 failed in both runs**. The original reached 2,385/8,000
subscribers (p95 62.8 s); the instrumented rerun reached 7,222/8,000 but still missed 671 viewers
and started sends a median 199 s late. Cap total concurrent live viewers across the pilot at
**200** until the fan-out design is changed. See `PILOT_REPORT.md` §4.

**Provisional member limit:** **300 members per organisation or group**, revisited before
organisation #4 or before any org/group exceeds 300. At a 60% burst that projects 180 concurrent
viewers, under the tested 200-viewer point. This is an extrapolation, not a measured 300-member
result. Run the §1.4 pre-onboarding check before creating each organisation.

---

## 1. Verify the production build, environment, and key custody

### 1.1 Deploy the current tree with production flags

The repository normally builds demo (`BUILD_CHANNEL=demo`, `DEMO_OTP_ECHO=true`). `deploy:prod`
temporarily rewrites the flags to production, deploys, and restores the demo flags.

```powershell
cd C:\workspace\TeamChat\app
npm run deploy:prod
```

The deploy uses the deploy key in `.storage/prod.env`, scoped to
`benevolent-crocodile-386`. Do not deploy to the project's default production deployment shown by
a bare `convex deploy`; it is a different, empty deployment.

### 1.2 Run the production guard

```powershell
npm run guard:prod
```

Required result: `production guard: PASS`. The guard checks without printing secret values:

- `JWT_PRIVATE_KEY`, `JWKS`, `TEAMCHAT_MASTER_KEY`, `SITE_URL`;
- `TEAMCHAT_BUILD_CHANNEL=production`;
- `TEAMCHAT_OTP_PROVIDER=sendgrid`;
- a non-placeholder `SENDGRID_API_KEY`;
- `TEAMCHAT_OTP_FROM` is set;
- the cost gate is not disabled in production;
- the running bundle reports `channel=production` and `echoOtp=false`.

Evidence is written to `evidence/prod-guard.txt`. A guard failure is a stop. The known pilot
state at report time is: all checks pass except the SendGrid placeholder; real delivery is a
manual gate.

### 1.3 Confirm key custody before creating an organisation

Read `OPERATIONS.md` §1. In short:

- `TEAMCHAT_MASTER_KEY` decrypts `byosCredentials` and `webhookSecrets`. Losing it makes both
  unrecoverable; rotating it is not implemented in this build.
- `JWT_PRIVATE_KEY` and `JWKS` are the auth signing pair.
- The Convex deploy key can replace the production deployment.
- The SendGrid key can send mail as the configured from-address.

The primary copies are in the gitignored `app/.storage/` directory. Two independent backups must
exist before step 2: one in the pilot operator's password manager, one offline encrypted copy.
Record who holds each copy. Do not put any key in a client-readable document, a ticket, or an
`evidence/` file.

### 1.4 Pre-onboarding check — 300 members and 200 concurrent viewers

Do this before creating each organisation, and record the result. It is a manual gate: the build
has no group-size enforcement code, and no enforcement code may be added for the pilot.

1. From the candidate organisation's roster, record the **largest group member count**.
2. If any group is **above 300 members**, stop and flag it for a new fan-out measurement before
   onboarding. Do not onboard it on the existing 200-viewer evidence.
3. Project concurrent viewers at a **60% burst**:
   `expected_viewers = ceil(largest_group_members × 0.60)`. For 300 members that is 180 viewers,
   under the tested clean point of 200.
4. If the projection exceeds **200 concurrent viewers in one group**, or more than 200 viewers
   across groups expected to be active at the same time, stop. Measured p95 is 424.53 ms at 200
   viewers; 500 viewers is 2.65 s and 40 groups × 200 is a failure.
5. Record in the pilot access register: organisation, largest group, member count, projected burst
   viewers, decision, date, and approver.
6. Re-run this check before any group is allowed above 300 members, and before organisation #4
   regardless of size.

---

## 2. Create the pilot organisation and owner

Before creating the organisation, complete the §1.4 pre-onboarding check and record the decision.

1. Open the production web app.
2. Sign in with the owner's work email and the OTP delivered by SendGrid.
3. Create the organisation with its legal/display name.
4. Record the returned `orgPublicId` (`org_...`) and `rootGroupPublicId` (`grp_...`).
5. Keep direct messages off unless the pilot agreement explicitly allows them. The owner can flip
   the policy later.

The owner account is the only account that can create the first API key, register webhooks, and
set storage configuration. Do not share that account.

### 2.1 Set the per-organisation storage cap

The default cap is `TEAMCHAT_ORG_STORAGE_CAP_BYTES` (5 GiB = `5368709120`). A per-organisation
override is the optional `organizations.storageCapBytes` field, in bytes.

Set it before the first upload, in the Convex dashboard:

1. Open `https://dashboard.convex.dev/t/darwin-tjoe/teamchat-app/benevolent-crocodile-386`.
2. Data → `organizations` → the pilot row → edit.
3. Add or change `"storageCapBytes": 5368709120` (or the contracted cap).
4. Save.

Verify from the app: the storage panel's `myStorageState.storageCapBytes` must show the same
number, not `null`. The cap is checked twice: at upload-ticket creation and again when the
upload is confirmed. A refusal at confirm deletes the promoted object.

---

## 3. Apply the least-privilege bucket policy and configure storage

The organisation supplies an S3-compatible bucket and an IAM principal that TeamChat may use. The
principal must be able to write under `keyPrefix/pending/`, promote to `keyPrefix/`, HEAD and GET
under `keyPrefix/`, and delete under `keyPrefix/`. It must not be able to list the bucket, read
outside `keyPrefix`, change bucket policy, or delete the bucket.

Choose a prefix unique to the organisation, for example:

```text
keyPrefix     = teamchat/org_abc123
pendingPrefix = pending
```

The full pending key is `teamchat/org_abc123/pending/org_abc123/att_.../file.jpg`; the confirmed
key is `teamchat/org_abc123/org_abc123/att_.../file.jpg`.

### 3.1 Exact bucket policy JSON

Replace `ACCOUNT_ID`, `BUCKET`, `teamchat-ORG`, and `teamchat/org_abc123`. Apply this as the
bucket policy (or as the identical IAM user policy if the provider does not support bucket
policies).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TeamChatPendingUpload",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT_ID:user/teamchat-ORG"
      },
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::BUCKET/teamchat/org_abc123/pending/*"
    },
    {
      "Sid": "TeamChatPromoteHeadReadDelete",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT_ID:user/teamchat-ORG"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::BUCKET/teamchat/org_abc123/*"
    }
  ]
}
```

Notes:

- `s3:GetObject` is needed for the confirm-time HEAD, the signed read GET, and the copy source.
- `s3:PutObject` on the second statement is the promotion destination.
- `s3:DeleteObject` removes the pending object after promotion and removes a promoted object if
  the cap refuses at confirm.
- There is deliberately no `s3:ListBucket`; the adapter never lists.
- The principal may be an IAM user, role, or S3-compatible service account. Use its exact ARN; do
  not use `"*"`.
- TLS is required in production. The endpoint must be `https://`.

### 3.2 Bucket CORS

The browser posts the file directly to the bucket and later fetches the signed read URL, so the
bucket must allow the web app's origin. Apply this CORS configuration (replace the origin):

```json
[
  {
    "AllowedOrigins": ["https://pilot.teamchat.example"],
    "AllowedMethods": ["GET", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Do not use `"AllowedOrigins": ["*"]` for a pilot with private attachments. If the mobile client
performs the same direct upload, add its exact origin or use a presigned URL flow that does not
require browser CORS; the current thin client uses the web origin.

Have the organisation's bucket administrator review this policy before go-live. That review is a
manual gate; TeamChat cannot approve another organisation's bucket policy.

### 3.3 Enter the storage configuration

In the web app, as owner/admin, open the storage panel and enter:

| Field | Value |
|---|---|
| Endpoint | `https://s3.<region>.amazonaws.com` or the S3-compatible endpoint |
| Bucket | `BUCKET` |
| Region | the bucket region, e.g. `ap-southeast-1` |
| Key prefix | `teamchat/org_abc123` (no trailing slash required) |
| Pending prefix | `pending` |
| Access key ID | the IAM principal's access key |
| Secret access key | the IAM principal's secret |
| Session token | only for temporary credentials |

The mutation `storage.config.setS3Config` encrypts the credential JSON with
`TEAMCHAT_MASTER_KEY` and writes it only to `byosCredentials`. `storageConfigs` stores a
`credentialRef`, endpoint, bucket, region, and prefixes, never the secret. No client-readable
query returns a credential or a credential reference.

Verification: in the dashboard, `storageConfigs` must contain no access key or secret;
`byosCredentials` must contain only `ciphertext`, `keyVersion`, `scopeType`, and the org id.

---

## 4. Prove the cap and the upload/read round-trip

Run this in a throwaway organisation or before staff are invited, because it temporarily changes
the cap.

1. Read the current usage from the app/dashboard `storageUsage` row (`confirmedBytes` and
   `pendingBytes`).
2. Set `organizations.storageCapBytes` to `confirmedBytes + 1024` in the dashboard.
3. Upload a file larger than 1 KiB in the app:
   - request ticket → presigned POST → confirm.
   - Expected: confirm refuses with a cap error, and the promoted object is deleted. The bucket
     must not contain a confirmed object for that attachment.
4. Restore the real cap.
5. Upload a small allowed file (for example a 10–100 KiB JPEG or PDF):
   - ticket returns a presigned POST;
   - upload succeeds;
   - confirm HEADs the object, promotes it, and returns `status: "confirmed"`;
   - the message shows the attachment;
   - requesting a read returns a short-lived signed GET;
   - the downloaded bytes match the uploaded bytes.
6. In the bucket, verify the object key starts with
   `teamchat/org_abc123/org_abc123/att_.../`, and no object remains under
   `teamchat/org_abc123/pending/`.
7. In `storageUsage`, verify `confirmedBytes` increased by the file size and `pendingBytes` is
   zero.

Do not proceed until the refusal and the round-trip both pass. A cap that is not enforced at
confirm, or an object left under `pending/`, is a stop.

---

## 5. Provision and activate staff

### 5.1 Create a provisioning API key

As owner/admin in the web Integration panel:

1. Create a key labelled `pilot-provisioning`.
2. Grant only `users:provision`, `groups:manage`, and — for the step 7 sample task — `messages:send`
   and `tasks:read`. Split into separate keys if the pilot's integration does not need all four.
3. Copy the plaintext once. It is never shown again and never stored in plaintext.
4. Record the `keyPublicId` for rotation/revocation; do not record the secret.

API keys are `tc_live_...`, expire after 90 days, and have a 500 requests/minute floor unless
raised. `Authorization: Bearer <key>` is required.

### 5.2 Provision users

```powershell
$body = @{
  externalSource = "hr"
  users = @(
    @{
      externalRef = "ACC-EMP-0007"
      name = "Ayu Pratama"
      email = "ayu@example.com"
      groupPublicIds = @("grp_...")
    }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri "https://benevolent-crocodile-386.convex.site/v1/users/provision" `
  -Headers @{
    Authorization = "Bearer tc_live_REPLACE_ME"
    "Idempotency-Key" = "pilot-provision-2026-10-21-001"
    "Content-Type" = "application/json"
  } `
  -Body $body
```

Rules:

- `externalRef` is required and is scoped to the organisation plus `externalSource`.
- At most 100 users per request.
- **Group-size flag:** if this payload would take any group above **300 members**, stop. Re-run the
  §1.4 check and require a new fan-out measurement before onboarding that group.
- A provisioned user is `accountState: "provisioned"` and cannot use chat until activated.
- Re-sending the same `Idempotency-Key` with the same body returns the original response. Reusing
  the key with a different body is refused.

### 5.3 Activate each user

The user signs in with their work email and the OTP sent by SendGrid. The auth callback claims the
pre-created `provisioned` user with the same email and moves it to `active`. Verify:

- `users.me` returns `accountState: "active"`;
- the user can open the assigned group and send a message;
- `GET /v1/users?externalRef=ACC-EMP-0007` returns the user and `state: "active"`.

A user whose email never receives the OTP is not activated. Check SendGrid delivery and the
from-address before changing the account state by hand.

---

## 6. Register the webhook and prove signature, retry, and dead-letter

### 6.1 Register

As owner/admin in the Integration panel, register an HTTPS endpoint. The endpoint must resolve to
a public address; private, loopback, link-local, metadata, and non-HTTPS targets are refused.
Redirects are not followed.

The response returns the signing secret once. Store it in the receiver's secret manager
immediately. It is encrypted into `webhookSecrets` and cannot be read back from the dashboard.
Rotating the secret invalidates the old one.

### 6.2 Verify the signature

Every request has:

```text
X-TeamChat-Signature: sha256=<hex HMAC-SHA256 of the raw request body using the webhook secret>
```

Receiver check (Node):

```js
import crypto from "node:crypto";

const expected = "sha256=" + crypto
  .createHmac("sha256", process.env.TEAMCHAT_WEBHOOK_SECRET)
  .update(rawBody) // exact bytes received, before JSON parsing
  .digest("hex");

const received = req.headers["x-teamchat-signature"] ?? "";
const ok =
  received.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
if (!ok) return res.status(401).end();
```

Do not parse and re-serialise JSON before checking. Do not compare with `===` in production code.

### 6.3 Retry and dead-letter

- Attempt 1 is immediate.
- Retries: +10 s, +60 s, +300 s after the preceding failure.
- Maximum: 4 attempts (initial + 3 retries).
- A 2xx is delivered. A 3xx, 4xx, 5xx, timeout (10 s), TLS failure, or DNS/private-address refusal
  is a failed attempt.
- After the fourth failure the delivery is `status: "dead"`. It is not retried automatically.
- The payload is snapshotted at enqueue time. A retry sends the original payload, not current
  state.
- `webhooks.listForOrg` shows `recentDeliveries` with `status`, `attempts`, `nextAttemptAt`, and
  `lastError`; use it as the dead-letter view. There is no manual replay button in this build.

Test recipe:

1. Point the webhook at a receiver that returns 500 and logs the signature.
2. Send one message in a group.
3. Verify the first request arrives, the signature matches, and the delivery row moves through
   `pending` with `attempts` 1–4 and the expected `nextAttemptAt` gaps.
4. After attempt 4, verify `status: "dead"` and the last error is visible in the Integration
   panel.
5. Point at a receiver that returns 200, send another message, and verify `status: "delivered"`.

The delivery private-address/DNS checks run again before every attempt. A hostname that resolves
to a private address is a retryable failure, not a permanent bypass.

---

## 7. Run one sample Action task end to end

1. Create an Action message through the API with a stable external reference:

```powershell
$body = @{
  groupPublicId = "grp_..."
  text = "Pilot action: confirm opening checklist"
  mode = "action"
  externalRef = "PILOT-TASK-001"
  externalSource = "erp"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "https://benevolent-crocodile-386.convex.site/v1/messages" `
  -Headers @{
    Authorization = "Bearer tc_live_REPLACE_ME"
    "Idempotency-Key" = "pilot-action-001"
    "Content-Type" = "application/json"
  } `
  -Body $body
```

The response contains `messagePublicId` and `taskPublicId`.

2. In the web app, open the group. The Action message must render one task card with status
   `open`, the flag type, and the task ID.
3. As a second active member of the group, claim the task. Verify `status: "claimed"` and the
   claimant's name on the card.
4. Mark it done as the claimant. Verify `status: "done"`; a different member cannot mark done for
   the claimant.
5. Open the audit panel. Verify one typed event per transition: created, claimed, done, with
   actor and timestamp.
6. Verify the API view:

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "https://benevolent-crocodile-386.convex.site/v1/tasks?externalRef=PILOT-TASK-001" `
  -Headers @{ Authorization = "Bearer tc_live_REPLACE_ME" }
```

Expected: the task is listed with its current status and the original `externalRef`. This is why
`messages.by_org_external` is retained; the API resolves external references through it.

7. As a group manager, close or archive the task. Verify the audit row and that an Action message
   cannot be edited or soft-deleted once its task has left `open`.

---

## 8. Confirm the usage rollup and the cost tile, then know the rollback

### 8.1 Usage rollup

The only writer of `usageRollups` is the daily cron at 00:20 UTC, one row per organisation per
day. There is no per-message counter and no hot per-group cost document.

For an immediate pilot check, run the same daily action manually:

```powershell
npx convex run usage:rollupAllNow '{}' --deployment benevolent-crocodile-386 --typecheck disable
```

Then open the admin cost tile in the web app. It must show:

- the measured day for the organisation;
- messages per active sender per day;
- active senders;
- group count and group-size buckets;
- the projected monthly cost with the label `Estimate — model, not a bill`;
- the platform alert level if projected total across active orgs is at or above 70% of the
  $1,000 ceiling.

The alert is computed from the projected total across active organisations, not from actual spend
and not from org count. It is surfaced in the admin UI and written to the deployment log. It does
not depend on email. Org count is a proxy for onboarding, not a hard gate; the onboarding gate
projects the candidate org's spend and refuses if the total would cross the ceiling.

### 8.2 Rollback

Rollback is a code and environment operation, not a data operation.

Preferred, with the repository:

```powershell
cd C:\workspace\TeamChat
git log --oneline -5
git revert <bad-commit>
cd app
npm run deploy:prod
npm run guard:prod
```

If the previous build is still available in the Convex dashboard, use the deployment's history /
rollback control to restore that build, then run `npm run guard:prod` again. Dashboard rollback
does not restore data or environment variables.

After a rollback:

1. Confirm `buildInfo` returns `channel=production`, `echoOtp=false`.
2. Confirm real sign-in still works for one owner account (SendGrid key unchanged).
3. Do not import an old data snapshot over a live pilot unless the incident commander explicitly
   accepts the message loss. Prefer a forward fix.
4. If a bad storage credential or webhook secret was written, rotate at the source and re-enter
   the credential/secret; rolling back code does not re-encrypt it.

Data backup and region-move procedures are in `OPERATIONS.md` §2–§3.
