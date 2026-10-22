// Starts a cloudflared quick tunnel to the dev storage proxy (scripts/dev-storage.mjs) and prints
// the public https URL. The URL changes on every start; feed it to storage.setS3Config.
//
// Run: node scripts/dev-tunnel.mjs
// It keeps running until interrupted (Ctrl+C).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "..", ".storage", "cloudflared.exe");
if (!existsSync(exe)) {
  console.error(`cloudflared not found at ${exe}`);
  process.exit(1);
}

const child = spawn(
  exe,
  ["tunnel", "--url", "http://127.0.0.1:9000", "--no-autoupdate"],
  { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"] },
);

let printed = false;
const inspect = (chunk) => {
  const text = chunk.toString();
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !printed) {
    printed = true;
    console.log(`PUBLIC_STORAGE_URL=${match[0]}`);
  }
  if (process.env.VERBOSE) process.stderr.write(text);
};
child.stdout.on("data", inspect);
child.stderr.on("data", inspect);
child.on("exit", (code) => {
  console.error(`cloudflared exited with ${code}`);
  process.exit(code ?? 1);
});

process.on("SIGINT", () => child.kill());
