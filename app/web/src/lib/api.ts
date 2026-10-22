// The Convex API lives with the backend (`app/convex/_generated`). Importing it at runtime would
// take the Next bundler outside its project root, so the runtime object is Convex's `anyApi` and
// the *types* come from the generated declaration file (erased before bundling).
//
// Everything is still type-checked against the real backend contract; only the runtime import is
// replaced by the equivalent generated value (`export const api = anyApi` upstream).
import { anyApi } from "convex/server";
import type * as Generated from "../../../convex/_generated/api";

export const api = anyApi as unknown as typeof Generated.api;
export const internal = anyApi as unknown as typeof Generated.internal;
