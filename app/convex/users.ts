// The signed-in user's own profile. `requireUser`, not `requireActive`: a provisioned/shadow
// account must be able to see why it cannot use the app.
//
// `_id` never crosses this boundary; `publicId` is the handle every other API expects.

import { query } from "./_generated/server";
import { requireUser } from "./lib/guards";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return {
      publicId: user.publicId,
      name: user.name ?? null,
      email: user.email ?? null,
      accountState: user.accountState,
      phoneVerified: user.phoneVerified,
    };
  },
});
