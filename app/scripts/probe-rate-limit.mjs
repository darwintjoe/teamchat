// Quick probe: does redeemInvite rate-limit actually fire at 11 attempts in one minute?
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api.js";

const url = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^CONVEX_URL=(.+)$/m)[1].trim();
const email = `ratelimit+${Date.now().toString(36)}@demo.teamchat.test`;
const client = new ConvexHttpClient(url);

await client.action(api.auth.signIn, { provider: "email", params: { email } });
let code = null;
for (let i = 0; i < 50 && code === null; i++) {
  const echo = await client.query(api.auth.demo.getEchoedCode, { email });
  if (echo?.code) code = echo.code;
  else await new Promise((r) => setTimeout(r, 100));
}
const result = await client.action(api.auth.signIn, { provider: "email", params: { email, code } });
client.setAuth(result.tokens.token);

console.log("minute-second at start:", new Date().getSeconds());
for (let i = 1; i <= 12; i++) {
  const startedAt = Date.now();
  try {
    await client.mutation(api.invites.redeem, { token: `bogus-${i}` });
    console.log(i, "SUCCESS?!");
  } catch (error) {
    console.log(i, `${Date.now() - startedAt}ms`, error.message.split("\n")[0], JSON.stringify(error.data ?? ""));
  }
}
console.log("minute-second at end:", new Date().getSeconds());
