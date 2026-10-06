"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Info,
  RefreshCw,
  Activity,
  Database,
  Cpu,
  HardDrive,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Zap,
  GitBranch,
  BarChart3,
  TrendingUp,
  Wifi,
} from "lucide-react";
import { useExchange } from "@/lib/exchange-context";
import { useConnectionState } from "@/lib/connection-state";
import {
  buildSystemDetailFigures,
  type SystemDetailFigures,
} from "./system-detail-data";

interface SystemDetailData {
  engine: {
    running: boolean;
    status: string;
    configuredWithoutWorkerHeartbeat: number;
  };
  connections: {
    total: number;
    active: number;
    list: Array<{
      id: string;
      name: string;
      exchange: string;
      status: string;
      isLive: boolean;
      contractType: string;
      isRunning?: boolean;
    }>;
  };
  figures: SystemDetailFigures;
  errors: {
    total: number;
    recent: Array<{
      timestamp: string;
      source: string;
      message: string;
    }>;
  };
}

interface LogEntry {
  timestamp: string;
  level: string;
  phase: string;
  engine?: string;
  message?: string;
  action?: string;
  status?: string;
  details?: Record<string, any>;
}

export function SystemDetailPanel() {
  const { selectedConnectionId, selectedExchange } = useExchange();
  const { exchangeConnectionsActive, loadExchangeConnectionsActive } =
    useConnectionState();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [systemData, setSystemData] = useState<SystemDetailData | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["overall"]),
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const candidates = selectedConnectionId
        ? [
            selectedConnectionId,
            selectedConnectionId.startsWith("conn-")
              ? selectedConnectionId.replace(/^conn-/, "")
              : `conn-${selectedConnectionId}`,
          ]
        : [];

      const effectiveId = candidates[0] || "";

      const [progressRes, logsRes, statusRes, systemStatusRes, statsRes] =
        await Promise.all([
          fetch(
            `/api/connections/progression/${effectiveId || "default"}/logs`,
          ).catch(() => null),
          fetch(
            `/api/trade-engine/structured-logs?connectionId=${effectiveId || "default"}&limit=200`,
          ).catch(() => null),
          fetch(`/api/trade-engine/status`).catch(() => null),
          fetch(`/api/system/status`).catch(() => null),
          fetch(
            `/api/connections/progression/${effectiveId || "default"}/stats`,
          ).catch(() => null),
        ]);

      let progressionState: any = null;
      let structuredLogs: LogEntry[] = [];
      let engineStatus: any = null;
      let systemStatus: any = null;
      let statsData: any = null;

      if (progressRes?.ok) {
        const d = await progressRes.json().catch(() => ({}));
        progressionState = d.progressionState || null;
      }
      if (logsRes?.ok) {
        const d = await logsRes.json().catch(() => ({}));
        structuredLogs = Array.isArray(d.logs) ? d.logs : [];
      }
      if (statusRes?.ok) {
        engineStatus = await statusRes.json().catch(() => ({}));
      }
      if (systemStatusRes?.ok) {
        systemStatus = await systemStatusRes.json().catch(() => ({}));
      }
      if (statsRes?.ok) {
        statsData = await statsRes.json().catch(() => ({}));
      }

      const runtimeById = new Map(
        (systemStatus?.engineRuntime?.connections || []).map((c: any) => [
          c.id,
          c,
        ]),
      );
      const connList = exchangeConnectionsActive.map((c) => {
        const runtime: any = runtimeById.get(c.id) || {};
        return {
          id: c.id,
          name: c.name || c.id,
          exchange: c.exchange || "unknown",
          status:
            runtime.runtimeStatus ||
            (c.is_enabled
              ? c.is_live_trade
                ? "live"
                : "enabled"
              : "disabled"),
          isLive: c.is_live_trade || false,
          isRunning: runtime.running === true,
          contractType: c.contract_type || "—",
        };
      });

      setSystemData({
        engine: {
          running:
            systemStatus?.engineRuntime?.running ??
            engineStatus?.running ??
            false,
          status:
            systemStatus?.engineRuntime?.status ??
            engineStatus?.actualRuntimeStatus ??
            engineStatus?.status ??
            "unknown",
          configuredWithoutWorkerHeartbeat:
            systemStatus?.engineRuntime?.configuredWithoutWorkerHeartbeat ?? 0,
        },
        connections: {
          total: connList.length,
          active:
            systemStatus?.engineRuntime?.runningConnections ??
            connList.filter((c) => c.isRunning).length,
          list: connList,
        },
        figures: buildSystemDetailFigures(progressionState, statsData),
        errors: {
          total: structuredLogs.filter((l) =>
            String(l.status || l.level || "")
              .toLowerCase()
              .includes("error"),
          ).length,
          recent: structuredLogs
            .filter((l) =>
              String(l.status || l.level || "")
                .toLowerCase()
                .includes("error"),
            )
            .slice(0, 10)
            .map((l) => ({
              timestamp: l.timestamp,
              source: l.engine || l.phase || "system",
              message: l.message || l.action || "Unknown error",
            })),
        },
      });

      setLogs(structuredLogs);
    } catch (err) {
      console.error("[SystemDetailPanel] Load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedConnectionId, exchangeConnectionsActive]);

  useEffect(() => {
    if (!open) return;
    loadData();
    const timer = setInterval(loadData, 12000);
    return () => clearInterval(timer);
  }, [open, loadData]);

  useEffect(() => {
    loadExchangeConnectionsActive().catch(() => {});
  }, [open]);

  const figures = systemData?.figures;

  const groupedLogs = useMemo(() => {
    const groups: Record<string, LogEntry[]> = {
      overall: [],
      data: [],
      engine: [],
      errors: [],
    };
    for (const log of logs) {
      const phase = String(log.phase || log.engine || "").toLowerCase();
      const level = String(log.status || log.level || "").toLowerCase();
      if (level.includes("error")) groups.errors.push(log);
      if (
        [
          "system",
          "coordinator",
          "initializing",
          "engine_starting",
          "live_trading",
        ].some((k) => phase.includes(k))
      )
        groups.overall.push(log);
      if (
        ["prehistoric", "realtime", "market", "market-data"].some((k) =>
          phase.includes(k),
        )
      )
        groups.data.push(log);
      if (
        ["indication", "strategy", "database", "interval", "strategies"].some(
          (k) => phase.includes(k),
        )
      )
        groups.engine.push(log);
    }
    return groups;
  }, [logs]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const StatusDot = ({ active }: { active: boolean }) => (
    <span
      className={`inline-block w-2 h-2 rounded-full ${active ? "bg-green-500" : "bg-gray-400"}`}
    />
  );

  const StatTile = ({
    label,
    value,
    color = "slate",
    title,
    missingReason = "No data yet",
  }: {
    label: string;
    value: string | number | null | undefined;
    color?: string;
    title?: string;
    missingReason?: string;
  }) => (
    <div
      className={`bg-${color}-50 rounded p-1.5 text-center`}
      title={value === null || value === undefined ? missingReason : title}
    >
      <div className={`text-${color}-700 font-bold text-sm`}>{value ?? "—"}</div>
      <div className="text-muted-foreground text-[9px] leading-tight">
        {label}
      </div>
    </div>
  );

  const SectionHeader = ({
    icon,
    label,
    count,
    color,
  }: {
    icon: React.ReactNode;
    label: string;
    count?: number;
    color: string;
  }) => (
    <div
      className={`flex items-center gap-1.5 text-[11px] font-semibold text-${color}-700 uppercase tracking-wide`}
    >
      {icon}
      {label}
      {count !== undefined && (
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
          {count}
        </Badge>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          title="System Detail Panel"
        >
          <Info className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Info className="h-4 w-4" />
              System Detail Panel
            </span>
            <div className="flex items-center gap-2">
              {systemData && (
                <Badge
                  variant={systemData.engine.running ? "default" : "secondary"}
                  className="text-[10px]"
                >
                  <StatusDot active={systemData.engine.running} />
                  <span className="ml-1">
                    {systemData.engine.running
                      ? "Engine Active"
                      : "Engine Idle"}
                  </span>
                </Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={loadData}
                disabled={loading}
                className="h-7 w-7 p-0"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="main" className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0 h-8">
            <TabsTrigger value="main" className="text-xs h-7 px-3">
              Main
            </TabsTrigger>
            <TabsTrigger value="log" className="text-xs h-7 px-3">
              Log
            </TabsTrigger>
          </TabsList>

          {/* MAIN TAB */}
          <TabsContent value="main" className="flex-1 min-h-0 mt-2">
            <ScrollArea className="h-[calc(92vh-120px)]">
              <div className="space-y-3 pr-3 pb-2">
                {/* Engine Status */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<Zap className="h-3.5 w-3.5" />}
                    label="Engine"
                    color="blue"
                  />
                  <div className="grid grid-cols-4 gap-1.5">
                    <StatTile
                      label="Status"
                      value={
                        systemData?.engine.status ===
                        "configured_no_worker_heartbeat"
                          ? "No heartbeat"
                          : systemData?.engine.running
                            ? "Running"
                            : "Stopped"
                      }
                      color={
                        systemData?.engine.running
                          ? "green"
                          : systemData?.engine.status ===
                              "configured_no_worker_heartbeat"
                            ? "orange"
                            : "gray"
                      }
                    />
                    <StatTile
                      label="Total Cycles"
                      value={figures?.engine.totalCycles}
                      color="blue"
                    />
                    <StatTile
                      label="Last Cycle"
                      value={figures?.engine.lastCycleMs == null ? null : `${figures.engine.lastCycleMs}ms`}
                      title="Duration of the last sampled strategy cycle"
                      missingReason="No strategy cycle duration sampled yet"
                      color="orange"
                    />
                    <StatTile
                      label="Success Rate"
                      value={figures?.engine.successRate == null ? null : `${figures.engine.successRate.toFixed(1)}%`}
                      missingReason="No pipeline cycle recorded yet"
                      color="emerald"
                    />
                  </div>
                </div>

                <Separator className="my-1" />

                {/* Connections */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<Wifi className="h-3.5 w-3.5" />}
                    label="Connections"
                    count={systemData?.connections.total}
                    color="cyan"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    <StatTile
                      label="Total"
                      value={systemData?.connections.total ?? 0}
                      color="cyan"
                    />
                    <StatTile
                      label="Running"
                      value={systemData?.connections.active ?? 0}
                      color="green"
                    />
                    <StatTile
                      label="No Worker Heartbeat"
                      value={
                        systemData?.engine.configuredWithoutWorkerHeartbeat ?? 0
                      }
                      color="orange"
                    />
                  </div>
                  {systemData?.connections.list &&
                    systemData.connections.list.length > 0 && (
                      <div className="space-y-1">
                        {systemData.connections.list.map((conn) => (
                          <div
                            key={conn.id}
                            className="flex items-center gap-2 bg-muted/30 rounded px-2 py-1 text-[10px]"
                          >
                            <StatusDot
                              active={(conn as any).isRunning === true}
                            />
                            <span className="font-medium truncate flex-1">
                              {conn.name}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 h-4"
                            >
                              {conn.exchange}
                            </Badge>
                            <span className="text-muted-foreground">
                              {conn.contractType}
                            </span>
                            <Badge
                              variant={
                                (conn as any).isRunning
                                  ? "default"
                                  : conn.status ===
                                      "configured_no_worker_heartbeat"
                                    ? "outline"
                                    : "secondary"
                              }
                              className="text-[9px] px-1 py-0 h-4"
                            >
                              {conn.status === "configured_no_worker_heartbeat"
                                ? "configured, no heartbeat"
                                : conn.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                </div>

                <Separator className="my-1" />

                {/* Data */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<Database className="h-3.5 w-3.5" />}
                    label="Data"
                    color="amber"
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="space-y-1">
                      <div className="text-[9px] text-muted-foreground font-medium uppercase">
                        Prehistoric
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        <StatTile
                          label="Symbols"
                          value={figures?.historic.symbols}
                          color="amber"
                        />
                        <StatTile
                          label="Candles"
                          value={figures?.historic.candles}
                          color="amber"
                        />
                        <StatTile
                          label="Intervals"
                          value={figures?.historic.intervals}
                          title="Historic timeframe intervals processed"
                          color="amber"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[9px] text-muted-foreground font-medium uppercase">
                        Realtime (cycles since start)
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        <StatTile
                          label="Realtime"
                          value={figures?.realtime.realtimeCycles}
                          color="teal"
                        />
                        <StatTile
                          label="Indication"
                          value={figures?.realtime.indicationCycles}
                          color="teal"
                        />
                        <StatTile
                          label="Strategy"
                          value={figures?.realtime.strategyCycles}
                          color="teal"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <Separator className="my-1" />

                {/* Processing - Indications */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<BarChart3 className="h-3.5 w-3.5" />}
                    label="Indications (cumulative)"
                    count={figures?.indications.total ?? undefined}
                    color="purple"
                  />
                  <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
                    <StatTile
                      label="Direction"
                      value={figures?.indications.direction}
                      color="purple"
                    />
                    <StatTile
                      label="Move"
                      value={figures?.indications.move}
                      color="purple"
                    />
                    <StatTile
                      label="Active"
                      value={figures?.indications.active}
                      color="purple"
                    />
                    <StatTile
                      label="Optimal"
                      value={figures?.indications.optimal}
                      color="purple"
                    />
                    <StatTile
                      label="Auto"
                      value={figures?.indications.auto}
                      color="purple"
                    />
                    <StatTile
                      label="Trend"
                      value={figures?.indications.trend}
                      color="purple"
                    />
                  </div>
                </div>

                <Separator className="my-1" />

                {/* Processing - Strategies
                    Header count = Real-stage only (canonical total). Base/Main
                    are intermediate filter stages of the SAME pipeline and
                    should not be added to Real. */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<GitBranch className="h-3.5 w-3.5" />}
                    label="Strategies (Real)"
                    count={figures?.strategies.real ?? undefined}
                    color="emerald"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    <StatTile
                      label="Base (eval)"
                      value={figures?.strategies.base}
                      color="emerald"
                    />
                    <StatTile
                      label="Main (filter)"
                      value={figures?.strategies.main}
                      color="emerald"
                    />
                    <StatTile
                      label="Real (adjust)"
                      value={figures?.strategies.real}
                      color="emerald"
                    />
                  </div>
                </div>

                <Separator className="my-1" />

                {/* Positions */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<TrendingUp className="h-3.5 w-3.5" />}
                    label="Open Positions"
                    color="green"
                  />
                  <div className="grid grid-cols-3 gap-1">
                    <StatTile
                      label="Pseudo (eval)"
                      value={figures?.positions.pseudo}
                      title="Open pseudo evaluation positions (shared by Base/Main/Real)"
                      color="green"
                    />
                    <StatTile
                      label="Real (active)"
                      value={figures?.positions.real}
                      color="green"
                    />
                    <StatTile
                      label="Live (exchange)"
                      value={figures?.positions.live}
                      color="green"
                    />
                  </div>
                </div>

                <Separator className="my-1" />

                {/* Database */}
                <div className="space-y-1.5">
                  <SectionHeader
                    icon={<HardDrive className="h-3.5 w-3.5" />}
                    label="Database"
                    color="slate"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    <StatTile
                      label="Entries"
                      value={figures?.database.entries}
                      color="slate"
                    />
                    <StatTile
                      label="Size"
                      value={figures?.database.sizeMb == null ? null : `${figures.database.sizeMb.toFixed(2)} MB`}
                      color="slate"
                    />
                    <StatTile
                      label="Schema"
                      value={figures?.database.schemaVersion == null ? null : `v${figures.database.schemaVersion}`}
                      title="Applied Redis migration (schema) version"
                      missingReason="No migration version recorded"
                      color="slate"
                    />
                  </div>
                </div>

                {/* Errors Summary */}
                {systemData && systemData.errors.total > 0 && (
                  <>
                    <Separator className="my-1" />
                    <div className="space-y-1.5">
                      <SectionHeader
                        icon={<AlertTriangle className="h-3.5 w-3.5" />}
                        label="Errors"
                        count={systemData.errors.total}
                        color="red"
                      />
                      <div className="space-y-1">
                        {systemData.errors.recent.slice(0, 5).map((err, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-2 bg-red-50 rounded px-2 py-1 text-[10px]"
                          >
                            <AlertTriangle className="h-3 w-3 text-red-500 shrink-0 mt-0.5" />
                            <span className="text-red-700 truncate flex-1">
                              {err.message}
                            </span>
                            <span className="text-red-400 shrink-0">
                              {new Date(err.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* LOG TAB */}
          <TabsContent value="log" className="flex-1 min-h-0 mt-2">
            <ScrollArea className="h-[calc(92vh-120px)]">
              <div className="space-y-2 pr-3 pb-2">
                {(["overall", "data", "engine", "errors"] as const).map(
                  (section) => {
                    const isExpanded = expandedSections.has(section);
                    const sectionLogs = groupedLogs[section];
                    const icon =
                      section === "overall" ? (
                        <Activity className="h-3.5 w-3.5" />
                      ) : section === "data" ? (
                        <Database className="h-3.5 w-3.5" />
                      ) : section === "engine" ? (
                        <Cpu className="h-3.5 w-3.5" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5" />
                      );
                    const color =
                      section === "overall"
                        ? "blue"
                        : section === "data"
                          ? "amber"
                          : section === "engine"
                            ? "purple"
                            : "red";

                    return (
                      <div key={section} className="rounded border bg-muted/10">
                        <button
                          onClick={() => toggleSection(section)}
                          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                          )}
                          {icon}
                          <span
                            className={`text-xs font-semibold capitalize text-${color}-700`}
                          >
                            {section}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1 py-0 h-4 ml-auto"
                          >
                            {sectionLogs.length}
                          </Badge>
                          {section === "errors" && sectionLogs.length > 0 && (
                            <AlertTriangle className="h-3 w-3 text-red-500" />
                          )}
                        </button>
                        {isExpanded && (
                          <div className="border-t px-2 py-1.5 space-y-1 max-h-[280px] overflow-y-auto">
                            {sectionLogs.length === 0 ? (
                              <div className="text-[10px] text-muted-foreground text-center py-2">
                                {section === "errors"
                                  ? "No errors detected"
                                  : `No ${section} logs`}
                              </div>
                            ) : (
                              sectionLogs
                                .slice(0, 100)
                                .map((log, idx) => (
                                  <LogRow key={`${section}-${idx}`} log={log} />
                                ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function LogRow({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const level = String(log.status || log.level || "").toLowerCase();
  const isError = level.includes("error");
  const isWarning = level.includes("warning");

  return (
    <div
      className={`rounded border text-[10px] ${isError ? "border-red-200 bg-red-50/50" : isWarning ? "border-yellow-200 bg-yellow-50/50" : "border-border bg-background"}`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-muted/30 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="text-muted-foreground shrink-0 font-mono">
          {new Date(log.timestamp || Date.now()).toLocaleTimeString()}
        </span>
        <Badge
          variant="outline"
          className={`text-[8px] px-1 py-0 h-3.5 shrink-0 ${isError ? "bg-red-100 text-red-700 border-red-300" : isWarning ? "bg-yellow-100 text-yellow-700 border-yellow-300" : ""}`}
        >
          {log.engine || log.phase || "sys"}
        </Badge>
        <span className="truncate flex-1 text-muted-foreground">
          {log.action || log.message || "event"}
        </span>
      </button>
      {expanded && log.details && (
        <pre className="px-3 pb-1.5 text-[9px] text-muted-foreground whitespace-pre-wrap max-h-24 overflow-auto">
          {JSON.stringify(log.details, null, 2)}
        </pre>
      )}
    </div>
  );
}
