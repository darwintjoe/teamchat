// DOM-free unit tests for the subscription gate and postMessage parsing.
//   node widget/test/lifecycle.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "teamchat-widget-test-"));
try {
  await build({
    entryPoints: {
      lifecycle: join(import.meta.dirname, "..", "src", "lifecycle.ts"),
      protocol: join(import.meta.dirname, "..", "src", "protocol.ts"),
    },
    outdir: dir,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
  });

  const { SubscriptionGate } = await import(pathToFileURL(join(dir, "lifecycle.js")).href);
  const { isAllowedOrigin, parseHostMessage, parseWidgetMessage } = await import(
    pathToFileURL(join(dir, "protocol.js")).href
  );

  let passed = 0;
  function test(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  test("no subscription until the panel is open and visible", () => {
    let subscribes = 0;
    const gate = new SubscriptionGate(() => {
      subscribes++;
      return () => undefined;
    });
    gate.setVisible(true);
    assert.equal(subscribes, 0, "visible alone must not subscribe");
    gate.setOpen(true);
    assert.equal(subscribes, 1, "open + visible must subscribe");
    gate.setOpen(true);
    assert.equal(subscribes, 1, "opening twice is idempotent");
  });

  test("hide tears the subscription down and show restores it", () => {
    let active = 0;
    let subscribes = 0;
    const gate = new SubscriptionGate(
      () => {
        subscribes++;
        active++;
        return () => {
          active--;
        };
      },
    );
    gate.setOpen(true);
    assert.equal(active, 1);
    gate.setVisible(false);
    assert.equal(active, 0, "hidden widget must hold zero subscriptions");
    gate.setVisible(true);
    assert.equal(active, 1, "showing resubscribes");
    assert.equal(subscribes, 2);
  });

  test("close tears down and cannot leak a listener", () => {
    let active = 0;
    const gate = new SubscriptionGate(() => {
      active++;
      return () => {
        active--;
      };
    });
    gate.setOpen(true);
    gate.close();
    assert.equal(active, 0);
    assert.equal(gate.active, false);
    gate.setVisible(true);
    assert.equal(active, 0, "a closed gate must stay closed for visibility changes");
  });

  test("a throwing unsubscribe is swallowed and teardown stays idempotent", () => {
    let calls = 0;
    const gate = new SubscriptionGate(() => () => {
      calls++;
      throw new Error("socket already closed");
    });
    gate.setOpen(true);
    gate.setVisible(false);
    gate.setVisible(false);
    gate.setOpen(true);
    assert.equal(calls, 1, "unsubscribe is called exactly once per activation");
  });

  test("postMessage parsing rejects shapes it does not understand", () => {
    assert.deepEqual(parseHostMessage({ type: "teamchat:close" }), { type: "teamchat:close" });
    assert.equal(parseHostMessage({ type: "teamchat:token" }), null);
    assert.equal(parseHostMessage({ type: "teamchat:token", token: "t" }), null);
    assert.equal(parseHostMessage({ type: "nope" }), null);
    assert.equal(parseHostMessage("string"), null);
    assert.deepEqual(parseWidgetMessage({ type: "teamchat:ready", version: 1 }), {
      type: "teamchat:ready",
      version: 1,
    });
  });

  test("origin allowlist is exact after normalisation", () => {
    assert.equal(isAllowedOrigin("https://host.example", ["https://host.example/"]), true);
    assert.equal(isAllowedOrigin("https://host.example/", ["https://host.example"]), true);
    assert.equal(isAllowedOrigin("https://host.example.evil", ["https://host.example"]), false);
    assert.equal(isAllowedOrigin("http://host.example", ["https://host.example"]), false);
    assert.equal(isAllowedOrigin("not a url", ["https://host.example"]), false);
  });

  console.log(`\n${passed} lifecycle/protocol checks passed`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
