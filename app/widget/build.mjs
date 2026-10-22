// Build the two browser bundles: the host embed script and the iframe app.
//   node widget/build.mjs
//
// The iframe app is deliberately a separate bundle from the host embed so the host never loads
// the Convex client or its WebSocket code until the customer opens the panel.

import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  absWorkingDir: here,
  entryPoints: [
    { in: "src/index.ts", out: "teamchat-widget" },
    { in: "src/widget.ts", out: "widget" },
  ],
  outdir: dist,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020", "chrome100", "firefox100", "safari15"],
  sourcemap: true,
  minify: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

for (const file of ["index.html", "widget.css"]) {
  await copyFile(join(here, file), join(dist, file));
}

console.log(`widget bundles written to ${dist}`);
