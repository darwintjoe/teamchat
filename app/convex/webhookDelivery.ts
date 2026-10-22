"use node";

// Outbound delivery. Node runtime only because registration and every attempt must resolve the
// hostname and reject private/loopback/link-local/metadata addresses. Resolution happens again
// before EVERY attempt, and the connection is pinned to the validated address through a custom
// `lookup`, so a DNS rebind between check and connect cannot redirect the POST.
//
// No redirects are followed: a 3xx is a failed attempt.

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { createHmac } from "node:crypto";

export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000] as const;
export const MAX_ATTEMPTS = 4; // initial + 3 retries, then dead-letter
export const DELIVERY_TIMEOUT_MS = 10_000;

type Resolved = { address: string; family: number };

/** `attemptNumber` is the 1-based attempt that just failed. */
function retryDelayFor(attemptNumber: number): number | undefined {
  return attemptNumber < MAX_ATTEMPTS ? RETRY_DELAYS_MS[attemptNumber - 1] : undefined;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv4IsPrivate(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // this network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function ipv6IsPrivate(raw: string): boolean {
  const address = raw.toLowerCase().split("%")[0];
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true; // unique local fc00::/7
  if (address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (address.startsWith("ff")) return true; // multicast
  if (address.startsWith("2001:db8")) return true; // documentation
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null) return ipv4IsPrivate(mapped[1]);
  return false;
}

export function addressIsPrivate(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4IsPrivate(address);
  if (family === 6) return ipv6IsPrivate(address);
  return true;
}

async function resolveSafe(hostname: string): Promise<Resolved[]> {
  const host = stripBrackets(hostname);
  let rows: Resolved[];
  if (isIP(host) !== 0) {
    rows = [{ address: host, family: isIP(host) }];
  } else {
    rows = (await lookup(host, { all: true, verbatim: true })) as Resolved[];
  }
  if (rows.length === 0) throw new Error("Webhook host did not resolve");
  const bad = rows.find((row) => addressIsPrivate(row.address));
  if (bad !== undefined) {
    throw new Error("Webhook host resolves to a private, loopback, link-local or metadata address");
  }
  return rows;
}

function parseHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Webhook URLs must use https");
  if (url.username !== "" || url.password !== "") {
    throw new Error("Webhook URLs must not carry credentials");
  }
  if (url.hostname === "") throw new Error("Webhook URL has no host");
  return url;
}

export const validateUrl = internalAction({
  args: { url: v.string() },
  handler: async (_ctx, args): Promise<{ url: string; addresses: string[] }> => {
    const url = parseHttpsUrl(args.url.trim());
    const resolved = await resolveSafe(url.hostname);
    return { url: url.toString(), addresses: resolved.map((row) => row.address) };
  },
});

function postOnce(
  url: URL,
  pinned: Resolved,
  body: string,
  signature: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: stripBrackets(url.hostname),
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        servername: stripBrackets(url.hostname),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-TeamChat-Signature": signature,
          "User-Agent": "TeamChat-Webhooks/1.0",
        },
        // The connection target is the address validated immediately above.
        lookup: (_hostname, _options, callback) => {
          callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > 8_192) request.destroy();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    request.setTimeout(DELIVERY_TIMEOUT_MS, () => {
      request.destroy(new Error("Webhook request timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

export const deliver = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  // Explicit return type breaks a generated-API type cycle with `webhooks.recordAttempt`.
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const context = await ctx.runQuery(internal.webhooks.deliveryContext, {
      deliveryId: args.deliveryId,
    });
    if (context === null) return { skipped: "missing" as const };
    if (context.delivery.status !== "pending") return { skipped: "not_pending" as const };
    if (!context.webhook.isActive) {
      await ctx.runMutation(internal.webhooks.recordAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Webhook is disabled",
      });
      return { skipped: "inactive" as const };
    }
    if (context.secret === null) {
      await ctx.runMutation(internal.webhooks.recordAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Webhook has no signing secret",
      });
      return { skipped: "no_secret" as const };
    }

    let url: URL;
    let resolved: Resolved[];
    try {
      url = parseHttpsUrl(context.webhook.url);
      resolved = await resolveSafe(url.hostname);
    } catch (error) {
      // A delivery-time private-address hit is a retryable failure, not a permanent one: DNS may
      // change back, and the retry ladder is what eventually dead-letters a rebinding endpoint.
      const result = await ctx.runMutation(internal.webhooks.recordAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: error instanceof Error ? error.message : "Webhook URL check failed",
        retryDelayMs: retryDelayFor(context.delivery.attempts + 1),
      });
      return {
        delivered: false,
        error: "url_check" as const,
        attempts: result?.attempts ?? null,
        nextAttemptAt: result?.nextAttemptAt ?? null,
        serverNow: result?.now ?? null,
      };
    }

    let secret: string;
    try {
      const { decryptSecret } = await import("./lib/crypto");
      secret = await decryptSecret(context.secret.ciphertext, context.secret.keyVersion);
    } catch {
      await ctx.runMutation(internal.webhooks.recordAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Webhook signing secret could not be decrypted",
        retryDelayMs: retryDelayFor(context.delivery.attempts + 1),
      });
      return { delivered: false, error: "secret" as const };
    }

    const body = JSON.stringify(context.delivery.payload);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    let status = 0;
    let failure: string | null = null;
    try {
      const response = await postOnce(url, resolved[0], body, signature);
      status = response.status;
      if (status < 200 || status >= 300) failure = `Endpoint returned HTTP ${status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : "Webhook request failed";
    }

    if (failure === null) {
      const result = await ctx.runMutation(internal.webhooks.recordAttempt, {
        deliveryId: args.deliveryId,
        ok: true,
      });
      return { delivered: true, status, attempts: result?.attempts ?? null };
    }

    const nextAttemptNumber = context.delivery.attempts + 1;
    const retryDelayMs = retryDelayFor(nextAttemptNumber);
    const result = await ctx.runMutation(internal.webhooks.recordAttempt, {
      deliveryId: args.deliveryId,
      ok: false,
      error: failure,
      retryDelayMs,
    });
    return {
      delivered: false,
      status,
      attempts: result?.attempts ?? null,
      retryDelayMs: retryDelayMs ?? null,
      nextAttemptAt: result?.nextAttemptAt ?? null,
      serverNow: result?.now ?? null,
    };
  },
});

/** Cron drain: every due pending row is attempted once. */
export const drainDue = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ due: number; attempted: number }> => {
    const ids = await ctx.runQuery(internal.webhooks.dueDeliveries, { limit: args.limit });
    let attempted = 0;
    for (const deliveryId of ids) {
      await ctx.runAction(internal.webhookDelivery.deliver, { deliveryId });
      attempted++;
    }
    return { due: ids.length, attempted };
  },
});
