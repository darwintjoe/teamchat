// User-creation callback for Convex Auth. Enforces the Part 3 rule that at least one of
// email|phone exists, assigns `publicId`, and implements the activation path: a pre-created
// (e.g. API-provisioned) user with the same email is claimed and moves to `accountState: active`
// on email-OTP verification.

import { AnyDataModel, GenericMutationCtx } from "convex/server";
import { GenericId } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { newPublicId } from "../lib/ids";

type CreateOrUpdateArgs = {
  existingUserId: GenericId<"users"> | null;
  type: "oauth" | "credentials" | "email" | "phone" | "verification";
  profile: Record<string, unknown> & {
    email?: string;
    phone?: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
    name?: string;
  };
};

export async function createOrUpdateUser(
  ctx: GenericMutationCtx<AnyDataModel>,
  args: CreateOrUpdateArgs,
): Promise<GenericId<"users">> {
  // The library hands us an untyped mutation ctx; our data model is known at the call site.
  const db = (ctx as unknown as MutationCtx).db;

  if (args.existingUserId !== null) {
    return args.existingUserId;
  }

  const email =
    typeof args.profile.email === "string" ? args.profile.email.trim().toLowerCase() : undefined;
  const phone = typeof args.profile.phone === "string" ? args.profile.phone : undefined;
  if (email === undefined && phone === undefined) {
    throw new Error("An account requires at least one of email or phone (Part 3, users)");
  }

  if (email !== undefined) {
    const linked = await db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (linked !== null) {
      if (linked.accountState === "bot") {
        throw new Error("Bot accounts are not human sign-in accounts");
      }
      if (linked.accountState === "shadow") {
        // CR-9 / Flow D2: widget customers cannot sign in to the standalone app. Linking a
        // shadow to a real account requires email OTP ownership proof, which is not built.
        throw new Error("Shadow accounts cannot sign in to the standalone app");
      }
      // Activation path: link the account to the pre-created user and activate it.
      await db.patch(linked._id, {
        accountState: "active",
        email,
        phoneVerified: linked.phoneVerified,
        emailVerificationTime: Date.now(),
      });
      return linked._id;
    }
  }

  const name =
    typeof args.profile.name === "string" && args.profile.name.trim() !== ""
      ? args.profile.name.trim()
      : (email?.split("@")[0] ?? "TeamChat user");

  return await db.insert("users", {
    publicId: newPublicId("usr"),
    name,
    email,
    phone,
    phoneVerified: args.profile.phoneVerified === true,
    accountState: "active",
    emailVerificationTime: args.type === "email" || args.type === "verification" ? Date.now() : undefined,
  });
}
