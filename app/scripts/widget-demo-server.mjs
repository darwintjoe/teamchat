// Local demo host server for the embedded widget.
//
//   node scripts/widget-demo-server.mjs
//   open http://localhost:4310
//
// It signs in a demo org admin, registers (once) a host app + ES256 public key, serves the widget
// bundles, and mints one-shot host assertions for the customer named in the query string.
// The private key lives only in .widget-demo/state.json (gitignored).

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  createSigningKey,
  signWidgetToken,
  signingKeyFromJwk,
  tokenTimes,
} from "./lib/widgetAuth.mjs";
import { deploymentUrl, signInFresh } from "./lib/harness.mjs";
import { findBusyPorts } from "./lib/ports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const stateDir = join(appDir, ".widget-demo");
const stateFile = join(stateDir, "state.json");
const widgetDist = join(appDir, "widget", "dist");
const demoHtml = join(appDir, "widget", "demo", "index.html");

const PORT = Number(process.env.WIDGET_DEMO_PORT ?? 4310);
const WIDGET_PORT = Number(process.env.WIDGET_WIDGET_PORT ?? 4311);
const ORIGIN = `http://localhost:${PORT}`;
const WIDGET_ORIGIN = `http://localhost:${WIDGET_PORT}`;
const ISSUER = "https://northwind.example";
const AUDIENCE = "teamchat-widget";
const ADMIN_EMAIL = process.env.WIDGET_DEMO_ADMIN_EMAIL ?? "widget-demo-admin@demo.teamchat.test";

const convexUrl = deploymentUrl();

async function loadState() {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function saveState(state) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function ensureDemo() {
  const state = (await loadState()) ?? {};
  const admin = new ConvexHttpClient(convexUrl);
  await signInFresh(admin, ADMIN_EMAIL);

  let orgPublicId = state.orgPublicId;
  const orgs = await admin.query(api.organizations.listMine, {});
  const existingOrg = orgs.find((org) => org.publicId === orgPublicId) ?? orgs[0] ?? null;
  if (existingOrg === null) {
    const created = await admin.mutation(api.organizations.create, {
      name: "Northwind Coffee (widget demo)",
      allowDirectMessages: true,
    });
    orgPublicId = created.orgPublicId;
  } else {
    orgPublicId = existingOrg.publicId;
  }

  const signing = state.kid && state.privateJwk ? state : await createSigningKey();
  const apps = await admin.query(api.hostApps.listForOrg, { orgPublicId });
  let hostApp = apps.find((app) => app.name === "Northwind Coffee") ?? null;

  if (hostApp === null) {
    const org = await admin.query(api.organizations.get, { orgPublicId });
    const registered = await admin.mutation(api.hostApps.register, {
      orgPublicId,
      name: "Northwind Coffee",
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedOrigins: [ORIGIN],
      supportGroupPublicId: org.rootGroupPublicId,
      primaryColor: "#0f766e",
      uploads: {
        allowWidgetUploads: true,
        maxFileBytes: 2 * 1024 * 1024,
        allowedMimes: ["image/png", "image/jpeg", "application/pdf", "text/plain"],
        maxPerMinute: 10,
      },
    });
    await admin.mutation(api.hostApps.addKey, {
      hostAppPublicId: registered.hostAppPublicId,
      kid: signing.kid,
      alg: "ES256",
      publicKey: JSON.stringify(signing.publicJwk),
    });
    hostApp = { publicId: registered.hostAppPublicId };
  } else {
    const hasKey = hostApp.keys.some((key) => key.kid === signing.kid);
    if (!hasKey) {
      await admin.mutation(api.hostApps.addKey, {
        hostAppPublicId: hostApp.publicId,
        kid: signing.kid,
        alg: "ES256",
        publicKey: JSON.stringify(signing.publicJwk),
      });
    }
    const origins = new Set(hostApp.allowedOrigins);
    if (!origins.has(ORIGIN)) {
      // The demo origin changes only with the port. Re-register is not supported, so warn loudly.
      console.warn(
        `Host app allowedOrigins (${hostApp.allowedOrigins.join(", ")}) does not include ${ORIGIN}. ` +
          "Delete .widget-demo/state.json and the host app, or run on the recorded port.",
      );
    }
  }

  await saveState({
    kid: signing.kid,
    alg: signing.alg,
    privateJwk: signing.privateJwk,
    publicJwk: signing.publicJwk,
    orgPublicId,
    hostAppPublicId: hostApp.publicId,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { ...state, ...(await loadState()) };
}

const busyPorts = await findBusyPorts([PORT, WIDGET_PORT]);
if (busyPorts.length > 0) {
  for (const { port, pids } of busyPorts) {
    const owner = pids.length > 0 ? ` (PID ${pids.join(", ")})` : " (owner not identifiable)";
    console.error(`widget demo: port ${port} is already in use${owner}`);
  }
  console.error(
    "widget demo: refusing to start without binding. " +
      "Run `node scripts/restart-widget-demo.mjs` to stop the owner and relaunch.",
  );
  process.exit(1);
}

const demo = await ensureDemo();
const privateKey = await signingKeyFromJwk(demo.privateJwk);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": ORIGIN,
  });
  res.end(body);
}

