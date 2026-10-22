import { ConvexReactClient } from "convex/react";
import { anyApi } from "convex/server";
import type * as Generated from "../../../convex/_generated/api";

// `anyApi` keeps Metro from bundling the backend project outside the Expo root. The type-only
// import still checks every call against the generated backend contract.
export const api = anyApi as unknown as typeof Generated.api;

const fallbackUrl = "https://adventurous-squirrel-356.convex.cloud";

export const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL ?? fallbackUrl;

export const convex = new ConvexReactClient(convexUrl, {
  // The dev deployment is used for burst testing; avoid noisy reconnect logs in the app UI.
  verbose: false,
});
