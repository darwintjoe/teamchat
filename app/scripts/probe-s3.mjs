import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("CONVEX_URL is not set");

const client = new ConvexHttpClient(url);
const anonymous = await client.query(api.probes.whoAmI, {});

let signInResult;
let signInError = null;
try {
  signInResult = await client.action(api.auth.signIn, {
    provider: "widget",
    params: {
      token: "probe-widget-token",
      externalUserId: "cust-1",
    },
    calledBy: "probe-s3",
  });
} catch (error) {
  signInError = String(error);
}

let whoAmI = null;
let whoAmIError = null;
if (signInResult?.tokens?.token) {
  client.setAuth(signInResult.tokens.token);
  try {
    whoAmI = await client.query(api.probes.whoAmI, {});
  } catch (error) {
    whoAmIError = String(error);
  }
}

const state = await client.query(api.probes.authProbeState, {});

const badClient = new ConvexHttpClient(url);
let badTokenResult;
let badTokenError = null;
try {
  badTokenResult = await badClient.action(api.auth.signIn, {
    provider: "widget",
    params: {
      token: "wrong-token",
      externalUserId: "cust-1",
    },
    calledBy: "probe-s3-negative",
  });
} catch (error) {
  badTokenError = String(error);
}

console.log(
  JSON.stringify(
    {
      anonymous,
      signInError,
      signIn: signInResult
        ? {
            hasTokens: Boolean(signInResult.tokens),
            tokenPresent: Boolean(signInResult.tokens?.token),
            refreshTokenPresent: Boolean(signInResult.tokens?.refreshToken),
          }
        : null,
      whoAmI,
      whoAmIError,
      state,
      negative: {
        result: badTokenResult ?? null,
        error: badTokenError,
      },
    },
    null,
    2,
  ),
);
