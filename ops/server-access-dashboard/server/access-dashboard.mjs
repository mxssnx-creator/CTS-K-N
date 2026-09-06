import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(SERVER_DIR, "..", "public");
const PORT = positiveInteger(process.env.PORT, 3004);
const HOST = process.env.HOST || "127.0.0.1";
const REFRESH_MS = positiveInteger(process.env.DASHBOARD_REFRESH_MS, 2_000);
const SERVICE_REFRESH_MS = positiveInteger(process.env.SERVICE_REFRESH_MS, 5_000);
const PROJECT_REFRESH_MS = positiveInteger(process.env.PROJECT_REFRESH_MS, 5_000);
const PROJECT_DETAIL_REFRESH_MS = positiveInteger(process.env.PROJECT_DETAIL_REFRESH_MS, 30_000);
const SERVICE_DISCOVERY_MS = positiveInteger(process.env.SERVICE_DISCOVERY_MS, 15_000);
const UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 32;
const PROJECT_MANIFEST_PATH = process.env.SERVER_DASHBOARD_PROJECT_MANIFEST || "/etc/server-access-dashboard/projects.json";
const MAX_HISTORY = 180;
const MAX_REQUEST_EVENTS = 4_096;
const MAX_LATENCY_SAMPLES = 1_024;
const MAX_STABILITY_EVENTS = 256;

const DEFAULT_SERVICE_NAMES = [
  "server-access-dashboard.service",
  "nginx.service",
  "redis-server.service",
  "chisel-server.service",
  "cts-kn.service",
  "cts-kn-direct-trade.service",
  "cts-kn-scheduler.service",
  "cts-g-desk.service",
  "cts-g-pulse-http.service",
  "cts-g-pulse@bingx-x01.service",
  "cts-g-pulse@bingx-x02.service",
  "grok-desk.service",
];

const DEFAULT_PROJECT_DEFINITIONS = [
  {
    id: "cts-kn",
    name: "CTS-K-N",
    role: "production trading application",
    kind: "cts-kn",
    baseUrl: "http://127.0.0.1:3002",
    port: 3002,
    connectionCatalogPath: "/api/connections",
    serviceIds: ["cts-kn.service", "cts-kn-direct-trade.service", "cts-kn-scheduler.service"],
  },
  {
    id: "cts-g",
    name: "CTS-G",
    role: "independent project / desk",
    kind: "cts-g",
    baseUrl: "http://127.0.0.1:3102",
    statsBaseUrl: "http://127.0.0.1:3015",
    port: 3102,
    connectionIds: ["bingx-x01", "bingx-x02"],
    serviceIds: ["cts-g-desk.service", "cts-g-pulse-http.service", "cts-g-pulse@bingx-x01.service", "cts-g-pulse@bingx-x02.service"],
  },
];

const SERVICE_NAMES = String(process.env.SERVER_DASHBOARD_SERVICES || "")
  .split(",")
  .map((value) => value.trim())
  .map(safeServiceName)
  .filter(Boolean)
  .slice(0, 32);
if (!SERVICE_NAMES.length) SERVICE_NAMES.push(...DEFAULT_SERVICE_NAMES.map(safeServiceName).filter(Boolean));

const REQUEST_EVENTS = [];
const LATENCY_SAMPLES = [];
const REQUEST_COUNTS = {
  total: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
  errors: 0,
};

const PROJECT_RUNTIME = new Map();
const SERVICE_RUNTIME = new Map();
const STABILITY = {
  startedAt: Date.now(),
  sampleCount: 0,
  serviceStateChanges: 0,
  projectStateChanges: 0,
  observedFailures: 0,
  events: [],
  lastEvent: null,
  lastError: "",
};

let previousCpu = null;
let previousNetwork = null;
let previousNetworkAt = 0;
let latestSnapshot = null;
let latestSnapshotAt = 0;
let snapshotPromise = null;
let servicesCache = [];
let servicesCacheAt = 0;
let servicesPromise = null;
let projectsCache = [];
let projectsCacheAt = 0;
let projectsPromise = null;
let discoveredServiceNames = [];
let discoveredServiceNamesAt = 0;
const connectionDetailCache = new Map();
const history = [];

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finiteNumber(value, min)));
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function parseKeyValueLines(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function safeProjectId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ? id : "";
}

function safeServiceName(value) {
  const name = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/.test(name) ? name : "";
}

function safePath(value, fallback) {
  const path = String(value || fallback || "").trim();
  return /^\/(?!\/)(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-])+$/.test(path) && !path.includes("..")
    ? path
    : fallback;
}

function normalizeProjectDefinition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeProjectId(value.id);
  if (!id) return null;
  let baseUrl = String(value.baseUrl || "").trim().replace(/\/$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) return null;
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
  const serviceIds = Array.isArray(value.serviceIds)
    ? [...new Set(value.serviceIds.map(safeServiceName).filter(Boolean))].slice(0, 24)
    : [];
  const kind = ["cts-kn", "cts-g", "generic"].includes(String(value.kind || ""))
    ? String(value.kind)
    : id === "cts-kn" ? "cts-kn" : id === "cts-g" ? "cts-g" : "generic";
  const connectionIds = Array.isArray(value.connectionIds)
    ? [...new Set(value.connectionIds.map((entry) => safeProjectId(entry)).filter(Boolean))].slice(0, 12)
    : [];
  const statsBaseUrl = String(value.statsBaseUrl || "").trim().replace(/\/$/, "");
  let safeStatsBaseUrl = "";
  if (statsBaseUrl) {
    try {
      const parsedStats = new URL(statsBaseUrl);
      if (["http:", "https:"].includes(parsedStats.protocol) &&
          !parsedStats.username && !parsedStats.password && !parsedStats.search && !parsedStats.hash &&
          ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedStats.hostname)) {
        safeStatsBaseUrl = parsedStats.toString().replace(/\/$/, "");
      }
    } catch {
      safeStatsBaseUrl = "";
    }
  }
  const port = positiveInteger(value.port, 0);
  return {
    id,
    name: sanitizeText(value.name, id),
    role: sanitizeText(value.role, "installed project"),
    kind,
    baseUrl,
    statsBaseUrl: safeStatsBaseUrl,
    port: port > 0 && port <= 65535 ? port : 0,
    serviceIds,
    connectionIds,
    healthPath: safePath(value.healthPath, "/api/health"),
    engineStatusPath: safePath(value.engineStatusPath, "/api/trade-engine/status"),
    connectionCatalogPath: safePath(value.connectionCatalogPath, "/api/connections"),
    connectionStatusPath: safePath(value.connectionStatusPath, "/api/connections/status"),
    connectionRuntimePath: safePath(value.connectionRuntimePath, "/api/connections/progression/{id}/stats?view=runtime"),
    connectionPnlPath: safePath(value.connectionPnlPath, "/api/trade-engine/pnl-stats?connection_id={id}"),
    connectionOverviewPath: safePath(value.connectionOverviewPath, "/api/connections/progression/{id}/stats?view=overview"),
    connectionStatsPath: safePath(value.connectionStatsPath, "/stats.json?conn={id}"),
  };
}

