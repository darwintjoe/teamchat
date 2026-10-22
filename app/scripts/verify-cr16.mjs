// CR-16 refusal evidence.
//
//   node scripts/verify-cr16.mjs --compile
//     Copies the real buildFlags guard with channel=production and stub=true, runs tsc, and
//     requires the compile-time assertion (TS2344) at that file. Restores/deletes the copy.
//
//   node scripts/verify-cr16.mjs --runtime --url=https://... --site=https://...
//     Calls the auth surface on a deployment marked production while a stub-enabled build is
//     deployed. Requires the CR-16 refusal error. Run before the production build is deployed.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, deploymentUrl } from "./lib/harness.mjs";

function arg(name) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const mode = process.argv.includes("--compile") ? "compile" : "runtime";
const lines = [];
const log = (line) => {
  lines.push(line);
  console.log(line);
};

let passed = false;

if (mode === "compile") {
  const source = join(appDir, "convex", "auth", "buildFlags.ts");
  const proof = join(appDir, "convex", "auth", "buildFlags.cr16-proof.ts");
  const original = readFileSync(source, "utf8");
  const mutated = original
    .replace('export const BUILD_CHANNEL = "demo" as const;', 'export const BUILD_CHANNEL = "production" as const;')
    .replace("export const DEMO_OTP_ECHO = true as const;", "export const DEMO_OTP_ECHO = true as const;");
  if (mutated === original) throw new Error("could not produce the production+stub variant");
  writeFileSync(proof, mutated);
  try {
    let output = "";
    let status = 0;
    try {
      output = execFileSync(process.execPath, [join(appDir, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], {
        cwd: appDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = error.status ?? 1;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    const expected = /buildFlags\.cr16-proof\.ts\(\d+,\d+\): error TS2344/.test(output);
    log(`compile exit: ${status}`);
    log(output.trim() || "(no diagnostics)");
    log(`CR-16 compile-time refusal observed: ${expected ? "YES" : "NO"}`);
    passed = status !== 0 && expected;
  } finally {
    try {
      unlinkSync(proof);
    } catch {
      // already gone
    }
  }
} else {
  const url = arg("url") ?? deploymentUrl();
  const deployment = arg("deployment") ?? process.env.PROD_DEPLOYMENT ?? "benevolent-crocodile-386";
  log(`deployment: ${url}`);
  log(`reference:  ${deployment}`);
  let errorText = null;
  try {
    execFileSync(
      process.execPath,
      [
        join(appDir, "node_modules", "convex", "bin", "main.js"),
        "run",
        "auth/demo:buildInfo",
        "{}",
        "--deployment",
        deployment,
        "--typecheck",
        "disable",
      ],
      { cwd: appDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    errorText = `${error.stdout ?? ""}${error.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  }
  log(`refusal: ${errorText?.trim() ?? "(call succeeded — NOT SAFE)"}`);
  passed = errorText !== null && /\[CR-16\]/.test(errorText) && /refusing/i.test(errorText);
}

mkdirSync(join(appDir, "evidence"), { recursive: true });
writeFileSync(
  join(appDir, "evidence", `cr16-${mode}.txt`),
  [
    `runAt: ${new Date().toISOString()}`,
    `mode: ${mode}`,
    ...lines,
    `passed: ${passed ? 1 : 0}`,
  ].join("\n") + "\n",
);
console.log(`evidence: evidence/cr16-${mode}.txt`);
process.exit(passed ? 0 : 1);
