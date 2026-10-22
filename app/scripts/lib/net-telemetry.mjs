// Per-process socket and ephemeral-port telemetry for the S5 generator fleet.
//
// A WebSocket ramp can fail because the deployment refused it, or because one host ran out of
// local ports, file descriptors, or NAT mappings. Those look identical in a latency table, so
// every benchmark run records the host-side facts needed to tell them apart.
//
// This module is measurement-only. No product code imports it.
import { execFileSync } from "node:child_process";
import { networkInterfaces, platform } from "node:os";

const isWindows = platform() === "win32";

/** The OS ephemeral port range, verbatim from the platform command. */
export function dynamicPortRange() {
  try {
    if (isWindows) {
      const raw = execFileSync("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      const start = Number(raw.match(/Start Port\s*:\s*(\d+)/i)?.[1]);
      const count = Number(raw.match(/Number of Ports\s*:\s*(\d+)/i)?.[1]);
      return {
        raw,
        start: Number.isFinite(start) ? start : null,
        end: Number.isFinite(start) && Number.isFinite(count) ? start + count - 1 : null,
        count: Number.isFinite(count) ? count : null,
      };
    }
    const raw = execFileSync("sysctl", ["-n", "net.ipv4.ip_local_port_range"], {
      encoding: "utf8",
    }).trim();
    const [start, end] = raw.split(/\s+/).map(Number);
    return { raw, start: start ?? null, end: end ?? null, count: end - start + 1 };
  } catch (error) {
    return { raw: null, start: null, end: null, count: null, error: String(error.message ?? error) };
  }
}

/**
 * One netstat/ss snapshot.
 *
 * Windows attributes ESTABLISHED sockets to a PID but usually reports TIME_WAIT with PID 0, so
 * TIME_WAIT is attributed to the host, not to a generator. Reporting it per process would be a
 * fabricated attribution.
 */
export function sampleSockets({ pids = [], portRange = null } = {}) {
  const wanted = new Set(pids.map(String));
  const perPid = {};
  for (const pid of wanted) perPid[pid] = { established: 0, timeWait: 0, closeWait: 0, bound: 0 };

  const host = { established: 0, timeWait: 0, closeWait: 0, synSent: 0 };
  const localPorts = new Set();
  const ephemeralPorts = new Set();
  const inRange = (port) =>
    portRange && portRange.start !== null && portRange.end !== null
      ? port >= portRange.start && port <= portRange.end
      : port >= 49152 && port <= 65535;

  try {
    if (isWindows) {
      const raw = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      for (const line of raw.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 4 || columns[0].toUpperCase() !== "TCP") continue;
        const local = columns[1];
        const state = columns[3]?.toUpperCase();
        const pid = columns[4] ?? "0";
        const port = Number(local.slice(local.lastIndexOf(":") + 1));
        if (Number.isFinite(port)) {
          localPorts.add(port);
          if (inRange(port)) ephemeralPorts.add(port);
        }
        if (state === "ESTABLISHED") host.established += 1;
        else if (state === "TIME_WAIT") host.timeWait += 1;
        else if (state === "CLOSE_WAIT") host.closeWait += 1;
        else if (state === "SYN_SENT") host.synSent += 1;
        if (!wanted.has(pid)) continue;
        if (state === "ESTABLISHED") perPid[pid].established += 1;
        else if (state === "TIME_WAIT") perPid[pid].timeWait += 1;
        else if (state === "CLOSE_WAIT") perPid[pid].closeWait += 1;
        if (state === "ESTABLISHED" || state === "CLOSE_WAIT" || state === "SYN_SENT") {
          perPid[pid].bound += 1;
        }
      }
    } else {
      const raw = execFileSync("ss", ["-tan"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      for (const line of raw.split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5) continue;
        const state = columns[0].toUpperCase();
        const local = columns[3];
        const pidMatch = line.match(/pid=(\d+)/);
        const pid = pidMatch ? pidMatch[1] : "0";
        const port = Number(local.slice(local.lastIndexOf(":") + 1));
        if (Number.isFinite(port)) {
          localPorts.add(port);
          if (inRange(port)) ephemeralPorts.add(port);
        }
        if (state === "ESTAB") host.established += 1;
        else if (state === "TIME-WAIT") host.timeWait += 1;
        else if (state === "CLOSE-WAIT") host.closeWait += 1;
        else if (state === "SYN-SENT") host.synSent += 1;
        if (!wanted.has(pid)) continue;
        if (state === "ESTAB") perPid[pid].established += 1;
        else if (state === "TIME-WAIT") perPid[pid].timeWait += 1;
        else if (state === "CLOSE-WAIT") perPid[pid].closeWait += 1;
        if (state === "ESTAB" || state === "CLOSE-WAIT" || state === "SYN-SENT") perPid[pid].bound += 1;
      }
    }
  } catch (error) {
    return {
      error: String(error.message ?? error),
      perPid,
      host,
      localPortsUsed: localPorts.size,
      ephemeralPortsInUse: ephemeralPorts.size,
    };
  }

  return {
    perPid,
    host,
    localPortsUsed: localPorts.size,
    ephemeralPortsInUse: ephemeralPorts.size,
    ephemeralUtilization:
      portRange?.count && portRange.count > 0
        ? Number((ephemeralPorts.size / portRange.count).toFixed(4))
        : null,
  };
}

export function localAddresses() {
  const out = [];
  for (const [name, rows] of Object.entries(networkInterfaces())) {
    for (const row of rows ?? []) {
      if (row.internal) continue;
      out.push({ name, address: row.address, family: row.family, mac: row.mac });
    }
  }
  return out;
}

/**
 * Sample on an interval and stop cleanly. Returns the samples array and a stop function.
 * Sampling is sequential: a slow netstat is never overlapped with the next one.
 */
export function startSampler({ pids, intervalMs = 10_000 } = {}) {
  const portRange = dynamicPortRange();
  const samples = [];
  let stopped = false;
  let timer = null;

  const take = () => {
    if (stopped) return;
    const at = Date.now();
    const socket = sampleSockets({ pids, portRange });
    samples.push({ at, elapsedMs: at - (samples[0]?.at ?? at), ...socket });
    timer = setTimeout(take, intervalMs);
  };

  // Take one immediately so a zero-length run still has host facts.
  take();

  return {
    portRange,
    addresses: localAddresses(),
    samples,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      return { portRange, samples };
    },
  };
}