export function parseProjectManifest(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    const rows = Array.isArray(parsed) ? parsed : parsed?.projects;
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    return rows
      .map(normalizeProjectDefinition)
      .filter((row) => row && !seen.has(row.id) && seen.add(row.id))
      .slice(0, 16);
  } catch {
    return [];
  }
}

async function projectDefinitions() {
  const inline = String(process.env.SERVER_DASHBOARD_PROJECTS || "").trim();
  const configured = parseProjectManifest(inline || await readText(PROJECT_MANIFEST_PATH));
  if (configured.length) return configured;
  return DEFAULT_PROJECT_DEFINITIONS.map((definition) => ({ ...definition }));
}

export function parseMeminfo(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)(?:\s+(kB))?/);
    if (!match) continue;
    values[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  return values;
}

export function parseCpuStat(text) {
  const aggregate = [];
  const cores = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^(cpu)(\d*)\s+(.+)$/);
    if (!match) continue;
    const values = match[3].trim().split(/\s+/).map((value) => Number(value));
    if (!values.length || values.some((value) => !Number.isFinite(value))) continue;
    if (match[2] === "") aggregate.push(...values);
    else cores.push({ index: Number(match[2]), values });
  }
  cores.sort((left, right) => left.index - right.index);
  return { aggregate, cores };
}

function cpuCounter(values) {
  const safe = Array.isArray(values) ? values : [];
  const user = safe[0] || 0;
  const nice = safe[1] || 0;
  const system = safe[2] || 0;
  const idle = safe[3] || 0;
  const iowait = safe[4] || 0;
  const irq = safe[5] || 0;
  const softirq = safe[6] || 0;
  const steal = safe[7] || 0;
  return {
    values: safe,
    user,
    nice,
    system,
    idle,
    iowait,
    irq,
    softirq,
    steal,
    total: safe.reduce((sum, value) => sum + value, 0),
    idleTotal: idle + iowait,
  };
}

