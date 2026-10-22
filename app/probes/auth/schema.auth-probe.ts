// TEMPORARY auth-probe schema. Not the product schema.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  // PRD users table, extended with the fields Convex Auth itself needs.
  users: defineTable({
    // Convex Auth fields
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // TeamChat fields
    publicId: v.string(),
    phoneVerified: v.boolean(),
    accountState: v.union(
      v.literal("shadow"),
      v.literal("provisioned"),
      v.literal("active"),
      v.literal("bot"),
    ),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_public_id", ["publicId"]),

  organizations: defineTable({
    publicId: v.string(),
    name: v.string(),
    allowDirectMessages: v.boolean(),
  }).index("by_public_id", ["publicId"]),

  groups: defineTable({
    kind: v.literal("group"),
    publicId: v.string(),
    name: v.string(),
    orgId: v.id("organizations"),
    path: v.string(),
  }).index("by_public_id", ["publicId"]),

  hostApps: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    issuer: v.string(),
    audience: v.string(),
    allowedOrigins: v.array(v.string()),
    supportGroupId: v.id("groups"),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_issuer", ["issuer"]),

  externalIdentities: defineTable({
    hostAppId: v.id("hostApps"),
    externalUserId: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_host_external", ["hostAppId", "externalUserId"])
    .index("by_user", ["userId"]),
});
