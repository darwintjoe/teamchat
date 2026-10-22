// DM policy — decision 3 of the v0 build:
//   A pair may DM if ANY shared org allows DMs.
//   If they share no org, allow (personal connection, governed by neither org).
//   If they share orgs and none allows DMs, deny.

import { Doc, Id } from "../_generated/dataModel";
import { DbCtx } from "./guards";

export type DmPolicyVerdict = {
  policy: "no_shared_org" | "shared_org_allows";
  sharedOrgIds: Id<"organizations">[];
};

export async function checkDmPolicy(
  ctx: DbCtx,
  a: Id<"users">,
  b: Id<"users">,
): Promise<DmPolicyVerdict> {
  const aOrgs = await ctx.db
    .query("orgMembers")
    .withIndex("by_user", (q) => q.eq("userId", a))
    .collect();
  const sharedOrgIds: Id<"organizations">[] = [];
  let anyAllows = false;
  for (const membership of aOrgs) {
    const counterpart = await ctx.db
      .query("orgMembers")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${membership.orgId}:${b}`))
      .unique();
    if (counterpart === null) continue;
    sharedOrgIds.push(membership.orgId);
    if (!anyAllows) {
      const org = await ctx.db.get(membership.orgId);
      if (org !== null && org.allowDirectMessages) anyAllows = true;
    }
  }
  if (sharedOrgIds.length === 0) {
    return { policy: "no_shared_org", sharedOrgIds };
  }
  if (anyAllows) {
    return { policy: "shared_org_allows", sharedOrgIds };
  }
  throw new Error(
    "Direct messages are turned off by every organisation you share with this person",
  );
}

/** Shadow and bot accounts may not take part in DMs (locked rule, Flow D2). */
export function assertDmCapable(user: Doc<"users">, role: "sender" | "recipient"): void {
  if (user.accountState === "shadow") {
    throw new Error(`Shadow accounts cannot ${role === "sender" ? "create" : "receive"} direct messages`);
  }
  if (user.accountState === "bot") {
    throw new Error("Bot accounts do not participate in direct messages");
  }
}