function cpuDelta(current, previous) {
  if (!previous) {
    return {
      percent: 0,
      userPercent: 0,
      systemPercent: 0,
      idlePercent: 0,
      iowaitPercent: 0,
      stealPercent: 0,
      deltaTicks: 0,
    };
  }
  const totalDelta = Math.max(0, current.total - previous.total);
  if (totalDelta <= 0) {
    return {
      percent: 0,
      userPercent: 0,
      systemPercent: 0,
      idlePercent: 0,
      iowaitPercent: 0,
      stealPercent: 0,
      deltaTicks: 0,
    };
  }
  const ratio = (value) => clamp(value / totalDelta * 100, 0, 100);
  const idleDelta = Math.max(0, current.idleTotal - previous.idleTotal);
  return {
    percent: clamp((1 - idleDelta / totalDelta) * 100, 0, 100),
    userPercent: ratio((current.user + current.nice) - (previous.user + previous.nice)),
    systemPercent: ratio(
      (current.system + current.irq + current.softirq) -
      (previous.system + previous.irq + previous.softirq),
    ),
    idlePercent: ratio(idleDelta),
    iowaitPercent: ratio(current.iowait - previous.iowait),
    stealPercent: ratio(current.steal - previous.steal),
    deltaTicks: totalDelta,
  };
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function sanitizeText(value, fallback = "") {
  const text = String(value || fallback)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return fallback;
  return text.length > 180 ? text.slice(0, 177) + "..." : text;
}

function safeError(error) {
  const code = error?.code ? String(error.code) : "unreachable";
  if (code === "ETIMEDOUT" || code === "ABORT_ERR") return "timeout";
  if (code === "ECONNREFUSED") return "connection_refused";
  return code.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function bytesToUnits(bytes) {
  const value = Math.max(0, finiteNumber(bytes));
  return {
    bytes: value,
    mib: value / 1024 / 1024,
    gib: value / 1024 / 1024 / 1024,
  };
}

async function readCpu() {
  const parsed = parseCpuStat(await readText("/proc/stat"));
  const currentAggregate = cpuCounter(parsed.aggregate);
  const currentCores = parsed.cores.map((entry) => ({
    index: entry.index,
    counter: cpuCounter(entry.values),
  }));
  const previous = previousCpu;
  const aggregateUsage = cpuDelta(currentAggregate, previous?.aggregate);
  const previousCores = previous?.cores || new Map();
  const hostCpus = os.cpus();
  const perCore = currentCores.map((entry, position) => {
    const usage = cpuDelta(entry.counter, previousCores.get(entry.index));
    return {
      index: entry.index,
      label: "CPU" + entry.index,
      model: sanitizeText(hostCpus[position]?.model, ""),
      speedMHz: finiteNumber(hostCpus[position]?.speed),
      percent: usage.percent,
      userPercent: usage.userPercent,
      systemPercent: usage.systemPercent,
      idlePercent: usage.idlePercent,
      iowaitPercent: usage.iowaitPercent,
      stealPercent: usage.stealPercent,
      deltaTicks: usage.deltaTicks,
      totalTicks: entry.counter.total,
    };
  });
  previousCpu = {
    aggregate: currentAggregate,
    cores: new Map(currentCores.map((entry) => [entry.index, entry.counter])),
    takenAt: Date.now(),
  };
  return {
    percent: aggregateUsage.percent,
    userPercent: aggregateUsage.userPercent,
    systemPercent: aggregateUsage.systemPercent,
    idlePercent: aggregateUsage.idlePercent,
    iowaitPercent: aggregateUsage.iowaitPercent,
    stealPercent: aggregateUsage.stealPercent,
    deltaTicks: aggregateUsage.deltaTicks,
    totalTicks: currentAggregate.total,
    cores: perCore.length || hostCpus.length,
    model: sanitizeText(hostCpus[0]?.model, ""),
    sampleIntervalMs: previous ? Math.max(0, Date.now() - previous.takenAt) : 0,
    perCore,
  };
}

async function readMemory() {
  const values = parseMeminfo(await readText("/proc/meminfo"));
  const totalBytes = values.MemTotal || 0;
  const freeBytes = values.MemFree || 0;
  const availableBytes = values.MemAvailable ?? Math.max(
    0,
    totalBytes - freeBytes - (values.Buffers || 0) - (values.Cached || 0),
  );
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotalBytes = values.SwapTotal || 0;
  const swapFreeBytes = values.SwapFree || 0;
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);
  const exact = {
    total: bytesToUnits(totalBytes),
    used: bytesToUnits(usedBytes),
    available: bytesToUnits(availableBytes),
    free: bytesToUnits(freeBytes),
    buffers: bytesToUnits(values.Buffers || 0),
    cached: bytesToUnits(values.Cached || 0),
    reclaimable: bytesToUnits(values.SReclaimable || 0),
    swapTotal: bytesToUnits(swapTotalBytes),
    swapUsed: bytesToUnits(swapUsedBytes),
    swapFree: bytesToUnits(swapFreeBytes),
  };
  return {
    exact,
    totalBytes,
    usedBytes,
    availableBytes,
    freeBytes,
    buffersBytes: values.Buffers || 0,
    cachedBytes: values.Cached || 0,
    reclaimableBytes: values.SReclaimable || 0,
    usedPercent: totalBytes ? clamp(usedBytes / totalBytes * 100, 0, 100) : 0,
    swapTotalBytes,
    swapUsedBytes,
    swapFreeBytes,
    swapUsedPercent: swapTotalBytes ? clamp(swapUsedBytes / swapTotalBytes * 100, 0, 100) : 0,
    committedBytes: values.Committed_AS || 0,
    dirtyBytes: values.Dirty || 0,
    writebackBytes: values.Writeback || 0,
  };
}

async function readLoad() {
  const parts = (await readText("/proc/loadavg")).trim().split(/\s+/);
  const runnable = String(parts[3] || "").split("/");
  return {
    one: finiteNumber(parts[0]),
    five: finiteNumber(parts[1]),
    fifteen: finiteNumber(parts[2]),
    runnable: finiteNumber(runnable[0]),
    processes: finiteNumber(runnable[1]),
  };
}

async function readNetwork() {
  const text = await readText("/proc/net/dev");
  let rxBytes = 0;
  let txBytes = 0;
  let rxPackets = 0;
  let txPackets = 0;
  for (const line of text.split(/\r?\n/).slice(2)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const values = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    if (values.length < 10) continue;
    rxBytes += finiteNumber(values[0]);
    rxPackets += finiteNumber(values[1]);
    txBytes += finiteNumber(values[8]);
    txPackets += finiteNumber(values[9]);
  }
  const now = Date.now();
  const elapsed = previousNetworkAt ? Math.max(0.001, (now - previousNetworkAt) / 1000) : 0;
  const previous = previousNetwork;
  previousNetwork = { rxBytes, txBytes };
  previousNetworkAt = now;
  return {
    rx: bytesToUnits(rxBytes),
    tx: bytesToUnits(txBytes),
    rxBytes,
    txBytes,
    rxPackets,
    txPackets,
    rxKiBps: previous && elapsed ? Math.max(0, (rxBytes - previous.rxBytes) / 1024 / elapsed) : 0,
    txKiBps: previous && elapsed ? Math.max(0, (txBytes - previous.txBytes) / 1024 / elapsed) : 0,
  };
}

function parseProcStatus(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  const kiloBytes = (value) => {
    const match = String(value || "").match(/^(\d+)\s+kB$/i);
    return match ? Number(match[1]) * 1024 : 0;
  };
  return {
    rssBytes: kiloBytes(values.VmRSS),
    virtualBytes: kiloBytes(values.VmSize),
    threads: positiveInteger(values.Threads, 0),
  };
}

async function readProcess(pid) {
  if (!pid) return null;
  const [statusText, statText, commandText] = await Promise.all([
    readText("/proc/" + pid + "/status"),
    readText("/proc/" + pid + "/stat"),
    readText("/proc/" + pid + "/cmdline"),
  ]);
  if (!statusText && !statText) return null;
  const status = parseProcStatus(statusText);
  const closingParen = statText.lastIndexOf(") ");
  const statFields = closingParen >= 0 ? statText.slice(closingParen + 2).trim().split(/\s+/) : [];
  const userTicks = finiteNumber(statFields[11]);
  const systemTicks = finiteNumber(statFields[12]);
  const startTicks = finiteNumber(statFields[19]);
  return {
    pid,
    rss: bytesToUnits(status.rssBytes),
    virtual: bytesToUnits(status.virtualBytes),
    rssBytes: status.rssBytes,
    virtualBytes: status.virtualBytes,
    threads: status.threads,
    userTicks,
    systemTicks,
    cpuTicks: userTicks + systemTicks,
    startTicks,
    command: sanitizeText(commandText.replace(/\0/g, " "), ""),
  };
}

function recordStabilityEvent(kind, id, from, to) {
  const event = {
    at: new Date().toISOString(),
    kind,
    id,
    from: from || "initial",
    to,
  };
  STABILITY.events.push(event);
  while (STABILITY.events.length > MAX_STABILITY_EVENTS) STABILITY.events.shift();
  STABILITY.lastEvent = event;
  if (to === "failed" || to === "unknown" || to === "down") {
    STABILITY.observedFailures++;
    STABILITY.lastError = kind + ":" + id + " -> " + to;
  }
}

function observeRuntime(map, kind, id, state) {
  const previous = map.get(id);
  const stateChanged = Boolean(previous && previous.state !== state);
  if (stateChanged) {
    if (kind === "service") STABILITY.serviceStateChanges++;
    else STABILITY.projectStateChanges++;
    recordStabilityEvent(kind, id, previous.state, state);
  }
  const runtime = {
    state,
    checks: (previous?.checks || 0) + 1,
    failures: (previous?.failures || 0) + (["failed", "unknown", "down"].includes(state) ? 1 : 0),
    stateChanges: (previous?.stateChanges || 0) + (stateChanged ? 1 : 0),
    lastOkAt: state === "up" || state === "active" || state === "running"
      ? new Date().toISOString()
      : previous?.lastOkAt || "",
    lastFailureAt: ["failed", "unknown", "down"].includes(state)
      ? new Date().toISOString()
      : previous?.lastFailureAt || "",
    lastError: previous?.lastError || "",
  };
  map.set(id, runtime);
  return runtime;
}

async function systemdService(name) {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "show",
      name,
      "--no-pager",
      "-p", "ActiveState",
      "-p", "SubState",
      "-p", "MainPID",
      "-p", "MemoryCurrent",
      "-p", "MemoryPeak",
      "-p", "CPUUsageNSec",
      "-p", "TasksCurrent",
      "-p", "NRestarts",
      "-p", "ExecMainStatus",
      "-p", "Result",
      "-p", "ActiveEnterTimestamp",
    ], { timeout: 1_500, maxBuffer: 32 * 1024 });
    const values = parseKeyValueLines(stdout);
    const state = values.ActiveState || "missing";
    const pid = positiveInteger(values.MainPID, 0);
    const memoryBytes = Math.max(0, finiteNumber(values.MemoryCurrent));
    const memoryPeakBytes = Math.max(0, finiteNumber(values.MemoryPeak));
    const runtime = observeRuntime(
      SERVICE_RUNTIME,
      "service",
      name,
      state === "missing" ? "unknown" : state,
    );
    return {
      id: name,
      name: name.replace(/\.service$/, ""),
      state,
      subState: values.SubState || "unknown",
      pid,
      memory: bytesToUnits(memoryBytes),
      memoryBytes,
      memoryPeak: bytesToUnits(memoryPeakBytes),
      memoryPeakBytes,
      cpuSeconds: finiteNumber(values.CPUUsageNSec) / 1e9,
      tasks: Math.max(0, finiteNumber(values.TasksCurrent)),
      restarts: Math.max(0, finiteNumber(values.NRestarts)),
      exitStatus: sanitizeText(values.ExecMainStatus, ""),
      result: sanitizeText(values.Result, ""),
      since: sanitizeText(values.ActiveEnterTimestamp),
      process: await readProcess(pid),
      activity: {
        checks: runtime.checks,
        failures: runtime.failures,
        stateChanges: runtime.stateChanges,
        lastOkAt: runtime.lastOkAt,
        lastFailureAt: runtime.lastFailureAt,
      },
    };
  } catch (error) {
    const runtime = observeRuntime(SERVICE_RUNTIME, "service", name, "unknown");
    return {
      id: name,
      name: name.replace(/\.service$/, ""),
      state: "unknown",
      subState: safeError(error),
      pid: 0,
      memory: bytesToUnits(0),
      memoryBytes: 0,
      memoryPeak: bytesToUnits(0),
      memoryPeakBytes: 0,
      cpuSeconds: 0,
      tasks: 0,
      restarts: 0,
      exitStatus: "",
      result: "",
      since: "",
      process: null,
      activity: {
        checks: runtime.checks,
        failures: runtime.failures,
        stateChanges: runtime.stateChanges,
        lastOkAt: runtime.lastOkAt,
        lastFailureAt: runtime.lastFailureAt,
      },
      error: safeError(error),
    };
  }
}

