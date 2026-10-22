import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("CONVEX_URL is not set");
const groupId = process.env.S2_GROUP_ID;
const senderId = process.env.S2_SENDER_ID;
if (!groupId || !senderId) {
  throw new Error("S2_GROUP_ID and S2_SENDER_ID must be set");
}

const client = new ConvexHttpClient(url);
const before = await client.query(api.probes.s2Snapshot, { groupId, senderId });
const runId = `run-${Date.now()}`;
const started = performance.now();
const results = await Promise.allSettled(
  Array.from({ length: 50 }, (_, seq) =>
    client.mutation(api.probes.probeSendMessage, {
      groupId,
      senderId,
      runId,
      seq,
    }),
  ),
);
const elapsedMs = performance.now() - started;
const after = await client.query(api.probes.s2Snapshot, { groupId, senderId });

const fulfilled = results.filter((r) => r.status === "fulfilled").length;
const rejected = results
  .filter((r) => r.status === "rejected")
  .map((r) => String(r.reason));

console.log(
  JSON.stringify(
    {
      runId,
      elapsedMs: Math.round(elapsedMs),
      attempted: results.length,
      fulfilled,
      rejectedCount: rejected.length,
      rejected,
      before: {
        messageCount: before.messageCount,
        groupActivity: before.groupActivity,
        membership: before.membership.map((m) => ({
          id: m._id,
          lastReadAt: m.lastReadAt ?? null,
          lastReadMessageId: m.lastReadMessageId ?? null,
        })),
        group: before.group,
      },
      after: {
        messageCount: after.messageCount,
        groupActivity: after.groupActivity,
        membership: after.membership.map((m) => ({
          id: m._id,
          lastReadAt: m.lastReadAt ?? null,
          lastReadMessageId: m.lastReadMessageId ?? null,
        })),
        group: after.group,
      },
    },
    null,
    2,
  ),
);
