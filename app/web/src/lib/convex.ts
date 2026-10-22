import { ConvexReactClient } from "convex/react";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set (see web/.env.local)");

export const convex = new ConvexReactClient(url);
