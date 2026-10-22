// End-to-end verification of Action mode + the Action Inbox against the dev deployment.
//
//   node scripts/verify-action-inbox.mjs
//
// Covers PRD v1.4 Part 1 §2/§4 and the build's required test list: concurrent claims, every claim
// refusal, ancestor-manager oversight, separation of duties, forward/reassign events, DM lifecycle,
// rollup descendants/DM exclusion, archived/hidden behaviour, edit/delete refusal, and exactly one
// typed event per transition. Administrative state changes and raw task probes go through
// `convex/testing.ts` with the Convex CLI, because those functions are internal-only.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  appDir,
  deploymentUrl,
  loadAuthCache,
  saveAuthCache,
  signInFresh,
} from "./lib/harness.mjs";

const url = deploymentUrl();
const authCachePath = join(appDir, ".storage", "action-verify-auth.json");
const authCache = loadAuthCache(authCachePath) ?? {};
const convexBin = join(appDir, "node_modules", "convex", "bin", "main.js");

// ------------------------------------------------------------------ tiny harness

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

async function expectError(fn, matcher) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    if (matcher !== undefined) {
      const text = `${error.message} ${JSON.stringify(error.data ?? "")}`;
      if (!text.toLowerCase().includes(matcher.toLowerCase())) {
        throw new Error(`expected ${JSON.stringify(matcher)}, got: ${error.message}`);
      }
    }
    return error;
  }
  throw new Error(`expected an error, but the call succeeded: ${JSON.stringify(result)?.slice(0, 200)}`);
}