async function discoverServiceNames() {
  const now = Date.now();
  if (discoveredServiceNamesAt + SERVICE_DISCOVERY_MS > now) return discoveredServiceNames;
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "list-unit-files",
      "--type=service",
      "--no-legend",
      "--no-pager",
    ], { timeout: 2_000, maxBuffer: 128 * 1024 });
    const prefixes = String(process.env.SERVER_DASHBOARD_SERVICE_PREFIXES || "server-access-dashboard,nginx,redis-server,chisel-server,cts-,grok-")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    discoveredServiceNames = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => safeServiceName(line.trim().split(/\s+/)[0]))
      .filter((name) => name && prefixes.some((prefix) => name.startsWith(prefix)))
      .slice(0, 64);
    discoveredServiceNamesAt = now;
  } catch {
    discoveredServiceNames = [];
    discoveredServiceNamesAt = now;
  }
  return discoveredServiceNames;
}

async function readServices() {
  const [definitions, discovered] = await Promise.all([projectDefinitions(), discoverServiceNames()]);
  const names = [...new Set([
    ...SERVICE_NAMES,
    ...definitions.flatMap((definition) => definition.serviceIds || []),
    ...discovered,
  ])].map(safeServiceName).filter(Boolean).slice(0, 64);
  return Promise.all(names.map(systemdService));
}

function latestRequestCount(windowMs) {
  const cutoff = Date.now() - windowMs;
  return REQUEST_EVENTS.reduce((count, timestamp) => count + (timestamp >= cutoff ? 1 : 0), 0);
}

function requestStats() {
  const samples = LATENCY_SAMPLES.slice(-MAX_LATENCY_SAMPLES);
  const total = REQUEST_COUNTS.total;
  return {
    total,
    last1m: latestRequestCount(60_000),
    last5m: latestRequestCount(300_000),
    perSecond1m: latestRequestCount(60_000) / 60,
    status2xx: REQUEST_COUNTS.status2xx,
    status3xx: REQUEST_COUNTS.status3xx,
    status4xx: REQUEST_COUNTS.status4xx,
    status5xx: REQUEST_COUNTS.status5xx,
    errors: REQUEST_COUNTS.errors,
    errorRatePercent: total ? REQUEST_COUNTS.errors / total * 100 : 0,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.length ? Math.max(...samples) : 0,
  };
}

async function fetchWithTimeout(url, timeoutMs = 1_800, bodyMode = "json") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: bodyMode === "json" ? "application/json" : "text/html" },
    });
    const latencyMs = performance.now() - started;
    const advertisedLength = Number(response.headers.get("content-length") || 0);
    if (advertisedLength > UPSTREAM_MAX_BYTES) {
      return { ok: false, status: response.status, latencyMs, error: "upstream_payload_too_large" };
    }
    if (bodyMode === "json") {
      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.byteLength > UPSTREAM_MAX_BYTES) {
        return { ok: false, status: response.status, latencyMs, error: "upstream_payload_too_large" };
      }
      const data = JSON.parse(new TextDecoder().decode(raw) || "null");
      return { ok: response.ok, status: response.status, latencyMs, data };
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > UPSTREAM_MAX_BYTES) {
      return { ok: false, status: response.status, latencyMs, error: "upstream_payload_too_large" };
    }
    return { ok: response.ok, status: response.status, latencyMs, data: null };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: performance.now() - started,
      error: safeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractIds(status) {
  const idsFrom = (value) => {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry?.id || entry?.connectionId || "").trim());
    }
    if (value && typeof value === "object") {
      return Object.keys(value).map((id) => String(id).trim());
    }
    return [];
  };
  if (Array.isArray(status)) {
    return [...new Set(
      idsFrom(status).filter(Boolean),
    )].slice(0, MAX_CONNECTIONS);
  }
  const candidates = [
    ...idsFrom(status?.connections),
    ...idsFrom(status?.engines),
    ...idsFrom(status?.statuses),
  ];
  return [...new Set(
    candidates
      .filter(Boolean),
  )].slice(0, MAX_CONNECTIONS);
}

