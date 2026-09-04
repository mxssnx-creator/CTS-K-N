(() => {
  const $ = (id) => document.getElementById(id);
  let paused = false;
  let timer = null;

  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const number = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
  const integer = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString("en-US") : "—";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));
  const set = (id, value) => { const node = $(id); if (node) node.textContent = String(value); };
  const bar = (id, value) => { const node = $(id); if (node) node.style.width = Math.max(0, Math.min(100, finite(value))) + "%"; };
  const stateClass = (state) => {
    const value = String(state || "").toLowerCase();
    if (["up", "running", "active"].includes(value)) return "up";
    if (["degraded", "warning", "activating"].includes(value)) return "degraded";
    if (["down", "failed", "inactive", "unknown", "missing"].includes(value)) return "down";
    return "";
  };
  const formatBytes = (value) => {
    const bytes = Math.max(0, finite(value));
    if (bytes < 1024) return integer(bytes) + " B";
    if (bytes < 1024 ** 2) return number(bytes / 1024, 1) + " KiB";
    if (bytes < 1024 ** 3) return number(bytes / 1024 ** 2, 2) + " MiB";
    return number(bytes / 1024 ** 3, 2) + " GiB";
  };
  const exactBytes = (units) => {
    if (!units) return "—";
    return integer(units.bytes) + " B · " + number(units.gib, 2) + " GiB";
  };
  const duration = (seconds) => {
    let value = Math.max(0, Math.round(finite(seconds)));
    const days = Math.floor(value / 86400); value %= 86400;
    const hours = Math.floor(value / 3600); value %= 3600;
    const minutes = Math.floor(value / 60); value %= 60;
    return days ? days + "d " + hours + "h" : hours ? hours + "h " + minutes + "m" : minutes ? minutes + "m " + value + "s" : value + "s";
  };
  const points = (rows, key) => {
    if (!rows.length) return "";
    return rows.map((row, index) => {
      const x = rows.length === 1 ? 0 : index * 600 / (rows.length - 1);
      const y = 150 - Math.max(0, Math.min(100, finite(row[key]))) * 1.25;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
  };

  const metric = (value, digits = 2) => {
    if (value === null || value === undefined || value === "") return "—";
    if (Number.isFinite(Number(value))) return Number(value).toFixed(digits);
    return String(value) === "true" ? "∞" : "—";
  };
  const pfMetric = (row) => {
    if (!row) return "—";
    if (row.infinite) return "∞ (" + integer(row.samples) + ")";
    return metric(row.value, 2) + " (" + integer(row.samples) + (row.available ? "" : " · partial") + ")";
  };

  function connectionMarkup(connection) {
    const stats = connection.stats || {};
    const pf = stats.pf || {};
    const ddt = stats.averageDdt || {};
    const runtime = connection.runtime || {};
    const recoord = runtime.settingsRecoordination || {};
    const recalculation = runtime.statsRecalculation || {};
    const progress = connection.progress || {};
    const exchange = stats.exchangeOpen === null || stats.exchangeOpen === undefined ? "—" : integer(stats.exchangeOpen);
    const errors = Array.isArray(connection.upstream?.errors) ? connection.upstream.errors.join(", ") : "";
    const state = String(connection.status || "unknown");
    const coverage = stats.accounting?.coveragePercent;
    return '<div class="connection-card"><div class="connection-head"><div><span class="mono">' + esc(connection.id) +
      '</span><div class="small">' + esc(connection.name || connection.id) + " · " + esc(connection.exchange || "unknown") +
      '</div></div><span class="status"><i class="dot ' + stateClass(state) + '"></i>' + esc(state) + '</span></div>' +
      '<div class="connection-grid"><div><span class="label">Processing state</span><b>' + esc(state) + " · " + esc(progress.phase || "warming") +
      " · " + number(progress.percent, 1) + '</b></div><div><span class="label">Pos Valid / Exchange</span><b>' +
      integer(stats.realValid) + " / " + exchange + " (live " + integer(stats.liveOpen) + ')</b></div><div><span class="label">Unrealized PnL</span><b class="mono">' +
      metric(stats.unrealizedPnl, 4) + '</b></div><div><span class="label">PF last 8 / 25 / 75</span><b class="mono">' +
      esc(pfMetric(pf.last8)) + " / " + esc(pfMetric(pf.last25)) + " / " + esc(pfMetric(pf.last75)) +
      '</b></div><div><span class="label">Average DDT · Overall / Sets</span><b class="mono">' +
      metric(ddt.overallMinutes, 1) + " / " + metric(ddt.setsMinutes, 1) + ' min</b></div><div><span class="label">Coverage</span><b class="mono">' +
      integer(stats.realValid) + " valid · " + metric(coverage, 1) + '%</b></div></div>' +
      '<div class="small connection-foot">heartbeat ' + (connection.heartbeatFresh ? "fresh" : "stale") +
      " · recoord " + esc(recoord.phase || recoord.status || "idle") + " · recalc " + esc(recalculation.phase || recalculation.status || "idle") +
      (stats.exchangeOpenSource ? " · exchange source " + esc(stats.exchangeOpenSource) : "") +
      (errors ? ' · <span class="bad">' + esc(errors) + '</span>' : "") + "</div></div>";
  }

  function projectMarkup(project) {
    const cls = stateClass(project.status);
    const activity = project.activity || {};
    let progress = "";
    if (Array.isArray(project.progress) && project.progress.length) {
      progress = project.progress.map((row) => {
        const summary = row.summary;
        if (!summary) {
          return '<div class="progress-row"><div class="split"><span>' + esc(row.id) + '</span><span class="bad">unavailable</span></div><div class="small bad">' + esc(row.error || "probe failed") + "</div></div>";
        }
        const percent = Math.max(0, Math.min(100, finite(summary.percent)));
        const symbols = summary.total ? integer(summary.processed) + " / " + integer(summary.total) + " symbols" : "no symbol total";
        const config = summary.configTotal ? " · " + integer(summary.configCompleted) + " / " + integer(summary.configTotal) + " configs" : "";
        return '<div class="progress-row"><div class="split"><span>' + esc(row.id) + '</span><span class="mono">' + number(percent, 1) + "% · " + esc(summary.phase) + '</span></div><div class="bar"><i style="width:' + percent + '%"></i></div><div class="small">' + esc(symbols + config) + " · " + integer(summary.cycles) + " cycles · " + number(row.latencyMs, 0) + " ms</div></div>";
      }).join("");
    }
    if (!progress) {
      const engine = project.engine || {};
      progress = '<div class="small" style="margin-top:18px">' + esc(
        engine.status + " · " + (engine.running ? "engine running" : "engine stopped") +
        " · " + integer(engine.connections) + " connections",
      ) + "</div>";
    }
    const tags = [
      project.httpStatus ? "HTTP " + project.httpStatus : "",
      project.latencyMs ? number(project.latencyMs, 0) + " ms" : "",
      project.port ? "port " + project.port : "",
      project.health?.redis ? "Redis " + project.health.redis : "",
      "checks " + integer(activity.checks),
      project.serviceDetails?.length ? project.serviceDetails.length + " services" : "",
      project.connectionIds?.length ? project.connectionIds.length + " connections" : "",
    ].filter(Boolean);
    const serviceLine = Array.isArray(project.serviceDetails) && project.serviceDetails.length
      ? " · services " + project.serviceDetails.map((service) => service.id.replace(/\.service$/, "") + " " + formatBytes(service.memoryBytes)).join(", ")
      : "";
    const connections = Array.isArray(project.connections) ? project.connections : [];
    const connectionRows = connections.length
      ? '<div class="connection-list">' + connections.map(connectionMarkup).join("") + "</div>"
      : '<div class="small connection-empty">No per-connection stats available from this project.</div>';
    return '<article class="card project"><div class="project-head"><div><div class="project-title">' +
      esc(project.name) + '</div><div class="project-role">' + esc(project.role) +
      '</div></div><div class="status"><i class="dot ' + cls + '"></i>' + esc(project.status || "unknown") +
      '</div></div><div class="progress">' + progress + '</div><div>' +
      tags.map((tag) => '<span class="tag">' + esc(tag) + "</span>").join("") +
      '</div><div class="small" style="margin-top:10px">Failures ' + integer(activity.failures) +
      " (" + number(activity.failureRatePercent, 1) + "%) · state changes " + integer(activity.stateChanges) +
      (activity.lastOkAt ? " · last OK " + esc(new Date(activity.lastOkAt).toLocaleTimeString()) : "") +
      esc(serviceLine) + "</div>" + (project.error ? '<div class="small bad" style="margin-top:8px">' + esc(project.error) + "</div>" : "") +
      '<div class="connection-title">Connection coverage</div>' + connectionRows + "</article>";
  }

  function renderCoreRows(cores) {
    if (!Array.isArray(cores) || !cores.length) {
      $("cores-table").innerHTML = '<tr><td colspan="7" class="small">Waiting for the second kernel sample…</td></tr>';
      return;
    }
    $("cores-table").innerHTML = cores.map((core) => {
      return "<tr><td class=\"mono\">" + esc(core.label) + "</td><td class=\"core-cell\"><div class=\"split\"><span class=\"mono\">" +
        number(core.percent, 1) + "%</span><span class=\"small\">" + esc(core.model || "") +
        "</span></div><div class=\"bar\"><i style=\"width:" + Math.max(0, Math.min(100, finite(core.percent))) + "%\"></i></div></td><td class=\"mono\">" +
        number(core.userPercent, 1) + "%</td><td class=\"mono\">" + number(core.systemPercent, 1) +
        "%</td><td class=\"mono\">" + number(core.idlePercent, 1) + "%</td><td class=\"mono\">" +
        number(core.iowaitPercent, 1) + "%</td><td class=\"mono\">" + integer(core.deltaTicks) + "</td></tr>";
    }).join("");
  }

  function renderEvents(events) {
    const rows = Array.isArray(events) ? events.slice().reverse() : [];
    set("event-count", rows.length + " shown");
    $("events").innerHTML = rows.length
      ? rows.map((event) => '<div class="event"><time>' + esc(new Date(event.at).toLocaleTimeString()) +
        "</time><span>" + esc(event.kind + " · " + event.id + " · " + event.from + " → " + event.to) + "</span></div>").join("")
      : '<div class="small">No state changes observed in this dashboard process.</div>';
  }

  function render(data) {
    const cpu = data.cpu || {};
    const memory = data.memory || {};
    const exact = memory.exact || {};
    const requests = data.requests || {};
    const stability = data.stability || {};
    const projects = data.projects || [];
    const services = data.services || [];
    const attention = projects.some((project) => project.status === "down") ||
      services.some((service) => ["failed", "unknown", "missing"].includes(service.state));
    const degraded = projects.some((project) => project.status === "degraded") ||
      services.some((service) => service.state === "activating");
    const overall = attention ? "ATTENTION" : degraded ? "DEGRADED" : "OPERATIONAL";
    $("overall-dot").className = "dot " + (attention ? "down" : degraded ? "degraded" : "up");
    set("overall-state", overall);
    set("uptime", duration(data.uptimeS));
    set("host", data.host || "—");
    set("cores", cpu.cores || "—");
    set("cpu", number(cpu.percent, 1) + "%");
    set("cpu-sample", cpu.sampleIntervalMs ? "sample " + integer(cpu.sampleIntervalMs) + " ms" : "warming up");
    set("memory", number(memory.usedPercent, 1) + "%");
    set("memory-exact", exactBytes(exact.used) + " / " + exactBytes(exact.total));
    set("memory-available", formatBytes(memory.availableBytes));
    set("memory-breakdown", "free " + formatBytes(memory.freeBytes) + " · cache " + formatBytes(memory.cachedBytes));
    set("swap", number(memory.swapUsedPercent, 1) + "%");
    set("swap-exact", exactBytes(exact.swapUsed) + " / " + exactBytes(exact.swapTotal));
    set("load", [data.load?.one, data.load?.five, data.load?.fifteen].map((value) => number(value, 2)).join(" / "));
    set("runnable", integer(data.load?.runnable) + " runnable · " + integer(data.load?.processes) + " total");
    set("requests", integer(requests.last1m));
    set("request-rate", number(requests.perSecond1m, 2) + " req/s · " + number(requests.last5m, 0) + " in 5m");
    set("latency", number(requests.p95Ms, 1) + " ms");
    set("request-health", "p50 " + number(requests.p50Ms, 1) + " ms · " + number(requests.errorRatePercent, 2) + "% errors");
    bar("cpu-bar", cpu.percent); bar("memory-bar", memory.usedPercent); bar("swap-bar", memory.swapUsedPercent);
    set("memory-total", exactBytes(exact.total));
    set("memory-used-available", exactBytes(exact.used) + " / " + exactBytes(exact.available));
    set("memory-cache", formatBytes(memory.cachedBytes) + " / " + formatBytes(memory.buffersBytes) + " / " + formatBytes(memory.reclaimableBytes));
    set("swap-total-free", exactBytes(exact.swapTotal) + " / " + exactBytes(exact.swapFree));
    set("memory-kernel", formatBytes(memory.committedBytes) + " / " + formatBytes(memory.dirtyBytes) + " / " + formatBytes(memory.writebackBytes));
    set("net-total", exactBytes(data.network?.rx) + " / " + exactBytes(data.network?.tx));
    set("net-rate", number(data.network?.rxKiBps, 1) + " / " + number(data.network?.txKiBps, 1) + " KiB/s");
    set("proc-memory", exactBytes(data.process?.rss) + " / heap " + exactBytes(data.process?.heapUsed));
    set("proc-info", integer(data.process?.pid) + " / " + duration(data.process?.uptimeS));
    set("cpu-detail", number(cpu.userPercent, 1) + "% user · " + number(cpu.systemPercent, 1) + "% system · " + number(cpu.iowaitPercent, 1) + "% I/O wait");
    set("updated", new Date(data.now || Date.now()).toLocaleTimeString());
    set("footer-time", "UTC " + new Date(data.now || Date.now()).toISOString().replace("T", " ").slice(0, 19));
    $("cpu-line").setAttribute("points", points(data.history || [], "cpu"));
    $("memory-line").setAttribute("points", points(data.history || [], "memory"));
    $("swap-line").setAttribute("points", points(data.history || [], "swap"));
    renderCoreRows(cpu.perCore);
    $("projects").innerHTML = projects.map(projectMarkup).join("");
    const active = services.filter((service) => ["active", "running"].includes(service.state)).length;
    const serviceMemory = services.reduce((sum, service) => sum + finite(service.memoryBytes), 0);
    set("service-summary", active + " / " + services.length + " active · " + formatBytes(serviceMemory) + " reported RSS");
    $("services").innerHTML = services.map((service) => {
      const process = service.process;
      return "<tr><td>" + esc(service.name) + "</td><td><span class=\"status\"><i class=\"dot " +
        stateClass(service.state) + "\"></i>" + esc(service.state) + (service.subState && service.subState !== "running" ? " · " + esc(service.subState) : "") +
        "</span></td><td class=\"mono\">" + (service.pid || "—") + (process ? " / " + integer(process.threads) : "") +
        "</td><td class=\"mono\">" + formatBytes(service.memoryBytes) + " / " + formatBytes(service.memoryPeakBytes) +
        "</td><td class=\"mono\">" + integer(service.tasks) + "</td><td class=\"mono\">" + number(service.cpuSeconds, 1) +
        "s</td><td class=\"mono\">" + integer(service.restarts) + "</td><td class=\"small\">" + esc(service.since || "—") + "</td></tr>";
    }).join("");
    const stabilityClass = stability.lastError ? "degraded" : "up";
    set("stability-state", stability.lastError ? "history has alerts" : "stable sampling");
    $("stability-state").className = "status " + stabilityClass;
    set("stability-samples", integer(stability.sampleCount) + " / " + duration(stability.sampleWindowS));
    set("project-checks", integer(stability.projectChecks));
    set("service-checks", integer(stability.serviceChecks));
    set("observed-failures", integer(stability.observedFailures));
    set("project-changes", integer(stability.projectStateChanges));
    set("service-changes", integer(stability.serviceStateChanges));
    set("last-event", stability.lastEvent ? stability.lastEvent.kind + " · " + stability.lastEvent.id : "none");
    set("last-stability-error", stability.lastError || "none");
    renderEvents(stability.events);
  }

  async function pull() {
    if (paused) return;
    try {
      const response = await fetch("/__server/api/metrics?ts=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      render(await response.json());
      $("error").classList.remove("show");
    } catch (error) {
      $("error").textContent = "Metrics temporarily unavailable: " + (error?.message || String(error));
      $("error").classList.add("show");
      $("overall-dot").className = "dot down";
      set("overall-state", "UNAVAILABLE");
    } finally {
      if (!paused) timer = setTimeout(pull, 2_000);
    }
  }

  $("pause").addEventListener("click", () => {
    paused = !paused;
    $("pause").textContent = paused ? "Resume refresh" : "Pause refresh";
    if (!paused) {
      clearTimeout(timer);
      void pull();
    }
  });
  void pull();
})();
