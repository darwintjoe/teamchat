import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const required = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN_A",
  "GOOGLE_REFRESH_TOKEN_B",
  "GOOGLE_ACCOUNT_B_EMAIL",
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log(
    JSON.stringify(
      {
        test: "S7",
        status: "BLOCKED",
        missing,
        needed:
          "Google Cloud project, OAuth client (Desktop app), consent screen in Testing with the drive.file scope, two test Google accounts A and B, and refresh tokens for both.",
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ACCOUNT_B = process.env.GOOGLE_ACCOUNT_B_EMAIL;

async function getAccessToken(refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token refresh failed (${response.status}): ${text}`);
  }
  return JSON.parse(text).access_token;
}

async function drive(token, path, init = {}) {
  const response = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: response.status, ok: response.ok, body };
}

async function createFile(token, name, mimeType) {
  return drive(token, "/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType }),
  });
}

async function uploadContent(token, fileId, bytes, mimeType) {
  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
      body: bytes,
    },
  );
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: response.status, ok: response.ok, body };
}

async function share(token, fileId, permission) {
  return drive(token, `/files/${fileId}/permissions?sendNotificationEmail=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(permission),
  });
}

async function readMetadata(token, fileId) {
  return drive(
    token,
    `/files/${fileId}?fields=id,name,mimeType,size,owners(emailAddress),capabilities(canDownload)`,
  );
}

async function download(token, fileId) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    return {
      status: response.status,
      ok: false,
      body: await response.text(),
    };
  }
  return {
    status: response.status,
    ok: true,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

async function uploadFile(token, name, bytes, mimeType) {
  const metadata = await createFile(token, name, mimeType);
  if (!metadata.ok) return { metadata, content: null, fileId: null };
  const content = await uploadContent(token, metadata.body.id, bytes, mimeType);
  return { metadata, content, fileId: metadata.body.id };
}

async function copyToRecipient(tokenB, sourceName, bytes, mimeType) {
  return uploadFile(tokenB, `copy-of-${sourceName}`, bytes, mimeType);
}

const results = { test: "S7", startedAt: new Date().toISOString(), routes: {} };
const tokenA = await getAccessToken(process.env.GOOGLE_REFRESH_TOKEN_A);
const tokenB = await getAccessToken(process.env.GOOGLE_REFRESH_TOKEN_B);

const testFiles = [
  { name: "teamchat-s7-small.bin", bytes: randomBytes(64 * 1024) },
  { name: "teamchat-s7-large.bin", bytes: randomBytes(5 * 1024 * 1024) },
];

// Route (a): A shares to B's Google account; B's drive.file app reads and copies.
results.routes.a = [];
for (const file of testFiles) {
  const uploaded = await uploadFile(
    tokenA,
    file.name,
    file.bytes,
    "application/octet-stream",
  );
  const shared = uploaded.fileId
    ? await share(tokenA, uploaded.fileId, {
        role: "reader",
        type: "user",
        emailAddress: ACCOUNT_B,
      })
    : null;
  const metadata = uploaded.fileId
    ? await readMetadata(tokenB, uploaded.fileId)
    : null;
  const downloaded =
    metadata?.ok === true ? await download(tokenB, uploaded.fileId) : null;
  const copied =
    downloaded?.ok === true
      ? await copyToRecipient(
          tokenB,
          file.name,
          downloaded.body,
          "application/octet-stream",
        )
      : null;
  results.routes.a.push({
    file: file.name,
    sizeBytes: file.bytes.length,
    upload: { status: uploaded.metadata.status, fileId: uploaded.fileId },
    share: shared ? { status: shared.status, body: shared.body } : null,
    read: metadata ? { status: metadata.status, body: metadata.body } : null,
    download: downloaded
      ? {
          status: downloaded.status,
          error: downloaded.ok ? null : downloaded.body,
        }
      : null,
    copy: copied
      ? {
          status: copied.metadata.ok ? "copied" : "failed",
          fileId: copied.fileId,
          error: copied.metadata.ok ? null : copied.metadata.body,
        }
      : null,
  });
}

// Route (c): link-sharing read.
results.routes.c = [];
for (const file of testFiles) {
  const uploaded = await uploadFile(
    tokenA,
    `link-${file.name}`,
    file.bytes,
    "application/octet-stream",
  );
  const shared = uploaded.fileId
    ? await share(tokenA, uploaded.fileId, { role: "reader", type: "anyone" })
    : null;
  const metadata = uploaded.fileId
    ? await readMetadata(tokenB, uploaded.fileId)
    : null;
  const downloaded =
    metadata?.ok === true ? await download(tokenB, uploaded.fileId) : null;
  const copied =
    downloaded?.ok === true
      ? await copyToRecipient(
          tokenB,
          `link-${file.name}`,
          downloaded.body,
          "application/octet-stream",
        )
      : null;
  results.routes.c.push({
    file: file.name,
    upload: { status: uploaded.metadata.status, fileId: uploaded.fileId },
    share: shared ? { status: shared.status, body: shared.body } : null,
    read: metadata ? { status: metadata.status, body: metadata.body } : null,
    download: downloaded
      ? { status: downloaded.status, error: downloaded.ok ? null : downloaded.body }
      : null,
    copy: copied
      ? {
          status: copied.metadata.ok ? "copied" : "failed",
          fileId: copied.fileId,
          error: copied.metadata.ok ? null : copied.metadata.body,
        }
      : null,
  });
}

// Route (b): Google Picker — interactive, cannot be automated from a CLI.
results.routes.b = {
  status: "MANUAL-REQUIRED",
  instructions:
    "With account B in a browser, open the Google Picker using the same OAuth client and the drive.file scope, select the file IDs listed in routes.a, then re-run this script to record whether B's app can read and copy them.",
  fileIds: results.routes.a.map((entry) => entry.upload?.fileId ?? null),
};

results.finishedAt = new Date().toISOString();
results.pass =
  results.routes.a.every((entry) => entry.copy?.status === "copied") &&
  results.routes.c.every((entry) => entry.copy?.status === "copied");
results.verdict = results.pass
  ? "PASS (routes a and c automated; route b pending manual step)"
  : "FAIL or inconclusive — see per-route errors";

const outputPath = new URL(
  `./results-${Date.now()}.json`,
  import.meta.url,
);
writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ outputPath: outputPath.pathname, ...results }, null, 2));
