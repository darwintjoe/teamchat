# S7 — Google Drive copy-on-open spike (BLOCKED, harness scaffolded)

**Question (PRD v1.4, §F S7):** can a recipient's phone fetch a file from the sender's Drive
and save it into their own Drive using only the non-sensitive `drive.file` scope, with no bytes
through TeamChat?

**Status: BLOCKED.** No Google Cloud project, OAuth client, or test Google accounts are
available in this environment.

## What is needed to run it

| Need | Why |
|---|---|
| A Google Cloud project | Owns the OAuth client and consent screen. |
| OAuth consent screen in **Testing**, scope `drive.file` only | The spike must prove the non-sensitive scope is enough. |
| Two test Google accounts, A (sender) and B (recipient) | The whole question is whether B can copy A's file. |
| A browser session for each account | Consent + the Google Picker route (b) are interactive. |
| A local loopback OAuth client (Desktop app) | Produces refresh tokens for A and B. |

Environment variables the harness reads:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN_A
GOOGLE_REFRESH_TOKEN_B
GOOGLE_ACCOUNT_B_EMAIL
```

## Routes to record

| Route | How | Automated? |
|---|---|---|
| (a) A shares to B's Google account, B's app reads and copies | A creates a `reader` permission for B's email; B calls `files.get` and `files.get?alt=media`, then re-uploads a copy into B's Drive | yes |
| (b) B opens through the Google Picker | Interactive: B opens the Picker with the OAuth client, picks A's file, app then reads and copies | **no — manual step**, the harness prints the file IDs and instructions |
| (c) link-sharing read | A adds an `anyone` reader permission; B reads and copies | yes |

## Pass / fail (from the PRD)

- **Pass:** B ends with an own copy, no TeamChat byte relay, at most one extra consent step.
- **Fail:** keep the S3-compatible adapter and report to Darwin.

## How to run

```powershell
cd app
node probes/s7/check-prereqs.mjs
node probes/s7/drive-spike.mjs
```

`drive-spike.mjs` exits with code 2 and prints a `BLOCKED` JSON object when any prerequisite is
missing. When it runs, it writes `probes/s7/results-<timestamp>.json` with the raw responses.
