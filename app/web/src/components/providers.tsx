"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { convex } from "@/lib/convex";

export function Providers({ children }: { children: React.ReactNode }) {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
}
