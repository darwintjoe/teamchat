"use client";

import { useEffect, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type Step = "email" | "code";

/**
 * Email OTP sign-in. CR-16: in a demo build the code is echoed on screen (the provider stores it,
 * `api.auth.demo.getEchoedCode` reads it back reactively). There is no password and no email is
 * actually sent — the banner above says so.
 */
export function SignIn() {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<Step>("email");
  const [emailInput, setEmailInput] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const email = emailInput.trim().toLowerCase();
  const echo = useQuery(
    api.auth.demo.getEchoedCode,
    step === "code" && email !== "" ? { email } : "skip",
  );

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("invite");
    if (token !== null && token.trim() !== "") setInviteToken(token.trim());
  }, []);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    if (email === "") return;
    setBusy(true);
    setError(null);
    try {
      await signIn("email", { email });
      setStep("code");
      setCode("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (code.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await signIn("email", { email, code: code.trim() });
      if (result.signingIn) return; // auth state flips; this component unmounts
      setError("That code was not accepted. Request a new one.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin-wrap">
      <div className="signin-card">
        <h1>TeamChat</h1>
        <p className="sub">
          Sign in with a one-time code. {inviteToken !== null ? "You have an invite — you will join the organisation after sign-in." : "New here? Entering an email creates an active account."}
        </p>

        {step === "email" ? (
          <form onSubmit={requestCode}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                required
                autoFocus
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || email === ""}>
              {busy ? "Sending…" : "Send code"}
            </button>
            {error !== null ? <p className="error">{error}</p> : null}
          </form>
        ) : (
          <form onSubmit={verifyCode}>
            {echo !== undefined && echo !== null ? (
              <div className="echo-box">
                <div>Demo build — the “emailed” code for {email} is</div>
                <div className="echo-code">{echo.code}</div>
                <div>
                  <button type="button" className="btn-link" onClick={() => setCode(echo.code)}>
                    Fill it in
                  </button>{" "}
                  <span className="hint">expires {new Date(echo.expiresAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ) : (
              <div className="echo-box">
                Waiting for the demo code to appear… (it is generated server-side when the email
                “sends”)
              </div>
            )}

            <div className="field">
              <label htmlFor="code">One-time code</label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={busy || code.trim() === ""}>
                {busy ? "Verifying…" : "Verify & sign in"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                }}
              >
                Change email
              </button>
            </div>
            {error !== null ? <p className="error">{error}</p> : null}
            <p className="hint">
              Codes are single-use and expire after 3 minutes. This session lasts 30 days of
              inactivity.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
