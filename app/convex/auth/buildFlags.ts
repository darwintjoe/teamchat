// CR-16 + production auth guards. This file is the single place where the echoed-OTP stub and the
// production/build-channel rules live.
//
// Rules (CR-16, locked):
//   * `DEMO_OTP_ECHO` is a BUILD-TIME flag. A production build MUST fail to compile while it is
//     true — the type-level assertion below makes that a compile error, not a code review note.
//   * A deployment marked production via TEAMCHAT_BUILD_CHANNEL=production refuses to run with
//     the stub enabled (`assertAuthBuildSafe`), and `npm run guard:prod` fails the deploy script.
//   * A production deployment also refuses to serve auth without a configured real provider
//     (`assertOtpProviderConfigured`). Demo builds keep the echo stub.
//   * The clients render a visible "demo build — not authentication" banner whenever
//     `api.auth.demo.buildInfo.echoOtp` is true.
//
// To produce a production build: run `npm run deploy:prod`. That script writes
// BUILD_CHANNEL = "production" and DEMO_OTP_ECHO = false, deploys, then restores this demo file.
// Flipping only BUILD_CHANNEL fails typecheck with the CR-16 assertion error — by design.

export const BUILD_CHANNEL = "demo" as const;
export const DEMO_OTP_ECHO = true as const;

// ---------------------------------------------------------------------------------------------
// Compile-time guard. If BUILD_CHANNEL is "production" and DEMO_OTP_ECHO is still true,
// `Cr16Guard` resolves to `false` and `AssertTrue<false>` is a type error.
type AssertTrue<T extends true> = T;
type Cr16Guard = typeof BUILD_CHANNEL extends "production"
  ? typeof DEMO_OTP_ECHO extends true
    ? false
    : true
  : true;
type _Cr16CompileTimeGuard = AssertTrue<Cr16Guard>;
// ---------------------------------------------------------------------------------------------

export function buildInfo() {
  return { channel: BUILD_CHANNEL, echoOtp: DEMO_OTP_ECHO };
}

function deployedChannel(): string {
  return (process.env.TEAMCHAT_BUILD_CHANNEL ?? "").trim().toLowerCase();
}

export function otpProviderName(): string {
  const explicit = (process.env.TEAMCHAT_OTP_PROVIDER ?? "").trim().toLowerCase();
  if (explicit !== "") return explicit;
  return DEMO_OTP_ECHO ? "echo" : "";
}

/**
 * Runtime refusal for a deployment explicitly marked production. Called at the top of
 * `convex/auth.ts`, inside the OTP path, and by the demo queries, so a stub-enabled deployment
 * cannot issue a session in production even if it was deployed with the wrong env.
 */
export function assertAuthBuildSafe(): void {
  if (deployedChannel() === "production" && DEMO_OTP_ECHO) {
    throw new Error(
      "[CR-16] The echoed-OTP demo stub is enabled, but this deployment is marked production " +
        "(TEAMCHAT_BUILD_CHANNEL=production). Refusing: a demo build must never authenticate real users.",
    );
  }
}

/**
 * Production must have a real sender. Kept separate from the CR-16 check so the error names the
 * missing configuration instead of blaming the stub.
 */
export function assertOtpProviderConfigured(): void {
  assertAuthBuildSafe();
  if (deployedChannel() !== "production") return;
  const provider = otpProviderName();
  if (provider !== "sendgrid") {
    throw new Error(
      "[OTP] This deployment is marked production but TEAMCHAT_OTP_PROVIDER is not a real " +
        "provider. Set TEAMCHAT_OTP_PROVIDER=sendgrid and SENDGRID_API_KEY (and TEAMCHAT_OTP_FROM). " +
        "Refusing to start the auth surface with an unconfigured or demo sender.",
    );
  }
  if ((process.env.SENDGRID_API_KEY ?? "").trim() === "") {
    throw new Error(
      "[OTP] TEAMCHAT_OTP_PROVIDER=sendgrid but SENDGRID_API_KEY is empty. Refusing to start auth.",
    );
  }
  if ((process.env.TEAMCHAT_OTP_FROM ?? "").trim() === "") {
    throw new Error(
      "[OTP] TEAMCHAT_OTP_PROVIDER=sendgrid but TEAMCHAT_OTP_FROM is empty. Refusing to start auth.",
    );
  }
}
