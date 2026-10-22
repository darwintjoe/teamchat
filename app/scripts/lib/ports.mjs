// Port ownership and release helpers for the widget demo tooling.
//
// The demo server and its restart helper share these so that "is this port taken, and by
// whom?" has exactly one answer on every platform.
import { execFileSync } from "node:child_process";
import { connect } from "node:net";

const PROBE_HOST = "127.0.0.1";

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: PROBE_HOST });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** PIDs listening on `port`, or [] when the port is free or the owner cannot be identified. */
export function findPortOwners(port) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5) continue;
        const [protocol, local, , state, pid] = columns;
        if (protocol.toUpperCase() !== "TCP") continue;
        if (state.toUpperCase() !== "LISTENING") continue;
        if (!local.endsWith(`:${port}`)) continue;
        const value = Number(pid);
        if (Number.isInteger(value) && value > 0) pids.add(value);
      }
      return [...pids];
    }
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    });
    return output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/** Ports that are currently accepting connections, with whatever owner PIDs we can name. */
export async function findBusyPorts(ports) {
  const busy = [];
  for (const port of ports) {
    if (await isPortOpen(port)) {
      busy.push({ port, pids: findPortOwners(port) });
    }
  }
  return busy;
}

export function killPortOwners(pids) {
  const results = [];
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
      results.push({ pid, stopped: true });
    } catch {
      // The same PID can own both ports; the first kill makes the second attempt fail.
      // Treat "already gone" as success and only report a real failure.
      results.push({ pid, stopped: !isProcessAlive(pid) });
    }
  }
  return results;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until nothing answers on any of the ports, or the timeout expires. */
export async function waitForPortsReleased(ports, timeoutMs = 15_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await findBusyPorts(ports);
    if (busy.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