export function progressionSummary(data) {
  const historic = data?.historic || data?.prehistoric || data?.progression?.prehistoricProgress || {};
  const progression = data?.progression || {};
  const state = data?.state || {};
  const percent = finiteNumber(
    historic.progressPercent ?? historic.percentComplete ?? progression.progress ?? data?.progressPercent,
    0,
  );
  const processed = finiteNumber(historic.symbolsProcessed ?? progression.symbolsProcessed, 0);
  const total = finiteNumber(historic.symbolsTotal ?? progression.symbolsTotal, 0);
  const configCompleted = finiteNumber(historic.configWork?.completed ?? historic.config_work_units_completed, 0);
  const configTotal = finiteNumber(historic.configWork?.total ?? historic.config_work_units_total, 0);
  const phase = sanitizeText(
    historic.currentStage || progression.phase || state.phase || (historic.isComplete ? "ready" : "warming up"),
    "unknown",
  );
  const cycles = finiteNumber(data?.realtime?.realtimeCycles ?? state.cyclesCompleted ?? progression.cycles, 0);
  return {
    percent: clamp(percent, 0, 100),
    processed,
    total,
    configCompleted,
    configTotal,
    phase,
    cycles,
    complete: Boolean(historic.isComplete || percent >= 100 || phase === "ready"),
  };
}

function replaceTemplate(path, id) {
  return String(path || "").replaceAll("{id}", encodeURIComponent(id));
}

function endpoint(definition, key, id = "") {
  const path = replaceTemplate(definition[key], id);
  return definition.baseUrl + (path.startsWith("/") ? path : "/" + path);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function profitFactorWindow(rows, window) {
  const sample = (Array.isArray(rows) ? rows : [])
    .filter((row) => finiteOrNull(row?.pnl) !== null)
    .slice(0, Math.max(1, Math.floor(Number(window) || 1)));
  let grossProfit = 0;
  let grossLoss = 0;
  for (const row of sample) {
    const pnl = Number(row.pnl);
    if (pnl > 0) grossProfit += pnl;
    else if (pnl < 0) grossLoss += Math.abs(pnl);
  }
  return {
    value: grossLoss > 0 ? grossProfit / grossLoss : null,
    infinite: grossLoss === 0 && grossProfit > 0,
    samples: sample.length,
    available: sample.length >= Math.max(1, Math.floor(Number(window) || 1)),
  };
}

function statusRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.statuses)) return data.statuses;
  if (Array.isArray(data?.connections)) return data.connections;
  return [];
}

function compactStageMetrics(overview, pnl) {
  const stage = overview?.realtimeStageAverages?.stages || {};
  const performance = overview?.performanceTiers || {};
  const stageOverview = overview?.connectionStageOverview || {};
  const realStage = stage.real || {};
  const liveStage = stage.live || {};
  const realOverallDdt = finiteOrNull(performance.real?.avgDrawdownMin ?? realStage.averages?.drawdownMinutes);
  const realSetsDdt = finiteOrNull(realStage.averages?.drawdownMinutes ?? performance.real?.avgDrawdownMin);
  const liveAverageDdt = finiteOrNull(performance.live?.avgDrawdownMin ?? liveStage.averages?.drawdownMinutes);
  const liveStats = pnl?.stats || {};
  const lastRows = Array.isArray(liveStats.last_25_positions) ? liveStats.last_25_positions : [];
  const pf8 = profitFactorWindow(lastRows, 8);
  return {
    realValid: Math.max(0, finiteNumber(stageOverview.real?.valid, 0)),
    realActive: Math.max(0, finiteNumber(stageOverview.real?.active, 0)),
    baseValid: Math.max(0, finiteNumber(stageOverview.base?.valid, 0)),
    basePfMinimum: finiteNumber(stageOverview.base?.pfMinimum, 0.8),
    liveOpen: Math.max(0, finiteNumber(liveStats.open_positions, 0)),
    exchangeOpen: finiteOrNull(liveStats.open_exchange_positions),
    exchangeOpenSource: sanitizeText(liveStats.open_positions_source, "unknown"),
    unrealizedPnl: finiteNumber(liveStats.unrealized_pnl, 0),
    pf: {
      last8: pf8,
      last25: {
        value: finiteOrNull(liveStats.profit_factor_last_25),
        infinite: liveStats.profit_factor_last_25_infinite === true,
        samples: Math.min(25, lastRows.length),
        available: Math.min(25, lastRows.length) >= 25,
      },
      last75: {
        value: finiteOrNull(liveStats.profit_factor_last_75),
        infinite: liveStats.profit_factor_last_75_infinite === true,
        samples: Math.min(75, Number(liveStats.settled_closed_positions || 0)),
        available: Number(liveStats.settled_closed_positions || 0) >= 75,
      },
    },
    averageDdt: {
      // `real` is the current set/overall stage aggregate. Live's endpoint
      // labels its holding-time aggregate drawdownMinutes for compatibility;
      // retain both and never present it as a Real-stage value.
      overallMinutes: realOverallDdt,
      setsMinutes: realSetsDdt,
      liveOutcomeMinutes: liveAverageDdt,
      samples: {
        realSets: finiteNumber(realStage.samples?.sets, 0),
        liveOutcomes: finiteNumber(liveStage.samples?.outcomes, 0),
      },
    },
    accounting: {
      complete: liveStats.accounting_complete !== false,
      coveragePercent: finiteNumber(liveStats.accounting_coverage_percent, 0),
      pending: Math.max(0, finiteNumber(liveStats.accounting_pending, 0)),
    },
    stageCoverage: stageOverview.snapshot?.coverage || overview?.strategyRows?.snapshot?.coverage || null,
  };
}

