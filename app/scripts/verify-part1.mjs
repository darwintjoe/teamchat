// Part 1 corrections check: OTP limits, presigned POST, DM attachments, and read-path reachability.
//
//   node scripts/verify-part1.mjs                 # full run (consumes the 20/10 min IP budget)
//   node scripts/verify-part1.mjs --skip-limits   # functional checks only
//
// Run the full mode against a freshly deployed rate-limit window, or wait 10 minutes between runs.
// The IP-limit phase intentionally sends requests until the limiter refuses, so it must be last.

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../convex/_generated/api.js";
import {
  appDir,
  decodePolicy,
  deploymentUrl,
  postUpload,
  signInFresh,
  sleep,
  storageEndpoint,
} from "./lib/harness.mjs";

const skipLimits = process.argv.includes("--skip-limits");
const url = deploymentUrl();
const endpoint = storageEndpoint();
if (endpoint === null) throw new Error("No dev storage endpoint; start scripts/dev-storage.mjs and the tunnel");

const runId = Date.now().toString(36);
let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function errorText(error) {
  return `${error?.message ?? error} ${JSON.stringify(error?.data ?? "")}`;
}

async function expectError(fn, matcher) {
  try {
    const result = await fn();
    throw new Error(`expected an error, got ${JSON.stringify(result)?.slice(0, 160)}`);
  } catch (error) {
    if (/expected an error/.test(error.message)) throw error;
    if (!matcher.test(errorText(error))) {
      throw new Error(`expected ${matcher}, got: ${errorText(error)}`);
    }
    return error;
  }
}

// ------------------------------------------------------------------ users

const alice = new ConvexHttpClient(url);
const bob = new ConvexHttpClient(url);
const carol = new ConvexHttpClient(url);
const aliceTokens = await signInFresh(alice, `part1.alice.${runId}@demo.teamchat.test`);
const bobTokens = await signInFresh(bob, `part1.bob.${runId}@demo.teamchat.test`);
await signInFresh(carol, `part1.carol.${runId}@demo.teamchat.test`);
const aliceMe = await alice.query(api.users.me, {});
const bobMe = await bob.query(api.users.me, {});
const carolMe = await carol.query(api.users.me, {});

const org = await alice.mutation(api.organizations.create, {
  name: `Part 1 ${runId}`,
  allowDirectMessages: true,
});
const invite = await alice.mutation(api.invites.create, { orgPublicId: org.orgPublicId });
await bob.action(api.invites.redeem, { token: invite.token });
await alice.mutation(api.storage.config.setS3Config, {
  orgPublicId: org.orgPublicId,
  endpoint,
  bucket: "teamchat",
  region: "us-east-1",
  keyPrefix: "teamchat",
  pendingPrefix: "pending",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
});

// ------------------------------------------------------------------ DM attachment

const dm = await alice.mutation(api.groups.createDm, { userPublicId: bobMe.publicId });
check("a DM exists between Alice and Bob", dm.peerPublicId === bobMe.publicId, `created=${dm.created}`);

const dmStateAlice = await alice.query(api.storage.config.conversationStorageState, {
  conversation: { kind: "dm", peerPublicId: bobMe.publicId },
});
const dmStateBob = await bob.query(api.storage.config.conversationStorageState, {
  conversation: { kind: "dm", peerPublicId: aliceMe.publicId },
});
check(
  "both DM participants see the shared org's storage",
  dmStateAlice.provider === "s3" && dmStateBob.provider === "s3",
  `${dmStateAlice.provider}/${dmStateBob.provider}`,
);

const dmBytes = new Uint8Array(4096);
for (let i = 0; i < dmBytes.length; i++) dmBytes[i] = (i * 7) % 251;
const dmTicket = await alice.action(api.storage.attachments.requestUpload, {
  peerPublicId: bobMe.publicId,
  name: "dm-photo.png",
  mime: "image/png",
  size: dmBytes.length,
});
check("a DM upload ticket is a POST policy", dmTicket.method === "POST" && dmTicket.fields?.policy);
const dmPolicy = decodePolicy(dmTicket);
check(
  "the DM ticket has a content-length-range condition",
  dmPolicy.conditions.some(
    (condition) =>
      Array.isArray(condition) &&
      condition[0] === "content-length-range" &&
      condition[1] === 1 &&
      condition[2] === dmBytes.length,
  ),
);
await postUpload(dmTicket, dmBytes, "dm-photo.png", "image/png");
const dmConfirmed = await alice.action(api.storage.attachments.confirmUpload, {
  attachmentId: dmTicket.attachmentId,
});
check("the DM upload confirms", dmConfirmed.status === "confirmed", `${dmConfirmed.size} bytes`);

const dmSent = await alice.mutation(api.messages.send, {
  conversation: { kind: "dm", peerPublicId: bobMe.publicId },
  text: "",
  attachmentIds: [dmTicket.attachmentId],
});
const bobLive = await bob.query(api.messages.listLive, {
  conversation: { kind: "dm", peerPublicId: aliceMe.publicId },
});
const dmMessage = bobLive.find((message) => message.publicId === dmSent.messagePublicId);
check(
  "the DM message records the attachment",
  dmMessage?.attachments?.length === 1 &&
    dmMessage.attachments[0].attachmentId === dmTicket.attachmentId,
  JSON.stringify(dmMessage?.attachments),
);

const dmRead = await bob.action(api.storage.attachments.requestRead, {
  attachmentId: dmTicket.attachmentId,
});
const dmResponse = await fetch(dmRead.url);
const dmBody = new Uint8Array(await dmResponse.arrayBuffer());
check(
  "the other DM participant can read the bytes",
  dmResponse.ok && Buffer.from(dmBody).equals(Buffer.from(dmBytes)),
  `${dmBody.length} bytes`,
);

