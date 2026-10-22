// S3-compatible adapter via aws4fetch (SigV4). Works against AWS S3 and MinIO.
//
// No bytes pass through TeamChat: the client POSTs a multipart form to a pre-signed policy,
// promotion is an S3-side CopyObject, and reads are short-lived pre-signed GETs.
//
// The upload ticket is a SigV4 POST policy with an exact key, an exact Content-Type, and a
// `content-length-range` condition bounding the object at the declared size (never above the
// 25 MB hard limit). S3 enforces the policy before it writes the object. The ticket still
// refuses oversized/disallowed intents, and confirm re-checks the real object with a HEAD before
// anything becomes reachable.

import { AwsClient } from "aws4fetch";
import { MAX_FILE_BYTES } from "../lib/limits";
import { OrgStorageTarget, StorageAdapter } from "./adapter";

export const UPLOAD_TICKET_SECONDS = 15 * 60;
export const READ_TICKET_SECONDS = 5 * 60;

function objectUrl(target: OrgStorageTarget, key: string): string {
  const base = target.endpoint.replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${encodeURIComponent(target.bucket)}/${encodedKey}`;
}

function awsClient(target: OrgStorageTarget): AwsClient {
  return new AwsClient({
    accessKeyId: target.credentials.accessKeyId,
    secretAccessKey: target.credentials.secretAccessKey,
    sessionToken: target.credentials.sessionToken,
    service: "s3",
    region: target.region,
    retries: 0,
  });
}

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** UTF-8 base64 without depending on `btoa` being present in the Convex runtime. */
function base64(value: string): string {
  const bytes = encoder.encode(value);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c & 0x3f] : "=";
  }
  return out;
}

export const s3Adapter: StorageAdapter = {
  name: "s3",
  supports: { upload: true, confirm: true, read: true },

  async requestUpload({ target, key, contentType, expiresInSeconds, maxBytes }) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;
    const credential = `${target.credentials.accessKeyId}/${credentialScope}`;
    const expiration = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
    const boundedMax = Math.max(1, Math.min(Math.floor(maxBytes), MAX_FILE_BYTES));

    const conditions: Array<Record<string, string> | [string, ...unknown[]]> = [
      { bucket: target.bucket },
      { key },
      { "Content-Type": contentType },
      { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
      { "x-amz-credential": credential },
      { "x-amz-date": amzDate },
      ["content-length-range", 1, boundedMax],
    ];
    if (target.credentials.sessionToken !== undefined) {
      conditions.push({ "x-amz-security-token": target.credentials.sessionToken });
    }

    const policy = base64(
      JSON.stringify({ expiration, conditions }),
    );
    const kDate = await hmac(`AWS4${target.credentials.secretAccessKey}`, dateStamp);
    const kRegion = await hmac(kDate, target.region);
    const kService = await hmac(kRegion, "s3");
    const kSigning = await hmac(kService, "aws4_request");
    const signature = toHex(await hmac(kSigning, policy));

    const fields: Record<string, string> = {
      key,
      "Content-Type": contentType,
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": credential,
      "x-amz-date": amzDate,
      policy,
      "x-amz-signature": signature,
    };
    if (target.credentials.sessionToken !== undefined) {
      fields["x-amz-security-token"] = target.credentials.sessionToken;
    }

    const uploadUrl = `${target.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(target.bucket)}`;
    return {
      url: uploadUrl,
      method: "POST",
      fields,
      expiresAt: now.getTime() + expiresInSeconds * 1000,
    };
  },

  async headObject({ target, key }) {
    const response = await awsClient(target).fetch(objectUrl(target, key), { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HEAD ${key} failed with ${response.status}: ${await response.text()}`);
    }
    const size = Number(response.headers.get("content-length") ?? "0");
    return { size, contentType: response.headers.get("content-type") };
  },

  async promoteObject({ target, fromKey, toKey }) {
    // S3-side CopyObject: the bucket moves the object; TeamChat never sees the bytes.
    const copy = await awsClient(target).fetch(objectUrl(target, toKey), {
      method: "PUT",
      headers: { "x-amz-copy-source": `/${target.bucket}/${fromKey}` },
    });
    if (!copy.ok) {
      throw new Error(
        `Promoting ${fromKey} failed with ${copy.status}: ${await copy.text()}`,
      );
    }
    const del = await awsClient(target).fetch(objectUrl(target, fromKey), { method: "DELETE" });
    if (!del.ok && del.status !== 404) {
      throw new Error(`Removing pending object ${fromKey} failed with ${del.status}`);
    }
  },

  async requestRead({ target, key, expiresInSeconds }) {
    const url = new URL(objectUrl(target, key));
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    const signed = await awsClient(target).sign(url.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    return { url: signed.url, expiresAt: Date.now() + expiresInSeconds * 1000 };
  },

  async deleteObject({ target, key }) {
    const response = await awsClient(target).fetch(objectUrl(target, key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE ${key} failed with ${response.status}`);
    }
  },
};
