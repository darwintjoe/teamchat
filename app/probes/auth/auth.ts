// TEMPORARY auth-probe provider. Not product auth.
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { internal } from "./_generated/api";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ConvexCredentials({
      id: "widget",
      authorize: async (credentials, ctx) => {
        // S3 tests the exchange path, not host JWT signature verification.
        if (credentials.token !== "probe-widget-token") return null;
        const externalUserId = credentials.externalUserId;
        if (typeof externalUserId !== "string") return null;

        const identity = await ctx.runQuery(
          internal.probes.resolveShadowUser,
          {
            issuer: "probe-host",
            externalUserId,
          },
        );
        if (identity === null) return null;

        return { userId: identity.userId };
      },
    }),
  ],
  session: {
    totalDurationMs: THIRTY_DAYS_MS,
    inactiveDurationMs: THIRTY_DAYS_MS,
  },
});