await expectError(
  () => carol.action(api.storage.attachments.requestRead, { attachmentId: dmTicket.attachmentId }),
  /access/i,
);
check("a non-participant cannot read the DM attachment", true);

await expectError(
  () =>
    carol.action(api.storage.attachments.requestUpload, {
      peerPublicId: bobMe.publicId,
      name: "sneak.png",
      mime: "image/png",
      size: 16,
    }),
  /direct message|participant/i,
);
check("a non-participant cannot get a DM upload ticket", true);

// A DM with a user outside every shared org must stay text-only.
await expectError(
  () =>
    alice.action(api.storage.attachments.requestUpload, {
      peerPublicId: carolMe.publicId,
      name: "no-org.png",
      mime: "image/png",
      size: 16,
    }),
  /direct message|shared organisation|not found/i,
);
check("a DM with no shared org has no upload ticket", true);

// ------------------------------------------------------------------ OTP limits

if (!skipLimits) {
  console.log("\nOTP limits (10-minute fixed windows)");

  // 4th request for one email is denied; the demo echo path is still what the first 3 exercised.
  const emailLimited = `part1.otp.${runId}@demo.teamchat.test`;
  const otpClient = new ConvexHttpClient(url);
  let requestCount = 0;
  for (let i = 1; i <= 3; i++) {
    await otpClient.action(api.auth.signIn, { provider: "email", params: { email: emailLimited } });
    requestCount++;
    await sleep(100);
  }
  const echo = await otpClient.query(api.auth.demo.getEchoedCode, { email: emailLimited });
  check("the demo echo path served the first three requests", echo?.code !== undefined, echo?.code ? "code present" : "no code");
  const fourth = await expectError(
    () => otpClient.action(api.auth.signIn, { provider: "email", params: { email: emailLimited } }),
    /too many sign-in codes requested for this email/i,
  );
  check("4th request for the same email is denied", fourth !== null);

  // Verification attempts: 10 are accepted by the limiter (and fail on the wrong code); #11 is
  // refused before the library verifies anything.
  const verifyEmail = `part1.verify.${runId}@demo.teamchat.test`;
  const verifyClient = new ConvexHttpClient(url);
  await verifyClient.action(api.auth.signIn, { provider: "email", params: { email: verifyEmail } });
  let code = null;
  for (let i = 0; i < 40 && code === null; i++) {
    const row = await verifyClient.query(api.auth.demo.getEchoedCode, { email: verifyEmail });
    if (row?.code) code = row.code;
    else await sleep(100);
  }
  if (code === null) throw new Error("verification-limit test could not get a code");
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    try {
      const result = await verifyClient.action(api.auth.signIn, {
        provider: "email",
        params: { email: verifyEmail, code: `wrong-${i}` },
      });
      if (result?.tokens == null) accepted++;
    } catch (error) {
      // The library rejects a wrong code by throwing. That still proves the attempt reached the
      // verifier; only the limiter's own message means the attempt was refused before verification.
      if (/too many verification attempts/i.test(errorText(error))) {
        throw new Error(`verification attempt ${i + 1} was denied before the 10-attempt budget`);
      }
      if (!/could not verify code|invalid code|code.*(?:wrong|invalid|expired)/i.test(errorText(error))) {
        throw error;
      }
      accepted++;
    }
  }
  const eleventh = await expectError(
    () =>
      verifyClient.action(api.auth.signIn, {
        provider: "email",
        params: { email: verifyEmail, code: "wrong-11" },
      }),
    /too many verification attempts/i,
  );
  check(
    "the 11th verification attempt in the window is denied",
    accepted === 10 && eleventh !== null,
    `${accepted} wrong-code attempts reached the verifier`,
  );

  // IP limit: keep sending first-time requests until the network limit refuses. This phase is
  // last because it consumes the whole 20-request window.
  const ipClient = new ConvexHttpClient(url);
  let ipAccepted = 0;
  let firstDeniedAt = null;
  for (let i = 1; i <= 21; i++) {
    try {
      await ipClient.action(api.auth.signIn, {
        provider: "email",
        params: { email: `part1.ip.${runId}.${i}@demo.teamchat.test` },
      });
      ipAccepted++;
    } catch (error) {
      if (/too many sign-in codes requested from this network/i.test(errorText(error))) {
        firstDeniedAt = i;
        break;
      }
      throw error;
    }
  }
  check(
    "the per-IP limit refuses after the window is full",
    firstDeniedAt !== null && ipAccepted <= 20,
    `accepted ${ipAccepted} in this phase; first network denial at phase request ${firstDeniedAt}`,
  );
} else {
  console.log("\nOTP limits skipped (--skip-limits)");
}

const evidence = [
  `runAt: ${new Date().toISOString()}`,
  `deployment: ${url}`,
  `org: ${org.orgPublicId}`,
  `alice: ${aliceMe.publicId}`,
  `bob: ${bobMe.publicId}`,
  `carol: ${carolMe.publicId}`,
  `aliceTokenIssued: ${aliceTokens.token.length > 0}`,
  `bobTokenIssued: ${bobTokens.token.length > 0}`,
  `passed: ${passed}`,
  `failed: ${failures.length}`,
  ...failures.map((name) => `failed check: ${name}`),
].join("\n");
mkdirSync(join(appDir, "evidence"), { recursive: true });
writeFileSync(join(appDir, "evidence", "part1-verify.txt"), `${evidence}\n`);
console.log(`\n${passed} passed, ${failures.length} failed`);
console.log("evidence: evidence/part1-verify.txt");
process.exit(failures.length === 0 ? 0 : 1);
