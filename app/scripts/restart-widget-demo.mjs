// Restart the widget demo by port, not by remembered PID.
//
//   node scripts/restart-widget-demo.mjs
//
// Any process listening on the host or widget port is stopped, the helper waits until both
// ports stop answering, and only then does it start a new server. If the ports are still busy
// after the timeout, it exits non-zero without launching.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBusyPorts, killPortOwners, waitForPortsReleased } from "./lib/ports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const ports = [
  Number(process.env.WIDGET_DEMO_PORT ?? 4310),
  Number(process.env.WIDGET_WIDGET_PORT ?? 4311),
];

const busy = await findBusyPorts(ports);
const owners = new Map();
for (const { port, pids } of busy) {
  if (pids.length === 0) {
    console.error(`restart: port ${port} is in use but the owning PID could not be identified`);
    process.exit(1);
  }
  console.log(`restart: port ${port} is held by PID ${pids.join(", ")}`);
  for (const pid of pids) owners.set(pid, port);
}
for (const [pid, port] of owners) {
  for (const result of killPortOwners([pid])) {
    if (!result.stopped) {
      console.error(`restart: could not stop PID ${result.pid} (port ${port})`);
      process.exit(1);
    }
  }
}

const released = await waitForPortsReleased(ports, 15_000);
if (!released) {
  const stillBusy = await findBusyPorts(ports);
  for (const { port, pids } of stillBusy) {
    const owner = pids.length > 0 ? `PID ${pids.join(", ")}` : "unknown process";
    console.error(`restart: port ${port} is still in use by ${owner} after 15s`);
  }
  process.exit(1);
}

console.log(`restart: ${ports.join(" and ")} are free; starting the demo server`);
const child = spawn(process.execPath, [join(here, "widget-demo-server.mjs")], {
  cwd: appDir,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