async function readConnectionDetails(definition, id, statusRow) {
  const now = Date.now();
  const cached = connectionDetailCache.get(definition.id + ":" + id);
  const runtimeRequest = fetchWithTimeout(endpoint(definition, "connectionRuntimePath", id), 2_500);
  const pnlRequest = fetchWithTimeout(endpoint(definition, "connectionPnlPath", id), 2_500);
  const overviewRequest = !cached || now - cached.overviewAt >= PROJECT_DETAIL_REFRESH_MS
    ? fetchWithTimeout(endpoint(definition, "connectionOverviewPath", id), 4_500)
    : Promise.resolve({ ok: Boolean(cached.overview), status: 200, latencyMs: 0, data: cached.overview });
  const [runtime, pnl, overview] = await Promise.all([runtimeRequest, pnlRequest, overviewRequest]);
  const runtimeData = runtime.ok ? runtime.data : cached?.runtime || {};
  const pnlData = pnl.ok ? pnl.data : cached?.pnl || {};
  const overviewData = overview.ok ? overview.data : cached?.overview || {};
  const detail = {
    id,
    name: sanitizeText(statusRow?.name, id),
    exchange: sanitizeText(statusRow?.exchange, "unknown"),
    assigned: statusRow?.assigned === true,
    processingEnabled: statusRow?.processingEnabled !== false,
    status: sanitizeText(statusRow?.status, runtimeData?.runtime?.engineRunning ? "running" : "unknown"),
    heartbeatFresh: statusRow?.heartbeatFresh === true,
    progress: progressionSummary(runtimeData),
    runtime: {
      generation: runtimeData?.generation || {},
      realtime: runtimeData?.realtime || {},
      settingsRecoordination: runtimeData?.settingsRecoordination || {},
      statsRecalculation: runtimeData?.statsRecalculation || {},
      telemetry: runtimeData?.runtime || {},
    },
    stats: compactStageMetrics(overviewData, pnlData),
    upstream: {
      runtime: runtime.ok,
      pnl: pnl.ok,
      overview: overview.ok,
      errors: [runtime, pnl, overview].filter((result) => !result.ok).map((result) => result.error || "unavailable"),
    },
  };
  connectionDetailCache.set(definition.id + ":" + id, {
    checkedAt: now,
    runtime: runtimeData,
    pnl: pnlData,
    overview: overviewData,
    overviewAt: overview.ok ? now : cached?.overviewAt || 0,
  });
  while (connectionDetailCache.size > 128) connectionDetailCache.delete(connectionDetailCache.keys().next().value);
  return detail;
}

function projectActivity(id, state, error = "") {
  const current = observeRuntime(PROJECT_RUNTIME, "project", id, state);
  current.lastError = error || current.lastError || "";
  PROJECT_RUNTIME.set(id, current);
  return {
    checks: current.checks,
    failures: current.failures,
    failureRatePercent: current.checks ? current.failures / current.checks * 100 : 0,
    stateChanges: current.stateChanges || 0,
    lastOkAt: current.lastOkAt,
    lastFailureAt: current.lastFailureAt,
    lastError: current.lastError,
  };
}

function projectDefinition(id) {
  const base = DEFAULT_PROJECT_DEFINITIONS.find((definition) => definition.id === id) || DEFAULT_PROJECT_DEFINITIONS[0];
  const envBase = id === "cts-kn" ? process.env.CTS_KN_BASE_URL : process.env.CTS_G_BASE_URL;
  const envPort = id === "cts-kn" ? process.env.CTS_KN_PORT : process.env.CTS_G_PORT;
  return {
    ...base,
    baseUrl: String(envBase || base.baseUrl).replace(/\/$/, ""),
    port: positiveInteger(envPort, base.port),
    serviceIds: [...base.serviceIds],
  };
}

function publicProjectDefinition(definition) {
  return {
    id: definition.id,
    name: definition.name,
    role: definition.role,
    kind: definition.kind,
    port: definition.port,
    serviceIds: definition.serviceIds,
    connectionIds: definition.connectionIds || [],
  };
}

async function readCtsKnProject(definition = projectDefinition("cts-kn")) {
  const started = performance.now();
  const health = await fetchWithTimeout(endpoint(definition, "healthPath"), 2_200);
  if (!health.ok) {
    const activity = projectActivity(definition.id, "down", health.error || "unhealthy");
    return {
      ...publicProjectDefinition(definition),
      status: "down",
      httpStatus: health.status,
      latencyMs: health.latencyMs,
      error: health.error || "unhealthy",
      health: { status: "unreachable", redis: "unknown" },
      engine: { running: false, status: "unavailable", connections: 0 },
      progress: [],
      activity,
      links: [{ label: "port 3002", port: 3002 }],
    };
  }
  const [engine, catalogResult, statusResult] = await Promise.all([
    fetchWithTimeout(endpoint(definition, "engineStatusPath"), 2_500),
    fetchWithTimeout(endpoint(definition, "connectionCatalogPath"), 2_500),
    fetchWithTimeout(endpoint(definition, "connectionStatusPath"), 2_500),
  ]);
  const catalogList = statusRows(catalogResult.ok ? catalogResult.data : null);
  const statusList = statusRows(statusResult.ok ? statusResult.data : null);
  const statusById = new Map(
    [...catalogList, ...statusList]
      .map((row) => [String(row?.id || row?.connectionId || "").trim(), row])
      .filter(([id]) => id),
  );
  const ids = [...new Set([
    ...extractIds(engine.data),
    ...catalogList.map((row) => String(row?.id || row?.connectionId || "").trim()).filter(Boolean),
    ...statusList.map((row) => String(row?.id || row?.connectionId || "").trim()).filter(Boolean),
    ...(definition.connectionIds || []),
  ])].slice(0, MAX_CONNECTIONS);
  const connections = await Promise.all(ids.map((id) => readConnectionDetails(definition, id, statusById.get(id) || {})));
  const progressRows = connections.map((connection) => ({
    id: connection.id,
    summary: connection.progress,
    latencyMs: 0,
    error: connection.upstream.errors.length ? connection.upstream.errors.join(", ") : "",
  }));
  const projectStatus = health.data?.status === "healthy" && engine.ok ? "up" : "degraded";
  const activity = projectActivity(definition.id, projectStatus, engine.ok ? "" : engine.error || "engine_unavailable");
  return {
    ...publicProjectDefinition(definition),
    status: projectStatus,
    httpStatus: health.status,
    latencyMs: performance.now() - started,
    error: engine.ok ? "" : engine.error || "engine_unavailable",
    health: {
      status: sanitizeText(health.data?.status, "unknown"),
      redis: health.data?.redis?.healthy === true
        ? "healthy"
        : sanitizeText(health.data?.redis?.status, "unknown"),
      uptimeS: finiteNumber(health.data?.uptimeS ?? health.data?.uptime),
    },
    engine: {
      running: engine.data?.running === true || engine.data?.status === "running",
      status: sanitizeText(engine.data?.status, engine.ok ? "available" : "unavailable"),
      connections: ids.length,
      ids,
    },
    progress: progressRows,
    connections,
    activity,
    links: [{ label: "port " + definition.port, port: definition.port }],
  };
}

