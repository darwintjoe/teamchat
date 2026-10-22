// Dev-only S3-compatible bucket for the SAL end-to-end checks.
//
//   s3rver (real S3 API semantics, fs-backed) listens on 127.0.0.1:9001.
//   A tiny CORS proxy listens on 127.0.0.1:9000 and forwards to it, because s3rver has no CORS
//   support and the web client PUTs to the pre-signed URL from the browser.
//
// A cloudflared quick tunnel (see scripts/dev-tunnel.mjs) exposes port 9000 publicly so the Convex
// deployment's actions can HEAD/promote/delete objects. This is dev harness only: the app code is
// provider-agnostic and points at any S3-compatible endpoint via storage.setS3Config.
//
// Run: node scripts/dev-storage.mjs

import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import S3rver from "s3rver";

const require = createRequire(import.meta.url);

// s3rver only knows the default `S3RVER` access key. Register the demo credentials so a
// SigV4 header/query naming them resolves to an account (signatures are not verified in dev).
const AWSAccount = require("s3rver/lib/models/account");
AWSAccount.DUMMY_ACCOUNT.createKeyPair("minioadmin", "minioadmin");

const here = dirname(fileURLToPath(import.meta.url));
const INTERNAL_PORT = 9001;
const PUBLIC_PORT = 9000;

const server = new S3rver({
  port: INTERNAL_PORT,
  address: "127.0.0.1",
  silent: true,
  directory: join(here, "..", ".s3data"),
  allowMismatchedSignatures: true, // the tunnel's hostname is not the signed hostname
  vhostBuckets: false,
  configureBuckets: [{ name: "teamchat" }],
});

await server.run();

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,HEAD,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "ETag,Content-Length,Content-Type,x-amz-request-id",
  "access-control-max-age": "600",
};

const proxy = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: INTERNAL_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, { ...upstreamRes.headers, ...CORS_HEADERS });
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { ...CORS_HEADERS, "content-type": "text/plain" });
    res.end(`dev storage proxy error: ${error}`);
  });
  req.pipe(upstream);
});

proxy.listen(PUBLIC_PORT, "127.0.0.1", () => {
  console.log(`dev storage ready: http://127.0.0.1:${PUBLIC_PORT} (bucket "teamchat")`);
});