function runInternal(name, args) {
  const raw = execFileSync(
    process.execPath,
    [convexBin, "run", `testing:${name}`, JSON.stringify(args), "--typecheck", "disable"],
    { cwd: appDir, encoding: "utf8" },
  ).replace(/\u001b\[[0-9;]*m/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`testing:${name} returned no JSON: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function clientFor(email, key) {
  const cached = authCache[key];
  if (cached?.token) {
    const client = new ConvexHttpClient(url);
    client.setAuth(cached.token);
    try {
      const me = await client.query(api.users.me, {});
      return { client, me, token: cached.token };
    } catch {
      // expired cache — fall through to a fresh OTP
    }
  }
  const client = new ConvexHttpClient(url);
  const tokens = await signInFresh(client, email);
  const me = await client.query(api.users.me, {});
  authCache[key] = { token: tokens.token };
  saveAuthCache(authCachePath, authCache);
  return { client, me, token: tokens.token };
}

const runId = `${Date.now().toString(36)}`;
const email = (name) => `action.verify.${name}@demo.teamchat.test`;

console.log(`deployment: ${url}`);
console.log(`run id:     ${runId}\n`);

// ------------------------------------------------------------------ people and groups

const alice = await clientFor(email("alice"), "alice");
const bob = await clientFor(email("bob"), "bob");
const carol = await clientFor(email("carol"), "carol");
const dave = await clientFor(email("dave"), "dave");
const erin = await clientFor(email("erin"), "erin");

const aliceId = alice.me.publicId;
const bobId = bob.me.publicId;
const carolId = carol.me.publicId;
const daveId = dave.me.publicId;

const org = await alice.client.mutation(api.organizations.create, {
  name: `Action verify ${runId}`,
  allowDirectMessages: true,
});
const orgPublicId = org.orgPublicId;
const rootPublicId = org.rootGroupPublicId;

for (const [client, key] of [
  [bob.client, "bob"],
  [carol.client, "carol"],
  [dave.client, "dave"],
]) {
  const invite = await alice.client.mutation(api.invites.create, { orgPublicId });
  const joined = await client.action(api.invites.redeem, { token: invite.token });
  assert(joined.orgPublicId === orgPublicId, `${key} joined the wrong org`);
}

const workers = await alice.client.mutation(api.groups.create, {
  orgPublicId,
  name: "Workers",
  memberPublicIds: [bobId, carolId, daveId],
});
const solo = await alice.client.mutation(api.groups.create, {
  orgPublicId,
  name: "Solo",
});
const workersConversation = { kind: "group", publicId: workers.groupPublicId };
const soloConversation = { kind: "group", publicId: solo.groupPublicId };

// Bob is a manager at the org root but not a member of `Solo`. That is exactly the CR-10
// "oversight, not ownership" position.
runInternal("setMembershipRole", {
  groupPublicId: rootPublicId,
  userPublicId: bobId,
  role: "manager",
});

const clientsByPublicId = new Map([
  [aliceId, alice.client],
  [bobId, bob.client],
  [carolId, carol.client],
  [daveId, dave.client],
]);

async function sendAction(client, conversation, text, extra = {}) {
  return await client.mutation(api.messages.send, {
    conversation,
    text,
    mode: "action",
    ...extra,
  });
}

async function probe(messagePublicId) {
  return runInternal("actionProbeState", { messagePublicId });
}

function taskCardFor(live, messagePublicId) {
  const message = live.find((row) => row.publicId === messagePublicId);
  assert(message !== undefined, `message ${messagePublicId} missing from live page`);
  assert(message.task !== null, `message ${messagePublicId} has no task card`);
  return message.task;
}

// ------------------------------------------------------------------ creation

const created = {};

await check("A1 action send creates exactly one task in the same mutation", async () => {
  const sent = await sendAction(alice.client, workersConversation, "task one");
  created.one = sent;
  assert(sent.mode === "action", `mode=${sent.mode}`);
  assert(typeof sent.taskPublicId === "string" && sent.taskPublicId.startsWith("task_"), "no task id");
  const counts = runInternal("actionMessageCounts", { messagePublicId: sent.messagePublicId });
  assert(counts.taskCount === 1, `taskCount=${counts.taskCount}`);
  assert(counts.eventCount === 0, `eventCount=${counts.eventCount}`);
  const state = await probe(sent.messagePublicId);
  assert(state.task.status === "open", `status=${state.task.status}`);
  assert(state.task.senderMayClose === true, "app action did not materialise senderMayClose");
  assert(state.task.flagType === "task", `flagType=${state.task.flagType}`);
  assert(state.task.groupPath === workers.path, `groupPath=${state.task.groupPath}`);
  return `${sent.taskPublicId} open, one task, zero events`;
});

await check("A1b discussion mode creates no task; flagType is action-only", async () => {
  const discussion = await alice.client.mutation(api.messages.send, {
    conversation: workersConversation,
    text: "discussion only",
  });
  assert(discussion.mode === "discussion", `mode=${discussion.mode}`);
  assert(discussion.taskPublicId === null, "discussion created a task");
  const counts = runInternal("actionMessageCounts", { messagePublicId: discussion.messagePublicId });
  assert(counts.taskCount === 0, `taskCount=${counts.taskCount}`);
  await expectError(
    () =>
      alice.client.mutation(api.messages.send, {
        conversation: workersConversation,
        text: "not an action",
        flagType: "approval",
      }),
    "only valid on an action message",
  );
  const approval = await sendAction(alice.client, workersConversation, "approval task", {
    flagType: "approval",
  });
  const state = await probe(approval.messagePublicId);
  assert(state.task.flagType === "approval", `flagType=${state.task.flagType}`);
  return "discussion has no task; approval flag persisted";
});

await check("A2 rendered message carries the viewer's task card", async () => {
  const live = await bob.client.query(api.messages.listLive, { conversation: workersConversation });
  const card = taskCardFor(live, created.one.messagePublicId);
  assert(card.publicId === created.one.taskPublicId, "card publicId mismatch");
  assert(card.status === "open", `status=${card.status}`);
  assert(card.viewer.canClaim === true, "exact member cannot claim");
  assert(card.claimedByPublicId === null, "claimedBy set on open task");
  return "card status open, canClaim=true for an exact member";
});

await check("A3 senderMayClose is materialised, not re-derived", async () => {
  const sent = await sendAction(dave.client, workersConversation, "dave materialisation task");
  created.materialised = sent;
  const before = await probe(sent.messagePublicId);
  assert(before.task.senderMayClose === true, "senderMayClose=false at creation");
  runInternal("setUserAccountState", { userPublicId: daveId, accountState: "provisioned" });
  try {
    const after = await probe(sent.messagePublicId);
    assert(after.task.senderMayClose === true, "senderMayClose changed after account change");
  } finally {
    runInternal("setUserAccountState", { userPublicId: daveId, accountState: "active" });
  }
  return "stored true before and after the sender became provisioned";
});

// ------------------------------------------------------------------ claim refusals

await check("C1 non-member cannot claim", async () => {
  await expectError(
    () => erin.client.mutation(api.actionInbox.claim, { taskPublicId: created.one.taskPublicId }),
    "Only a member",
  );
  return "non-member refused";
});

await check("C2 shadow, bot and provisioned accounts cannot claim", async () => {
  for (const state of ["shadow", "bot", "provisioned"]) {
    runInternal("setUserAccountState", { userPublicId: daveId, accountState: state });
    try {
      await expectError(
        () => dave.client.mutation(api.actionInbox.claim, { taskPublicId: created.one.taskPublicId }),
        state,
      );
    } finally {
      runInternal("setUserAccountState", { userPublicId: daveId, accountState: "active" });
    }
  }
  return "shadow, bot, provisioned refused";
});

await check("C3 ancestor manager may close but may not claim", async () => {
  const sent = await sendAction(alice.client, soloConversation, "solo oversight task");
  created.solo = sent;
  await expectError(
    () => bob.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId }),
    "Only a member",
  );
  const closed = await bob.client.mutation(api.actionInbox.close, { taskPublicId: sent.taskPublicId });
  assert(closed.status === "closed", `status=${closed.status}`);
  const state = await probe(sent.messagePublicId);
  assert(state.task.closedByPublicId === bobId, `closedBy=${state.task.closedByPublicId}`);
  assert(state.task.claimedByPublicId === null, "ancestor manager claimed while closing");
  assert(state.events.length === 1 && state.events[0].action === "closed", "expected one closed event");
  assert(state.events[0].selfClosed === false, "selfClosed on an unclaimed task");
  return "claim refused, close succeeded, selfClosed=false";
});

await check("C4 concurrent claims produce exactly one winner and one event", async () => {
  const sent = await sendAction(alice.client, workersConversation, "concurrent claim task");
  created.concurrent = sent;
  const contenders = [alice, bob, carol, dave];
  const results = await Promise.all(
    contenders.map(async (person) => {
      try {
        await person.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId });
        return { publicId: person.me.publicId, ok: true };
      } catch (error) {
        return { publicId: person.me.publicId, ok: false, message: error.message };
      }
    }),
  );
  const winners = results.filter((row) => row.ok);
  assert(winners.length === 1, `winners=${winners.map((row) => row.publicId).join(",")}`);
  const state = await probe(sent.messagePublicId);
  assert(state.task.status === "claimed", `status=${state.task.status}`);
  assert(state.task.claimedByPublicId === winners[0].publicId, "claimedBy is not the winner");
  assert(state.eventCount === 1 && state.events[0].action === "claimed", `events=${state.eventCount}`);
  assert(state.events[0].actorPublicId === winners[0].publicId, "claimed event actor mismatch");
  return `winner=${winners[0].publicId}, 7 refused, one claimed event`;
});

await check("C5 claim refuses claimed, done, closed and archived tasks", async () => {
  const oneState = await probe(created.one.messagePublicId);
  assert(oneState.task.status === "open", "fixture task one is no longer open");
  await bob.client.mutation(api.actionInbox.claim, { taskPublicId: created.one.taskPublicId });
  await expectError(
    () => carol.client.mutation(api.actionInbox.claim, { taskPublicId: created.one.taskPublicId }),
    "only an open task can be claimed",
  );
  await bob.client.mutation(api.actionInbox.markDone, { taskPublicId: created.one.taskPublicId });
  await expectError(
    () => carol.client.mutation(api.actionInbox.claim, { taskPublicId: created.one.taskPublicId }),
    "only an open task can be claimed",
  );
  await alice.client.mutation(api.actionInbox.close, { taskPublicId: created.one.taskPublicId });
  await expectError(
    () => carol.client.mutation(api.actionInbox.claim, { taskPublicId: created.one.taskPublicId }),
    "only an open task can be claimed",
  );

  const archived = await sendAction(alice.client, workersConversation, "archive then claim");
  created.archived = archived;
  await alice.client.mutation(api.actionInbox.archive, { taskPublicId: archived.taskPublicId });
  await expectError(
    () => carol.client.mutation(api.actionInbox.claim, { taskPublicId: archived.taskPublicId }),
    "only an open task can be claimed",
  );
  return "claimed, done, closed, archived all refused";
});

// ------------------------------------------------------------------ done / close / reopen

await check("T1 separation of duties refuses a claimant with another eligible closer", async () => {
  const sent = await sendAction(alice.client, workersConversation, "separation task");
  created.separation = sent;
  await bob.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId });
  await expectError(
    () => bob.client.mutation(api.actionInbox.close, { taskPublicId: sent.taskPublicId }),
    "Another eligible closer exists",
  );
  const closed = await alice.client.mutation(api.actionInbox.close, { taskPublicId: sent.taskPublicId });
  assert(closed.status === "closed" && closed.selfClosed === false, JSON.stringify(closed));
  const state = await probe(sent.messagePublicId);
  assert(state.task.closedByPublicId === aliceId, "sender did not close");
  return "claimant refused; sender closed with selfClosed=false";
});

await check("T2 self-close is permitted only when the assignee is the sole eligible closer", async () => {
  const selfOrg = await alice.client.mutation(api.organizations.create, {
    name: `Self close ${runId}`,
    allowDirectMessages: false,
  });
  const selfGroup = await alice.client.mutation(api.groups.create, {
    orgPublicId: selfOrg.orgPublicId,
    name: "One person",
  });
  const sent = await sendAction(
    alice.client,
    { kind: "group", publicId: selfGroup.groupPublicId },
    "single person task",
  );
  await alice.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId });
  const closed = await alice.client.mutation(api.actionInbox.close, { taskPublicId: sent.taskPublicId });
  assert(closed.status === "closed" && closed.selfClosed === true, JSON.stringify(closed));
  const state = await probe(sent.messagePublicId);
  const event = state.events.find((row) => row.action === "closed");
  assert(event !== undefined && event.selfClosed === true, "audit did not record selfClosed");
  return "sole-closer claim closed itself and recorded selfClosed=true";
});

await check("T3 reopen returns a done task to the same claimant", async () => {
  const holder = (await probe(created.concurrent.messagePublicId)).task.claimedByPublicId;
  await clientsByPublicId.get(holder).mutation(api.actionInbox.markDone, {
    taskPublicId: created.concurrent.taskPublicId,
  });
  await expectError(
    () =>
      alice.client.mutation(api.actionInbox.reassign, {
        taskPublicId: created.concurrent.taskPublicId,
        toUserPublicId: aliceId === holder ? bobId : aliceId,
      }),
    "reopened, not reassigned",
  );
  const reopened = await alice.client.mutation(api.actionInbox.reopen, {
    taskPublicId: created.concurrent.taskPublicId,
  });
  assert(reopened.status === "claimed", `status=${reopened.status}`);
  assert(reopened.claimedByPublicId === holder, `claimant changed to ${reopened.claimedByPublicId}`);
  const state = await probe(created.concurrent.messagePublicId);
  const event = state.events[state.events.length - 1];
  assert(event.action === "reopened" && event.reason === "sender_review", JSON.stringify(event));
  return `reopened to ${holder}, reason sender_review`;
});

await check("T4 exactly one typed event per transition", async () => {
  const state = await probe(created.concurrent.messagePublicId);
  assert(state.events.length === 3, `events=${state.events.map((row) => row.action).join(",")}`);
  assert(
    state.events.map((row) => row.action).join(",") === "claimed,done,reopened",
    `sequence=${state.events.map((row) => row.action).join(",")}`,
  );
  return "claimed → done (reassign refused) → reopened, one event each";
});

// ------------------------------------------------------------------ forward / reassign

await check("F1 forward writes actor/from/to and keeps the task claimed", async () => {
  const holder = (await probe(created.concurrent.messagePublicId)).task.claimedByPublicId;
  const target = [aliceId, bobId, carolId, daveId].find((id) => id !== holder);
  await clientsByPublicId.get(holder).mutation(api.actionInbox.forward, {
    taskPublicId: created.concurrent.taskPublicId,
    toUserPublicId: target,
  });
  const state = await probe(created.concurrent.messagePublicId);
  assert(state.task.status === "claimed", `status=${state.task.status}`);
  assert(state.task.claimedByPublicId === target, `claimedBy=${state.task.claimedByPublicId}`);
  assert(state.task.forwardedToPublicId === target, "forwardedTo not recorded");
  const event = state.events[state.events.length - 1];
  assert(event.action === "forwarded", `event=${event.action}`);
  assert(event.actorPublicId === holder, `actor=${event.actorPublicId}`);
  assert(event.fromPublicId === holder && event.toPublicId === target, "from/to mismatch");
  created.forwardedTo = target;
  return `${holder} → ${target}, status still claimed`;
});

await check("F2 self-forward is refused", async () => {
  await expectError(
    () =>
      clientsByPublicId.get(created.forwardedTo).mutation(api.actionInbox.forward, {
        taskPublicId: created.concurrent.taskPublicId,
        toUserPublicId: created.forwardedTo,
      }),
    "already the current claimant",
  );
  return "current holder cannot forward to itself";
});

await check("F3 reassign writes forwarded with actor ≠ from and leaves status claimed", async () => {
  const from = created.forwardedTo;
  const target = [aliceId, bobId, carolId, daveId].find((id) => id !== from);
  const result = await alice.client.mutation(api.actionInbox.reassign, {
    taskPublicId: created.concurrent.taskPublicId,
    toUserPublicId: target,
  });
  assert(result.status === "claimed", `status=${result.status}`);
  const state = await probe(created.concurrent.messagePublicId);
  const event = state.events[state.events.length - 1];
  assert(event.action === "forwarded", `event=${event.action}`);
  assert(event.actorPublicId === aliceId, `actor=${event.actorPublicId}`);
  assert(event.fromPublicId === from && event.toPublicId === target, "from/to mismatch");
  assert(state.task.claimedByPublicId === target, "holder not replaced");
  return `actor alice: ${from} → ${target}`;
});

// ------------------------------------------------------------------ DM lifecycle

await check("D1 DM lifecycle: claim, done, reopen, done, close", async () => {
  const dm = await alice.client.mutation(api.groups.createDm, { userPublicId: bobId });
  const dmConversation = { kind: "dm", peerPublicId: bobId };
  const sent = await sendAction(alice.client, dmConversation, "dm task");
  created.dm = sent;
  await bob.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId });
  await bob.client.mutation(api.actionInbox.markDone, { taskPublicId: sent.taskPublicId });
  await alice.client.mutation(api.actionInbox.reopen, { taskPublicId: sent.taskPublicId });
  await bob.client.mutation(api.actionInbox.markDone, { taskPublicId: sent.taskPublicId });
  const closed = await alice.client.mutation(api.actionInbox.close, { taskPublicId: sent.taskPublicId });
  assert(closed.status === "closed" && closed.selfClosed === false, JSON.stringify(closed));
  const state = await probe(sent.messagePublicId);
  assert(state.task.groupPath === null, `DM task has groupPath=${state.task.groupPath}`);
  assert(
    state.events.map((row) => row.action).join(",") === "claimed,done,reopened,done,closed",
    `sequence=${state.events.map((row) => row.action).join(",")}`,
  );
  const dmLive = await alice.client.query(api.messages.listLive, { conversation: dmConversation });
  const card = taskCardFor(dmLive, sent.messagePublicId);
  assert(card.viewer.canReopen === false && card.viewer.canHide === true, "DM closer flags wrong");
  return "both participants act as owners; 5 typed events";
});

await check("D2 a DM participant can archive a DM task", async () => {
  const dmConversation = { kind: "dm", peerPublicId: aliceId };
  const sent = await sendAction(bob.client, dmConversation, "dm archive task");
  const archived = await alice.client.mutation(api.actionInbox.archive, {
    taskPublicId: sent.taskPublicId,
  });
  assert(archived.status === "archived", `status=${archived.status}`);
  const state = await probe(sent.messagePublicId);
  assert(state.task.status === "archived", "archived status not stored");
  assert(state.events.length === 1 && state.events[0].action === "archived", "archive event missing");
  return "DM peer archived; audit retained";
});

// ------------------------------------------------------------------ rollup + retention

await check("R1 rollup covers the group and descendants but never DMs", async () => {
  const rollOrg = await alice.client.mutation(api.organizations.create, {
    name: `Rollup ${runId}`,
    allowDirectMessages: true,
  });
  const invite = await alice.client.mutation(api.invites.create, { orgPublicId: rollOrg.orgPublicId });
  await bob.client.action(api.invites.redeem, { token: invite.token });
  const child = await alice.client.mutation(api.groups.create, {
    orgPublicId: rollOrg.orgPublicId,
    name: "Child",
    memberPublicIds: [bobId],
  });
  const rootTask = await sendAction(
    alice.client,
    { kind: "group", publicId: rollOrg.rootGroupPublicId },
    "rollup root task",
  );
  const childTask = await sendAction(
    alice.client,
    { kind: "group", publicId: child.groupPublicId },
    "rollup child task",
  );
  await alice.client.mutation(api.groups.createDm, { userPublicId: bobId });
  const dmTask = await sendAction(bob.client, { kind: "dm", peerPublicId: aliceId }, "rollup dm task");
  created.roll = { rollOrg, child, rootTask, childTask, dmTask };
  const state = await probe(dmTask.messagePublicId);
  assert(state.task.groupPath === null, "DM task unexpectedly has a path");

  const rootRollup = await alice.client.query(api.actionInbox.rollup, {
    groupPublicId: rollOrg.rootGroupPublicId,
  });
  const ids = rootRollup.tasks.map((task) => task.publicId);
  assert(ids.includes(rootTask.taskPublicId), "root task missing");
  assert(ids.includes(childTask.taskPublicId), "descendant task missing");
  assert(!ids.includes(dmTask.taskPublicId), "DM task leaked into the rollup");
  assert(rootRollup.counts.open === 2, `counts.open=${rootRollup.counts.open}`);
  const ordered = rootRollup.tasks.every((task, index) => index === 0 || rootRollup.tasks[index - 1].createdAt <= task.createdAt);
  assert(ordered, "rollup is not ordered by creation");
  const childRollup = await alice.client.query(api.actionInbox.rollup, {
    groupPublicId: child.groupPublicId,
  });
  const childIds = childRollup.tasks.map((task) => task.publicId);
  assert(childIds.length === 1 && childIds[0] === childTask.taskPublicId, `child ids=${childIds.join(",")}`);
  return "own + child included, DM excluded, counts.open=2, chronological";
});

await check("R2 archived tasks are audit-only and excluded from the rollup", async () => {
  const { rollOrg, child } = created.roll;
  const sent = await sendAction(
    alice.client,
    { kind: "group", publicId: child.groupPublicId },
    "withdrawn task",
  );
  created.roll.archived = sent;
  await alice.client.mutation(api.actionInbox.archive, { taskPublicId: sent.taskPublicId });
  const state = await probe(sent.messagePublicId);
  assert(state.task.status === "archived", `status=${state.task.status}`);
  const rollup = await alice.client.query(api.actionInbox.rollup, {
    groupPublicId: rollOrg.rootGroupPublicId,
  });
  assert(!rollup.tasks.some((task) => task.publicId === sent.taskPublicId), "archived task in rollup");
  assert(rollup.counts.open === 2, `archived task changed counts.open to ${rollup.counts.open}`);
  await expectError(
    () =>
      alice.client.query(api.actionInbox.rollup, {
        groupPublicId: rollOrg.rootGroupPublicId,
        status: "archived",
      }),
    "audit-only",
  );
  const audit = await alice.client.query(api.actionInbox.events, {
    taskPublicId: sent.taskPublicId,
  });
  assert(audit.events.length === 1 && audit.events[0].action === "archived", "archived audit missing");
  return "excluded from counts/list; archived filter refused; audit retained";
});

await check("R3 hiding a closed task keeps status/count but drops it from the default list", async () => {
  const { rollOrg, child } = created.roll;
  const sent = await sendAction(
    alice.client,
    { kind: "group", publicId: child.groupPublicId },
    "complete then hide",
  );
  created.roll.hidden = sent;
  await bob.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId });
  await bob.client.mutation(api.actionInbox.markDone, { taskPublicId: sent.taskPublicId });
  await alice.client.mutation(api.actionInbox.close, { taskPublicId: sent.taskPublicId });
  const hidden = await alice.client.mutation(api.actionInbox.hideClosed, {
    taskPublicId: sent.taskPublicId,
  });
  assert(hidden.status === "closed" && hidden.hidden === true, JSON.stringify(hidden));
  const state = await probe(sent.messagePublicId);
  assert(state.task.status === "closed", `status=${state.task.status}`);
  assert(typeof state.task.archivedAt === "number", "archivedAt not set");
  assert(state.eventCount === 3, `hiding wrote an event: ${state.eventCount}`);

  const defaultRollup = await alice.client.query(api.actionInbox.rollup, {
    groupPublicId: rollOrg.rootGroupPublicId,
  });
  assert(!defaultRollup.tasks.some((task) => task.publicId === sent.taskPublicId), "hidden task in default list");
  assert(defaultRollup.counts.closed === 1, `closed count=${defaultRollup.counts.closed}`);
  const withHidden = await alice.client.query(api.actionInbox.rollup, {
    groupPublicId: rollOrg.rootGroupPublicId,
    includeHidden: true,
  });
  assert(withHidden.tasks.some((task) => task.publicId === sent.taskPublicId), "hidden task missing with includeHidden");
  return "status closed, archivedAt set, no event, default list drops it, count stays 1";
});

await check("R4 my tasks / tasks I raised are indexed queues", async () => {
  const my = await bob.client.query(api.actionInbox.myTasks, { status: "claimed" });
  assert(my.tasks.every((task) => task.claimedByPublicId === bobId), "myTasks returned another claimant");
  assert(my.tasks.every((task) => task.status === "claimed"), "myTasks returned another status");
  const raised = await alice.client.query(api.actionInbox.raisedByMe, { status: "open" });
  assert(raised.tasks.every((task) => task.senderPublicId === aliceId), "raisedByMe returned another sender");
  assert(raised.tasks.every((task) => task.status === "open"), "raisedByMe returned another status");
  return `myTasks=${my.tasks.length} claimed, raised=${raised.tasks.length} open`;
});

// ------------------------------------------------------------------ integrity + helpers

await check("I1 edit is allowed while open and refused after claim", async () => {
  const sent = await sendAction(alice.client, workersConversation, "editable task");
  created.editable = sent;
  const edited = await alice.client.mutation(api.messages.edit, {
    messagePublicId: sent.messagePublicId,
    text: "editable task (edited)",
  });
  assert(typeof edited.editedAt === "number", "open action message could not be edited");
  await bob.client.mutation(api.actionInbox.claim, { taskPublicId: sent.taskPublicId });
  await expectError(
    () =>
      alice.client.mutation(api.messages.edit, {
        messagePublicId: sent.messagePublicId,
        text: "should not land",
      }),
    "editing is disabled",
  );
  const live = await alice.client.query(api.messages.listLive, { conversation: workersConversation });
  const message = live.find((row) => row.publicId === sent.messagePublicId);
  assert(message.text === "editable task (edited)", `text changed: ${message.text}`);
  return "open edit stamped editedAt; claimed edit refused";
});

await check("I2 action messages cannot be deleted (discussion messages still can)", async () => {
  await expectError(
    () =>
      alice.client.mutation(api.messages.softDelete, {
        messagePublicId: created.editable.messagePublicId,
      }),
    "Action messages cannot be deleted",
  );
  const discussion = await alice.client.mutation(api.messages.send, {
    conversation: workersConversation,
    text: "deletable discussion",
  });
  const deleted = await alice.client.mutation(api.messages.softDelete, {
    messagePublicId: discussion.messagePublicId,
  });
  assert(deleted.deleted === true, "discussion delete regressed");
  return "action delete refused; discussion soft-delete still works";
});

await check("I3 assignableMembers excludes inactive accounts", async () => {
  const sent = await sendAction(alice.client, workersConversation, "assignable members task");
  runInternal("setUserAccountState", { userPublicId: daveId, accountState: "shadow" });
  try {
    const rows = await alice.client.query(api.actionInbox.assignableMembers, {
      taskPublicId: sent.taskPublicId,
    });
    assert(!rows.some((row) => row.userPublicId === daveId), "shadow account is assignable");
    assert(rows.some((row) => row.userPublicId === carolId), "active member missing");
  } finally {
    runInternal("setUserAccountState", { userPublicId: daveId, accountState: "active" });
  }
  return "shadow excluded, active members listed";
});

await check("I4 audit is chronological and read-gated", async () => {
  const audit = await alice.client.query(api.actionInbox.events, {
    taskPublicId: created.concurrent.taskPublicId,
  });
  assert(audit.events.length >= 5, `events=${audit.events.length}`);
  const ordered = audit.events.every(
    (event, index) => index === 0 || audit.events[index - 1].timestamp <= event.timestamp,
  );
  assert(ordered, "audit is not chronological");
  await expectError(
    () =>
      erin.client.query(api.actionInbox.events, {
        taskPublicId: created.one.taskPublicId,
      }),
    "access",
  );
  return `${audit.events.length} events, chronological, non-member refused`;
});

// ------------------------------------------------------------------ result

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