async function readCtsGProject(definition = projectDefinition("cts-g")) {
  const started = performance.now();
  const health = await fetchWithTimeout(endpoint(definition, "healthPath"), 1_800);
  const ids = definition.connectionIds || [];
  const connections = definition.statsBaseUrl
    ? await Promise.all(ids.map(async (id) => {
      const result = await fetchWithTimeout(
        definition.statsBaseUrl + replaceTemplate(definition.connectionStatsPath, id),
        2_000,
      );
      const stats = result.ok && result.data && typeof result.data === "object" ? result.data : {};
      const closed = Array.isArray(stats.closed) ? stats.closed : [];
      const pf8 = profitFactorWindow(closed, 8);
      const pf25 = profitFactorWindow(closed, 25);
      const pf75 = profitFactorWindow(closed, 75);
      const settings = stats.sets || {};
      const progress = settings.progress || {};
      return {
        id,
        name: id === "bingx-x01" ? "CTS-G Mainnet" : id === "bingx-x02" ? "CTS-G VST" : id,
        exchange: stats.exchange || "BingX",
        assigned: result.ok,
        processingEnabled: result.ok,
        status: result.ok && stats.running && !stats.halted ? "running" : result.ok ? "inactive" : "unavailable",
        heartbeatFresh: result.ok,
        progress: {
          percent: clamp(progress.pct, 0, 100),
          processed: finiteNumber(progress.symbolsDone, 0),
          total: finiteNumber(progress.symbolsTotal, 0),
          configCompleted: finiteNumber(progress.setsDone, 0),
          configTotal: finiteNumber(progress.setsTotal, 0),
          phase: sanitizeText(progress.phase, stats.mode || "unknown"),
          cycles: finiteNumber(progress.cycle, 0),
          complete: Boolean(progress.ready),
        },
        runtime: {
          generation: {},
          realtime: { realtimeCycles: finiteNumber(stats.cycle, 0) },
          settingsRecoordination: {},
          statsRecalculation: {},
          telemetry: { scanMs: finiteNumber(stats.scanMs, 0), rssMb: finiteNumber(stats.rssMb, 0) },
        },
        stats: {
          realValid: finiteNumber(settings.validatedCount, 0),
          realActive: finiteNumber(settings.activeCount, 0),
          baseValid: finiteNumber(settings.setCount, 0),
          basePfMinimum: 0.8,
          liveOpen: finiteNumber(stats.openCount, 0),
          exchangeOpen: finiteOrNull(stats.exchangeOpenCount),
          exchangeOpenSource: "cts-g-stats",
          unrealizedPnl: finiteNumber(stats.unrealized, 0),
          pf: { last8: pf8, last25: pf25, last75: pf75 },
          averageDdt: {
            overallMinutes: finiteOrNull(stats.avgDrawdownMin ?? stats.avgDrawdownTime),
            setsMinutes: finiteOrNull(settings.avgDrawdownMin ?? settings.avgDrawdownTime),
            liveOutcomeMinutes: null,
            samples: { realSets: finiteNumber(settings.setCount, 0), liveOutcomes: closed.length },
          },
          accounting: { complete: true, coveragePercent: 100, pending: 0 },
          stageCoverage: null,
        },
        upstream: { runtime: result.ok, pnl: result.ok, overview: result.ok, errors: result.ok ? [] : [result.error || "unavailable"] },
      };
    }))
    : [];
  if (health.ok) {
    const activity = projectActivity(definition.id, "up");
    return {
      ...publicProjectDefinition(definition),
      status: "up",
      httpStatus: health.status,
      latencyMs: performance.now() - started,
      error: "",
      health: {
        status: sanitizeText(health.data?.status, "healthy"),
        uptimeS: finiteNumber(health.data?.uptimeS ?? health.data?.uptime),
      },
      engine: { running: connections.some((connection) => connection.status === "running"), status: "available", connections: connections.length, ids },
      progress: [],
      connections,
      activity,
      links: [{ label: "port " + definition.port, port: definition.port }],
    };
  }
  const root = await fetchWithTimeout(definition.baseUrl + "/", 1_800, "html");
  const state = root.ok ? "up" : "down";
  const activity = projectActivity(definition.id, state, root.ok ? "" : root.error || health.error || "unhealthy");
  return {
    ...publicProjectDefinition(definition),
    status: state,
    httpStatus: root.status || health.status,
    latencyMs: performance.now() - started,
    error: root.ok ? "" : root.error || health.error || "unhealthy",
    health: { status: root.ok ? "healthy" : "unreachable" },
    engine: { running: connections.some((connection) => connection.status === "running"), status: "not_reported", connections: connections.length, ids },
    progress: [],
    connections,
    activity,
    links: [{ label: "port " + definition.port, port: definition.port }],
  };
}

async function readGenericProject(definition) {
  const started = performance.now();
  const health = await fetchWithTimeout(endpoint(definition, "healthPath"), 1_800);
  const root = health.ok ? health : await fetchWithTimeout(definition.baseUrl + "/", 1_800, "html");
  const state = root.ok ? "up" : "down";
  const activity = projectActivity(definition.id, state, root.ok ? "" : root.error || "unhealthy");
  return {
    ...publicProjectDefinition(definition),
    status: state,
    httpStatus: root.status,
    latencyMs: performance.now() - started,
    error: root.ok ? "" : root.error || "unhealthy",
    health: { status: root.ok ? "healthy" : "unreachable" },
    engine: { running: false, status: "not_reported", connections: 0, ids: definition.connectionIds || [] },
    progress: [],
    connections: [],
    activity,
    links: definition.port ? [{ label: "port " + definition.port, port: definition.port }] : [],
  };
}

async function readProjects() {
  const definitions = await projectDefinitions();
  return Promise.all(definitions.map((definition) => {
    if (definition.kind === "cts-kn") return readCtsKnProject(definition);
    if (definition.kind === "cts-g") return readCtsGProject(definition);
    return readGenericProject(definition);
  }));
}

async function cachedServices() {
  const now = Date.now();
  if (servicesCacheAt + SERVICE_REFRESH_MS > now) return servicesCache;
  if (!servicesPromise) {
    servicesPromise = readServices().then((value) => {
      servicesCache = value;
      servicesCacheAt = Date.now();
      return value;
    }).finally(() => { servicesPromise = null; });
  }
  return servicesPromise;
}