async function serveFile(res, file, type) {
  try {
    const bytes = await readFile(file);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(bytes);
  } catch {
    send(res, 404, JSON.stringify({ error: "Not found" }));
  }
}

/** Shared by the host origin (for header probes) and the widget origin (the real iframe URL). */
async function serveShell(res, url) {
  const host = (url.searchParams.get("host") ?? "").trim();
  if (host === "") {
    return send(res, 404, JSON.stringify({ error: { code: "host_not_found" } }));
  }
  let config;
  try {
    // Resolve through Convex so the allowlist is the stored one, not a demo constant.
    const client = new ConvexHttpClient(convexUrl);
    config = await client.query(api.hostApps.publicConfig, { hostAppPublicId: host });
  } catch {
    // Unknown and inactive hosts are indistinguishable.
    return send(res, 404, JSON.stringify({ error: { code: "host_not_found" } }));
  }
  try {
    const html = await readFile(join(widgetDist, "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `frame-ancestors ${config.allowedOrigins.join(" ")}`,
    });
    return res.end(html);
  } catch {
    return send(res, 404, JSON.stringify({ error: { code: "host_not_found" } }));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(demoHtml);
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (url.pathname === "/api/widget-bootstrap") {
      return send(
        res,
        200,
        JSON.stringify({
          hostAppPublicId: demo.hostAppPublicId,
          convexUrl,
          widgetOrigin: WIDGET_ORIGIN,
          widgetUrl: `${WIDGET_ORIGIN}/widget/shell?host=${encodeURIComponent(demo.hostAppPublicId)}`,
        }),
      );
    }
    if (url.pathname === "/widget/shell") {
      return serveShell(res, url);
    }
    if (url.pathname === "/api/widget-token" && req.method === "POST") {
      const customer = (url.searchParams.get("customer") ?? "alice@example.com").trim();
      if (customer === "" || customer.length > 200) {
        return send(res, 400, JSON.stringify({ error: "Invalid customer" }));
      }
      const local = customer.includes("@") ? customer.split("@")[0] : customer;
      const email = customer.includes("@") ? customer : `${customer}@demo.example`;
      const times = tokenTimes();
      const token = await signWidgetToken(privateKey, demo.kid, {
        iss: demo.issuer,
        aud: demo.audience,
        sub: `northwind:${customer.toLowerCase()}`,
        jti: `jti_${randomBytes(12).toString("hex")}`,
        iat: times.iat,
        exp: times.exp,
        email,
        name: local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      });
      console.log(`issued widget assertion for ${email}`);
      return send(res, 200, JSON.stringify({ token, expiresIn: times.exp - times.iat }));
    }
    if (url.pathname.startsWith("/widget/")) {
      const relative = normalize(url.pathname.slice("/widget/".length)).replace(/^(\.\.[/\\])+/, "");
      const file = join(widgetDist, relative);
      return serveFile(res, file, MIME[extname(file)] ?? "application/octet-stream");
    }
    return send(res, 404, JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error(error);
    return send(res, 500, JSON.stringify({ error: "Demo server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`widget demo:  ${ORIGIN}`);
  console.log(`host app:     ${demo.hostAppPublicId}`);
  console.log(`convex:       ${convexUrl}`);
  console.log(`build first:  npm run widget:build`);
});

const widgetServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", WIDGET_ORIGIN);
  // This is the URL the host actually frames: the shell must be on the widget origin so its
  // relative asset URLs resolve, while its CSP names the host origin as the allowed ancestor.
  if (url.pathname === "/widget/shell") {
    return serveShell(res, url);
  }
  if (url.pathname.startsWith("/widget/")) {
    const relative = normalize(url.pathname.slice("/widget/".length)).replace(/^(\.\.[/\\])+/, "");
    const file = join(widgetDist, relative);
    return serveFile(res, file, MIME[extname(file)] ?? "application/octet-stream");
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return send(res, 200, "TeamChat widget frame origin", "text/plain; charset=utf-8");
  }
  return send(res, 404, JSON.stringify({ error: "Not found" }));
});

widgetServer.listen(WIDGET_PORT, () => {
  console.log(`widget frame: ${WIDGET_ORIGIN} (cross-origin from the host)`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`widget demo: ${signal} received, closing both servers`);
  // Belt and braces: never let a hung keep-alive socket keep the ports occupied.
  const force = setTimeout(() => process.exit(0), 3_000);
  force.unref();
  let remaining = 2;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  server.close(closed);
  widgetServer.close(closed);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
