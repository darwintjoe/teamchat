"use client";

import { AuthLoading, Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "@/lib/api";
import { SignIn } from "@/components/SignIn";
import { Workspace } from "@/components/Workspace";

/**
 * CR-16: the clients render a visible banner whenever the echoed-OTP stub is compiled in. The
 * flag comes from the deployment, so a production build (which refuses to compile with the stub)
 * can never show a stale banner.
 */
function DemoBanner() {
  const info = useQuery(api.auth.demo.buildInfo, {});
  if (info?.echoOtp !== true) return null;
  return (
    <div className="demo-banner" role="alert">
      <strong>Demo build — not authentication.</strong> One-time codes are shown on screen, and
      anyone can sign in as any email address. Do not use real accounts or real data.
    </div>
  );
}

export default function Page() {
  return (
    <>
      <DemoBanner />
      <AuthLoading>
        <div className="center-screen">Loading session…</div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Workspace />
      </Authenticated>
    </>
  );
}