async function cachedProjects() {
  const now = Date.now();
  if (projectsCacheAt + PROJECT_REFRESH_MS > now) return projectsCache;
  if (!projectsPromise) {
    projectsPromise = readProjects().then((value) => {
      projectsCache = value;
      projectsCacheAt = Date.now();
      return value;
    }).finally(() => { projectsPromise = null; });
  }
  return projectsPromise;
}

function stabilitySnapshot() {
  const now = Date.now();
  const sampleWindowS = Math.max(1, (now - STABILITY.startedAt) / 1000);
  const serviceChecks = [...SERVICE_RUNTIME.values()].reduce((sum, row) => sum + row.checks, 0);
  const projectChecks = [...PROJECT_RUNTIME.values()].reduce((sum, row) => sum + row.checks, 0);
  return {
    state: STABILITY.lastError ? "attention" : "stable",
    dashboardUptimeS: process.uptime(),
    sampleCount: STABILITY.sampleCount,
    sampleWindowS,
    samplesPerMinute: STABILITY.sampleCount / sampleWindowS * 60,
    serviceChecks,
    projectChecks,
    serviceStateChanges: STABILITY.serviceStateChanges,
    projectStateChanges: STABILITY.projectStateChanges,
    observedFailures: STABILITY.observedFailures,
    lastEvent: STABILITY.lastEvent,
    lastError: STABILITY.lastError,
    events: STABILITY.events.slice(-20),
  };
}

async function buildSnapshot() {
  const [cpu, memory, load, network, services, projects] = await Promise.all([
    readCpu(),
    readMemory(),
    readLoad(),
    readNetwork(),
    cachedServices(),
    cachedProjects(),
  ]);
  const projectRows = projects.map((project) => ({
    ...project,
    serviceDetails: services
      .filter((service) => project.serviceIds?.includes(service.id))
      .map((service) => ({
        id: service.id,
        state: service.state,
        pid: service.pid,
        memoryBytes: service.memoryBytes,
        restarts: service.restarts,
      })),
  }));
  const requests = requestStats();
  const processMemory = process.memoryUsage();
  STABILITY.sampleCount++;
  const snapshot = {
    schemaVersion: 2,
    now: new Date().toISOString(),
    host: os.hostname(),
    uptimeS: finiteNumber((await readText("/proc/uptime")).trim().split(/\s+/)[0]),
    cpu,
    memory,
    load,
    network,
    process: {
      pid: process.pid,
      uptimeS: process.uptime(),
      rss: bytesToUnits(processMemory.rss),
      heapUsed: bytesToUnits(processMemory.heapUsed),
      heapTotal: bytesToUnits(processMemory.heapTotal),
      external: bytesToUnits(processMemory.external),
    },
    requests,
    services,
    projects: projectRows,
    stability: stabilitySnapshot(),
  };
  history.push({
    t: Date.now(),
    cpu: cpu.percent,
    memory: memory.usedPercent,
    swap: memory.swapUsedPercent,
    load: load.one,
    p95: requests.p95Ms,
    requests: requests.perSecond1m,
  });
  while (history.length > MAX_HISTORY) history.shift();
  snapshot.history = history.slice();
  return snapshot;
}

async function getSnapshot() {
  const now = Date.now();
  if (latestSnapshot && latestSnapshotAt + REFRESH_MS > now) return latestSnapshot;
  if (!snapshotPromise) {
    snapshotPromise = buildSnapshot().then((value) => {
      latestSnapshot = value;
      latestSnapshotAt = Date.now();
      return value;
    }).finally(() => { snapshotPromise = null; });
  }
  return snapshotPromise;
}

async function loadPublicFile(name) {
  try {
    return await readFile(join(PUBLIC_DIR, name), "utf8");
  } catch {
    return "";
  }
}

const HTML = await loadPublicFile("index.html");
const CLIENT_JS = await loadPublicFile("dashboard.js");

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function recordRequest(status, startedAt) {
  const elapsed = Math.max(0, performance.now() - startedAt);
  REQUEST_COUNTS.total++;
  if (status >= 200 && status < 300) REQUEST_COUNTS.status2xx++;
  else if (status >= 300 && status < 400) REQUEST_COUNTS.status3xx++;
  else if (status >= 400 && status < 500) REQUEST_COUNTS.status4xx++;
  else if (status >= 500) REQUEST_COUNTS.status5xx++;
  if (status >= 400) REQUEST_COUNTS.errors++;
  REQUEST_EVENTS.push(Date.now());
  LATENCY_SAMPLES.push(elapsed);
  while (REQUEST_EVENTS.length > MAX_REQUEST_EVENTS) REQUEST_EVENTS.shift();
  while (LATENCY_SAMPLES.length > MAX_LATENCY_SAMPLES) LATENCY_SAMPLES.shift();
}

function normalizePath(pathname) {
  const path = String(pathname || "/");
  if (path === "/__server" || path.startsWith("/__server/")) {
    return path.slice("/__server".length) || "/";
  }
  return path;
}

export { normalizePath };

const server = http.createServer(async (req, res) => {
  const startedAt = performance.now();
  let status = 500;
  try {
    const requestUrl = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
    const pathname = normalizePath(requestUrl.pathname);
    if (req.method !== "GET" && req.method !== "HEAD") {
      status = 405;
      res.writeHead(status, { allow: "GET, HEAD", "cache-control": "no-store" });
      res.end("Method Not Allowed");
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      status = 200;
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-length": Buffer.byteLength(HTML),
      });
      res.end(req.method === "HEAD" ? undefined : HTML);
      return;
    }
    if (pathname === "/dashboard.js") {
      status = 200;
      res.writeHead(status, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(CLIENT_JS),
      });
      res.end(req.method === "HEAD" ? undefined : CLIENT_JS);
      return;
    }
    if (pathname === "/api/health") {
      status = 200;
      json(res, status, {
        status: "ok",
        service: "server-access-dashboard",
        now: new Date().toISOString(),
        uptimeS: process.uptime(),
      });
      return;
    }
    if (pathname === "/api/metrics") {
      status = 200;
      json(res, status, await getSnapshot());
      return;
    }
    status = 404;
    json(res, status, { status: "not_found" });
  } catch (error) {
    status = 500;
    json(res, status, { status: "error", error: safeError(error) });
  } finally {
    recordRequest(status, startedAt);
  }
});

server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 5_000;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log("server-access-dashboard listening on http://" + HOST + ":" + PORT);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
