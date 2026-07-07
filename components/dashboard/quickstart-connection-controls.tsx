"use client"

/**
 * QuickStart connection controls — a single compact strip mounted at the
 * top of the QuickStart card. Two responsibilities:
 *
 *   1. Connection picker — single-select. The popover lists every BASE
 *      connection currently in the Active panel and lets the operator
 *      choose exactly ONE active connection that the rest of QuickStart
 *      (volatile-symbol pick, stats poll, live-trade actions, engine
 *      controls) drives off via the `useExchange` context.
 *
 *      The picker also exposes the "Add to Active panel" action for
 *      enabled BASE connections that aren't yet inserted, so the
 *      operator never has to leave QuickStart to bootstrap a new
 *      connection. Newly-added connections become immediately selectable.
 *
 *      Selection is mutually exclusive — a radio indicator on each row
 *      makes the current pick obvious, and clicking a different row
 *      flips the selection through `setSelectedConnectionId`. The
 *      trigger button shows the active connection's name + exchange
 *      tag so the operator always sees what's selected without opening
 *      the popover.
 *
 *   2. Reset DB — destructive button that POSTs to
 *      /api/admin/clear-progressions. The endpoint surgically clears
 *      runtime state (progression logs, set caches, indications,
 *      strategies, tracking, positions, engine state, fingerprint cache,
 *      trades) but PRESERVES credentials and settings. The button
 *      always confirms before firing.
 *
 * Both actions emit a `connections:refresh` window event so the dashboard
 * tabs that own connection lists pick the change up immediately, and a
 * `quickstart:refresh` event so QuickStart's own polling resumes from a
 * clean slate.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover"
import {
  Plug, Plus, Trash2, Loader2, AlertCircle, CheckCircle2,
  Circle as CircleIcon, RefreshCw,
} from "lucide-react"
import {
  isBaseConnection, isConnectionEnabled,
} from "@/lib/connection-utils"
// Single source of truth for the currently-active connection across
// QuickStart and the rest of the dashboard. Selecting a row in the
// picker calls `setSelectedConnectionId` here, which causes
// `selectedConnection` / `selectedExchange` to flow back through every
// consumer of `useExchange`.
import { useExchange } from "@/lib/exchange-context"

interface ConnectionRow {
  id: string
  name: string
  exchange: string
  is_enabled?: string | boolean
  is_active_inserted?: string | boolean
  is_inserted?: string | boolean
  is_enabled_dashboard?: string | boolean
}

function exchangeColor(exchange: string): string {
  const e = (exchange || "").toLowerCase()
  if (e === "bybit") return "text-orange-600 dark:text-orange-400"
  if (e === "bingx") return "text-blue-600 dark:text-blue-400"
  if (e === "binance") return "text-yellow-600 dark:text-yellow-500"
  if (e === "okx") return "text-cyan-600 dark:text-cyan-400"
  return "text-muted-foreground"
}

export function QuickstartConnectionControls() {
  const {
    selectedConnectionId,
    setSelectedConnectionId,
    activeConnections,
    loadActiveConnections,
  } = useExchange()
  const [connections, setConnections] = useState<ConnectionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<
    { ok: boolean; message: string } | null
  >(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectResult, setReconnectResult] = useState<
    { ok: boolean; message: string } | null
  >(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // ── data load ──────────────────────────────────────────────────────────
  // The same /api/settings/connections endpoint the rest of the dashboard
  // uses — no separate cache, so the picker reflects the same connection
  // state the user sees in Settings.
  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/settings/connections?t=${Date.now()}`, {
        cache: "no-store",
      })
      const data = await res.json()
      const list: ConnectionRow[] = Array.isArray(data?.connections)
        ? data.connections
        : []
      setConnections(list)
    } catch (err) {
      console.error("[v0] [QSConnectionControls] load failed:", err)
      setConnections([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadConnections()
    // Re-load when other parts of the app emit the standard refresh event.
    const handler = () => loadConnections()
    window.addEventListener("connections:refresh", handler)
    return () => window.removeEventListener("connections:refresh", handler)
  }, [loadConnections])

  // ── derived: addable base connections ──────────────────────────────────
  // The picker only lists base connections (bybit/bingx by current
  // BASE_EXCHANGES list) that are enabled in Settings AND haven't been
  // pushed into the Active panel yet. Anything already inserted is hidden
  // because it'd be a no-op on the server.
  const addable = connections.filter((c) => {
    if (!isBaseConnection(c)) return false
    if (!isConnectionEnabled(c)) return false
    const inserted =
      c.is_active_inserted === "1" ||
      c.is_active_inserted === true ||
      c.is_active_inserted === ("true" as any)
    return !inserted
  })

  // Items already in the Active panel — informational so the operator
  // sees what's already there without having to flip tabs.
  const alreadyAdded = connections.filter((c) => {
    if (!isBaseConnection(c)) return false
    return (
      c.is_active_inserted === "1" ||
      c.is_active_inserted === true ||
      c.is_active_inserted === ("true" as any)
    )
  })

  // ── currently-selected connection (for the trigger label) ────────────
  // Look it up from BOTH lists so the trigger renders correctly whether
  // the active connection came from `activeConnections` (the canonical
  // useExchange list) or just from the local /api/settings/connections
  // fetch (e.g. during a fresh-add window before the context refreshes).
  const selectedConnection = useMemo(() => {
    if (!selectedConnectionId) return null
    return (
      activeConnections.find((c: any) => c.id === selectedConnectionId) ||
      connections.find((c) => c.id === selectedConnectionId) ||
      null
    )
  }, [selectedConnectionId, activeConnections, connections])

  // ── actions ────────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (connectionId: string) => {
      // Single-select: clicking a row replaces the current selection.
      // No-op if the same row is clicked twice ��� we don't want to
      // accidentally clear the selection (other dashboard panels expect
      // a non-null connection while the engine is running).
      if (!connectionId || connectionId === selectedConnectionId) {
        setPopoverOpen(false)
        return
      }
      setSelectedConnectionId(connectionId)
      // Tell QuickStart's own pollers to re-fetch using the new
      // connection immediately, instead of waiting for the next poll
      // tick. Same event QuickStart already listens for after Add /
      // Reset DB actions.
      window.dispatchEvent(new CustomEvent("quickstart:refresh"))
      setPopoverOpen(false)
    },
    [selectedConnectionId, setSelectedConnectionId],
  )

  const handleAdd = useCallback(
    async (connectionId: string) => {
      if (!connectionId || adding) return
      setAdding(connectionId)
      try {
        const res = await fetch(
          "/api/settings/connections/add-to-active",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionId }),
          },
        )
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data?.success === false) {
          console.warn("[v0] [QSConnectionControls] add failed:", data)
        } else {
          // Tell the rest of the app a new connection was activated.
          window.dispatchEvent(new CustomEvent("connections:refresh"))
          window.dispatchEvent(new CustomEvent("quickstart:refresh"))
          // Refresh the canonical active-connections list so
          // selecting the freshly-added one resolves immediately.
          await loadActiveConnections({ force: true })
          // Auto-select the new connection so the operator doesn't
          // need a second click — this is the typical bootstrapping
          // flow (add → use). Skip if the user already had something
          // selected (preserve their explicit choice).
          if (!selectedConnectionId) {
            setSelectedConnectionId(connectionId)
          }
        }
        await loadConnections()
      } catch (err) {
        console.error("[v0] [QSConnectionControls] add error:", err)
      } finally {
        setAdding(null)
      }
    },
    [adding, loadConnections, loadActiveConnections, selectedConnectionId, setSelectedConnectionId],
  )

  const handleReset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    setResetResult(null)
    try {
      const res = await fetch("/api/admin/clear-progressions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success === false) {
        setResetResult({
          ok: false,
          message: data?.error || data?.details || `Reset failed (HTTP ${res.status})`,
        })
      } else {
        setResetResult({
          ok: true,
          message: data?.message || "Database cleared",
        })
        // Refresh every consumer of connections / progressions / engine
        // status so the UI reflects the new clean slate immediately.
        window.dispatchEvent(new CustomEvent("connections:refresh"))
        window.dispatchEvent(new CustomEvent("quickstart:refresh"))
        window.dispatchEvent(new CustomEvent("progressions:refresh"))
        await loadConnections()
      }
    } catch (err) {
      setResetResult({
        ok: false,
        message: err instanceof Error ? err.message : "Reset failed",
      })
    } finally {
      setResetting(false)
      // Auto-dismiss the success/error chip after 6s.
      setTimeout(() => setResetResult(null), 6000)
    }
  }, [resetting, loadConnections])

  const handleReconnect = useCallback(async () => {
    if (reconnecting) return
    setReconnecting(true)
    setReconnectResult(null)
    try {
      const body: Record<string, string> = {}
      if (selectedConnectionId) body.connectionId = selectedConnectionId
      const res = await fetch("/api/engine/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success === false) {
        setReconnectResult({
          ok: false,
          message: data?.error || data?.details || `Reconnect failed (HTTP ${res.status})`,
        })
      } else {
        setReconnectResult({
          ok: true,
          message: data?.message || "Reconnected",
        })
        window.dispatchEvent(new CustomEvent("connections:refresh"))
        window.dispatchEvent(new CustomEvent("quickstart:refresh"))
        window.dispatchEvent(new CustomEvent("progressions:refresh"))
      }
    } catch (err) {
      setReconnectResult({
        ok: false,
        message: err instanceof Error ? err.message : "Reconnect failed",
      })
    } finally {
      setReconnecting(false)
      setTimeout(() => setReconnectResult(null), 6000)
    }
  }, [reconnecting, selectedConnectionId])

  // ── render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-primary/10 bg-muted/30">
      {/* ── Connection picker (single-select) ─────────────────────────── */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] px-2 gap-1.5 max-w-[260px]"
            aria-label="Select active connection"
            title={
              selectedConnection
                ? `Active: ${selectedConnection.name}`
                : "Select an active connection"
            }
          >
            <Plug
              className={`w-3 h-3 ${
                selectedConnection
                  ? exchangeColor(selectedConnection.exchange)
                  : "text-muted-foreground"
              }`}
            />
            {selectedConnection ? (
              <>
                <span className="font-medium truncate">
                  {selectedConnection.name}
                </span>
                <span
                  className={`uppercase text-[9px] ${exchangeColor(
                    selectedConnection.exchange,
                  )}`}
                >
                  {selectedConnection.exchange}
                </span>
              </>
            ) : (
              <span>Connections</span>
            )}
            <span className="text-muted-foreground tabular-nums ml-auto">
              {alreadyAdded.length}
              {addable.length > 0 ? `+${addable.length}` : ""}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="px-3 py-2 border-b">
            <p className="text-xs font-semibold">Connections</p>
            <p className="text-[10px] text-muted-foreground">
              Pick the active connection. QuickStart, stats, and engine
              actions follow your selection.
            </p>
          </div>

          {/* ── Active panel — single-select group ────────────────────────
              Each row is a radio: the selected one shows a filled green
              circle, the rest show an empty outline. Clicking a row
              flips selection through useExchange and closes the popover. */}
          {alreadyAdded.length > 0 ? (
            <div className="px-3 py-2 border-b">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Active panel — select one
              </p>
              <ul role="radiogroup" className="space-y-0.5">
                {alreadyAdded.map((c) => {
                  const isSelected = c.id === selectedConnectionId
                  return (
                    <li key={c.id} role="none">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => handleSelect(c.id)}
                        className={`flex items-center gap-1.5 w-full text-left rounded px-1.5 py-1 text-[11px] transition-colors ${
                          isSelected
                            ? "bg-primary/10 ring-1 ring-primary/40"
                            : "hover:bg-muted/60"
                        }`}
                      >
                        {isSelected ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                        ) : (
                          <CircleIcon className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                        )}
                        <span className="font-medium truncate flex-1">
                          {c.name}
                        </span>
                        <span
                          className={`uppercase text-[9px] ${exchangeColor(
                            c.exchange,
                          )}`}
                        >
                          {c.exchange}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : (
            <div className="px-3 py-2 border-b">
              <p className="text-[11px] text-muted-foreground italic">
                No connections in the Active panel yet — add one below.
              </p>
            </div>
          )}

          {/* ── Addable group — bootstrapping action ─────────────────────
              Shown only when at least one enabled base connection is
              not yet in the Active panel. Clicking Add inserts and
              auto-selects (when nothing else is selected). */}
          {(loading || addable.length > 0) && (
            <div className="px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Available to add
              </p>
              {loading ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading…
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {addable.map((c) => {
                    const busy = adding === c.id
                    return (
                      <li
                        key={c.id}
                        className="flex items-center gap-1.5 text-[11px] px-1.5 py-1 rounded hover:bg-muted/40"
                      >
                        <Plug
                          className={`w-3 h-3 shrink-0 ${exchangeColor(
                            c.exchange,
                          )}`}
                        />
                        <span className="font-medium truncate flex-1">
                          {c.name}
                        </span>
                        <span
                          className={`uppercase text-[9px] ${exchangeColor(
                            c.exchange,
                          )}`}
                        >
                          {c.exchange}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[10px] gap-1"
                          onClick={() => handleAdd(c.id)}
                          disabled={busy}
                        >
                          {busy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Plus className="w-3 h-3" />
                          )}
                          Add
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* ── Reset DB ──────────────────────────────────────────────────── */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={resetting}
            className="h-7 text-[11px] px-2 gap-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-300 dark:border-red-900"
            title="Clear runtime DB (progressions, sets, indications, strategies, positions). Credentials and settings are preserved."
          >
            {resetting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Trash2 className="w-3 h-3" />
            )}
            Reset DB
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-600" />
              Reset runtime database?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This will <strong>stop every running engine</strong> and
                  delete all runtime state:
                </p>
                <ul className="list-disc pl-5 text-muted-foreground space-y-0.5 text-xs">
                  <li>Progression logs and engine_progression counters</li>
                  <li>Set caches, preset-sets, fingerprint cache</li>
                  <li>Indications and strategies snapshots</li>
                  <li>Tracking entries, live positions, trade history</li>
                  <li>Engine state, metrics, and runtime breadcrumbs</li>
                </ul>
                <p className="text-xs">
                  <strong>Preserved:</strong> exchange credentials
                  (connections), app settings, migration markers.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReset}
              disabled={resetting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600 text-white"
            >
              {resetting ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                  Clearing…
                </>
              ) : (
                <>
                  <Trash2 className="w-3 h-3 mr-1.5" />
                  Reset
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reconnect / re-arm engine ─────────────────────────────────── */}
      <Button
        size="sm"
        variant="outline"
        disabled={reconnecting}
        onClick={handleReconnect}
        className="h-7 text-[11px] px-2 gap-1.5"
        title="Clear cooldowns, heal flags, restart stopped engines, and re-arm the global coordinator."
      >
        {reconnecting ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <RefreshCw className="w-3 h-3" />
        )}
        Reconnect
      </Button>

      {/* ── Inline result chips — auto-dismiss after 6s ───────────────── */}
      {reconnectResult && (
        <span
          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${
            reconnectResult.ok
              ? "bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400"
              : "bg-red-100 dark:bg-red-950/30 text-red-700 dark:text-red-400"
          }`}
          role="status"
        >
          {reconnectResult.ok ? (
            <CheckCircle2 className="w-3 h-3" />
          ) : (
            <AlertCircle className="w-3 h-3" />
          )}
          {reconnectResult.message}
        </span>
      )}
      {resetResult && (
        <span
          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${
            resetResult.ok
              ? "bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400"
              : "bg-red-100 dark:bg-red-950/30 text-red-700 dark:text-red-400"
          }`}
          role="status"
        >
          {resetResult.ok ? (
            <CheckCircle2 className="w-3 h-3" />
          ) : (
            <AlertCircle className="w-3 h-3" />
          )}
          {resetResult.message}
        </span>
      )}
    </div>
  )
}
