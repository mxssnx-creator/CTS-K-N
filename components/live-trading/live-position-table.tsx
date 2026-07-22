"use client"

import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronsUpDown,
  CircleStop,
  Loader2,
  Search,
  Shield,
  SlidersHorizontal,
  TimerReset,
  TrendingDown,
  TrendingUp,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { LivePositionView, ProtectionUpdate } from "@/components/live-trading/live-trading-types"
import {
  absoluteStopLoss,
  absoluteTakeProfit,
  finite,
  formatMoney,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatTimestamp,
  positionDirection,
  positionEntry,
  positionMargin,
  positionMark,
  positionPnl,
  positionQuantity,
} from "@/components/live-trading/live-trading-format"

type PositionSort = "pnl" | "newest" | "symbol" | "margin"
type PositionSide = "all" | "long" | "short"
type PositionSource = "all" | "real" | "simulated" | "unknown"

interface LivePositionTableProps {
  positions: LivePositionView[]
  busyId: string | null
  onClose: (position: LivePositionView) => Promise<void>
  onUpdateProtection: (position: LivePositionView, update: ProtectionUpdate) => Promise<void>
  onRestoreProtection: (position: LivePositionView) => Promise<void>
}

function sourceOf(position: LivePositionView): "real" | "simulated" | "unknown" {
  if (position.dataSource === "real" || position.isRealExchangeData) return "real"
  if (position.dataSource === "simulated" || position.isSimulated || position.executionMode === "simulation") return "simulated"
  return "unknown"
}

function statusTone(status: string): string {
  if (status.includes("closing")) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  if (status === "open" || status === "filled") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (status.includes("pending") || status.includes("placed")) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
  return "border-border bg-muted/50 text-muted-foreground"
}

function protectionPriceString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ""
  return String(Number(value.toPrecision(12)))
}

function timestamp(value: unknown): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

export function LivePositionTable({
  positions,
  busyId,
  onClose,
  onUpdateProtection,
  onRestoreProtection,
}: LivePositionTableProps) {
  const [query, setQuery] = useState("")
  const [side, setSide] = useState<PositionSide>("all")
  const [source, setSource] = useState<PositionSource>("all")
  const [sort, setSort] = useState<PositionSort>("pnl")
  const [protectionPosition, setProtectionPosition] = useState<LivePositionView | null>(null)
  const [protectionFocus, setProtectionFocus] = useState<"protection" | "trailing">("protection")
  const [closePosition, setClosePosition] = useState<LivePositionView | null>(null)
  const [stopLossPrice, setStopLossPrice] = useState("")
  const [takeProfitPrice, setTakeProfitPrice] = useState("")
  const [trailingEnabled, setTrailingEnabled] = useState(false)
  const [trailingDistancePct, setTrailingDistancePct] = useState("0.50")
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    if (!protectionPosition) return
    setStopLossPrice(protectionPriceString(absoluteStopLoss(protectionPosition)))
    setTakeProfitPrice(protectionPriceString(absoluteTakeProfit(protectionPosition)))
    setTrailingEnabled(
      protectionPosition.manualProtectionOverride?.trailingEnabled === true ||
      protectionPosition.trailingActive === true,
    )
    setTrailingDistancePct(String(
      protectionPosition.manualProtectionOverride?.trailingDistancePct ??
      protectionPosition.trailingProfile?.stopRatio ??
      0.5,
    ))
    setValidationError(null)
  }, [protectionPosition])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const result = positions.filter((position) => {
      if (side !== "all" && positionDirection(position) !== side) return false
      if (source !== "all" && sourceOf(position) !== source) return false
      if (!needle) return true
      return [
        position.symbol,
        position.id,
        position.setVariant,
        position.indicationType,
        position.status,
        position.orderId,
      ].some((value) => String(value || "").toLowerCase().includes(needle))
    })

    result.sort((left, right) => {
      if (sort === "pnl") return positionPnl(right) - positionPnl(left)
      if (sort === "margin") return positionMargin(right) - positionMargin(left)
      if (sort === "symbol") return String(left.symbol).localeCompare(String(right.symbol))
      return timestamp(right.createdAt) - timestamp(left.createdAt)
    })
    return result
  }, [positions, query, side, sort, source])

  const submitProtection = async () => {
    if (!protectionPosition) return
    const mark = positionMark(protectionPosition)
    const direction = positionDirection(protectionPosition)
    const stop = stopLossPrice.trim() ? Number(stopLossPrice) : null
    const take = takeProfitPrice.trim() ? Number(takeProfitPrice) : null
    const distance = Number(trailingDistancePct)

    if (stop !== null && (!Number.isFinite(stop) || stop <= 0)) {
      setValidationError("Stop loss must be a positive price.")
      return
    }
    if (take !== null && (!Number.isFinite(take) || take <= 0)) {
      setValidationError("Take profit must be a positive price.")
      return
    }
    if (stop === null && !trailingEnabled) {
      setValidationError("Keep a stop loss or enable trailing protection.")
      return
    }
    if (stop !== null && mark > 0 && (direction === "long" ? stop >= mark : stop <= mark)) {
      setValidationError(direction === "long" ? "A long stop must be below the current mark." : "A short stop must be above the current mark.")
      return
    }
    if (take !== null && mark > 0 && (direction === "long" ? take <= mark : take >= mark)) {
      setValidationError(direction === "long" ? "A long target must be above the current mark." : "A short target must be below the current mark.")
      return
    }
    if (trailingEnabled && (!Number.isFinite(distance) || distance < 0.05 || distance > 25)) {
      setValidationError("Trailing distance must be between 0.05% and 25%.")
      return
    }

    setValidationError(null)
    try {
      await onUpdateProtection(protectionPosition, {
        stopLossPrice: stop,
        takeProfitPrice: take,
        trailingEnabled,
        trailingDistancePct: trailingEnabled ? distance : undefined,
      })
      setProtectionPosition(null)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Protection update failed.")
    }
  }

  const restoreProtection = async () => {
    if (!protectionPosition) return
    try {
      await onRestoreProtection(protectionPosition)
      setProtectionPosition(null)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Strategy protection could not be restored.")
    }
  }

  const confirmClose = async () => {
    if (!closePosition) return
    try {
      await onClose(closePosition)
      setClosePosition(null)
    } catch {
      // The page-level action reports the exchange/coordinator error. Keep
      // the confirmation open so the operator can retry deliberately.
    }
  }

  return (
    <>
      <Card className="border-border/70 shadow-sm">
        <CardHeader className="space-y-2 p-3 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Active live positions</CardTitle>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Exchange-aware close and durable TP / SL / trailing controls per position
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{positions.length} open</Badge>
              <Badge variant="outline" className="h-5 border-emerald-500/30 px-1.5 text-[10px]">
                {positions.filter((position) => sourceOf(position) === "real").length} exchange
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 p-1.5">
            <div className="relative min-w-[170px] flex-1 sm:max-w-[280px]">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Symbol, ID, strategy…"
                className="h-7 pl-7 text-xs"
              />
            </div>
            <div className="flex items-center gap-1">
              {(["all", "long", "short"] as const).map((value) => (
                <Button key={value} size="sm" variant={side === value ? "default" : "outline"} className="h-7 px-2 text-[10px] capitalize" onClick={() => setSide(value)}>
                  {value}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {(["all", "real", "simulated", "unknown"] as const).map((value) => (
                <Button key={value} size="sm" variant={source === value ? "secondary" : "ghost"} className="h-7 px-2 text-[10px] capitalize" onClick={() => setSource(value)}>
                  {value}
                </Button>
              ))}
            </div>
            <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
              <ChevronsUpDown className="size-3" />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as PositionSort)}
                className="h-7 rounded-md border bg-background px-1.5 text-[10px] text-foreground outline-none"
              >
                <option value="pnl">PnL</option>
                <option value="newest">Newest</option>
                <option value="symbol">Symbol</option>
                <option value="margin">Margin</option>
              </select>
            </label>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="max-h-[460px] overflow-auto border-t">
            <Table className="min-w-[1120px] text-xs">
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <TableRow>
                  <TableHead className="h-8 pl-3 text-[10px]">Position</TableHead>
                  <TableHead className="h-8 text-[10px]">Entry → Mark</TableHead>
                  <TableHead className="h-8 text-[10px]">Quantity / Margin</TableHead>
                  <TableHead className="h-8 text-[10px]">PnL / ROI</TableHead>
                  <TableHead className="h-8 text-[10px]">Protection</TableHead>
                  <TableHead className="h-8 text-[10px]">State / Age</TableHead>
                  <TableHead className="h-8 pr-3 text-right text-[10px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((position) => {
                  const direction = positionDirection(position)
                  const entry = positionEntry(position)
                  const mark = positionMark(position)
                  const quantity = positionQuantity(position)
                  const pnl = positionPnl(position)
                  const margin = positionMargin(position)
                  const roi = Number.isFinite(Number(position.unrealizedRoi))
                    ? Number(position.unrealizedRoi)
                    : margin > 0 ? (pnl / margin) * 100 : 0
                  const sl = absoluteStopLoss(position)
                  const tp = absoluteTakeProfit(position)
                  const trailing = position.manualProtectionOverride?.trailingEnabled === true || position.trailingActive === true
                  const status = String(position.status || "open").toLowerCase()
                  const isBusy = busyId === position.id

                  return (
                    <TableRow key={position.id} className="group">
                      <TableCell className="py-1.5 pl-3">
                        <div className="flex items-center gap-2">
                          <span className={`grid size-6 place-items-center rounded border ${direction === "long" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}>
                            {direction === "long" ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                          </span>
                          <div>
                            <div className="font-semibold">{position.symbol}</div>
                            <div className="flex items-center gap-1 text-[9px] uppercase text-muted-foreground">
                              <span>{direction}</span>
                              <span>·</span>
                              <span>{sourceOf(position)}</span>
                              {position.setVariant ? <><span>·</span><span>{position.setVariant}</span></> : null}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-1.5 font-mono text-[11px] tabular-nums">
                        <div>{formatPrice(entry)} <span className="text-muted-foreground">→</span> {formatPrice(mark)}</div>
                        <div className="text-[9px] text-muted-foreground">Liq {formatPrice(position.liquidationPrice)}</div>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <div className="font-mono text-[11px] tabular-nums">{formatQuantity(quantity)} · {Math.max(1, finite(position.leverage) || 1)}x</div>
                        <div className="text-[9px] text-muted-foreground">{formatMoney(margin)} · {position.marginType || "—"}</div>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <div className={`font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                          {formatMoney(pnl)}
                        </div>
                        <div className={`text-[9px] tabular-nums ${roi >= 0 ? "text-emerald-600/80 dark:text-emerald-400/80" : "text-rose-600/80 dark:text-rose-400/80"}`}>{formatPercent(roi)}</div>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <div className="grid grid-cols-[20px_1fr] gap-x-1 font-mono text-[10px] tabular-nums">
                          <span className="text-rose-500">SL</span><span>{formatPrice(trailing ? position.trailingStopPrice || sl : sl)}</span>
                          <span className="text-emerald-500">TP</span><span>{formatPrice(tp)}</span>
                        </div>
                        <div className="mt-0.5 flex gap-1">
                          {trailing ? <Badge variant="outline" className="h-4 border-sky-500/30 px-1 text-[8px]">Trail {position.manualProtectionOverride?.trailingDistancePct ?? ""}%</Badge> : null}
                          {position.manualProtectionOverride ? <Badge variant="outline" className="h-4 border-amber-500/30 px-1 text-[8px]">Manual</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Badge variant="outline" className={`h-5 px-1.5 text-[9px] ${statusTone(status)}`}>{status.replaceAll("_", " ")}</Badge>
                        <div className="mt-0.5 max-w-[180px] truncate text-[9px] text-muted-foreground" title={position.statusReason || ""}>
                          {position.createdAt ? formatTimestamp(position.createdAt) : "—"}
                        </div>
                      </TableCell>
                      <TableCell className="py-1.5 pr-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-1.5 text-[9px]"
                            disabled={isBusy || status.includes("closing")}
                            onClick={() => { setProtectionFocus("protection"); setProtectionPosition(position) }}
                          >
                            <Shield className="mr-1 size-3" /> TP / SL
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-1.5 text-[9px]"
                            disabled={isBusy || status.includes("closing")}
                            onClick={() => { setProtectionFocus("trailing"); setProtectionPosition(position) }}
                          >
                            <TimerReset className="mr-1 size-3" /> Trailing
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 px-1.5 text-[9px]"
                            disabled={isBusy || status.includes("closing")}
                            onClick={() => setClosePosition(position)}
                          >
                            {isBusy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <CircleStop className="mr-1 size-3" />}
                            Close
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-28 text-center text-xs text-muted-foreground">
                      {positions.length === 0 ? "No active live positions for this connection." : "No positions match the filters."}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(protectionPosition)} onOpenChange={(open) => { if (!open && !busyId) setProtectionPosition(null) }}>
        <DialogContent className="max-w-xl gap-3 p-4">
          <DialogHeader className="gap-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              {protectionFocus === "trailing" ? <TimerReset className="size-4 text-sky-500" /> : <Shield className="size-4 text-emerald-500" />}
              {protectionPosition?.symbol} protection
            </DialogTitle>
            <DialogDescription className="text-xs">
              Values are persisted and reconciled through reduce-only control orders. Strategy defaults can be restored at any time.
            </DialogDescription>
          </DialogHeader>

          {protectionPosition ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/20 p-2 text-[10px]">
                <div><span className="text-muted-foreground">Side</span><div className="font-semibold uppercase">{positionDirection(protectionPosition)}</div></div>
                <div><span className="text-muted-foreground">Entry</span><div className="font-mono font-semibold">{formatPrice(positionEntry(protectionPosition))}</div></div>
                <div><span className="text-muted-foreground">Mark</span><div className="font-mono font-semibold">{formatPrice(positionMark(protectionPosition))}</div></div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="live-stop-loss" className="flex items-center gap-1 text-xs"><ArrowDownToLine className="size-3 text-rose-500" /> Stop loss price</Label>
                  <Input id="live-stop-loss" type="number" min="0" step="any" value={stopLossPrice} onChange={(event) => setStopLossPrice(event.target.value)} className="h-8 font-mono text-xs" placeholder="Required unless trailing is active" />
                  <p className="text-[9px] text-muted-foreground">May lock profit above entry for longs / below entry for shorts, but must remain behind the current mark.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="live-take-profit" className="flex items-center gap-1 text-xs"><ArrowUpFromLine className="size-3 text-emerald-500" /> Take profit price</Label>
                  <Input id="live-take-profit" type="number" min="0" step="any" value={takeProfitPrice} onChange={(event) => setTakeProfitPrice(event.target.value)} className="h-8 font-mono text-xs" placeholder="Optional" />
                  <p className="text-[9px] text-muted-foreground">Clear to remove the fixed target while keeping stop or trailing protection active.</p>
                </div>
              </div>

              <div className={`rounded-md border p-2.5 ${protectionFocus === "trailing" ? "border-sky-500/40 bg-sky-500/5" : "bg-muted/10"}`}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="live-trailing" className="flex items-center gap-1.5 text-xs"><TimerReset className="size-3.5 text-sky-500" /> Trailing stop / Trailing protection</Label>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">Ratchets only in the profitable direction and survives reloads or server restarts.</p>
                  </div>
                  <Switch id="live-trailing" checked={trailingEnabled} onCheckedChange={setTrailingEnabled} />
                </div>
                {trailingEnabled ? (
                  <div className="mt-2 grid grid-cols-[1fr_auto] items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="live-trailing-distance" className="text-[10px]">Distance from latest mark</Label>
                      <Input id="live-trailing-distance" type="number" min="0.05" max="25" step="0.05" value={trailingDistancePct} onChange={(event) => setTrailingDistancePct(event.target.value)} className="h-8 font-mono text-xs" />
                    </div>
                    <span className="pb-2 text-xs text-muted-foreground">%</span>
                  </div>
                ) : null}
              </div>

              {validationError ? (
                <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-[10px] text-rose-700 dark:text-rose-300">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {validationError}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="gap-1.5 sm:justify-between">
            <Button variant="ghost" size="sm" className="h-8 text-xs" disabled={Boolean(busyId)} onClick={restoreProtection}>
              <TimerReset className="mr-1.5 size-3.5" /> Restore strategy defaults
            </Button>
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="sm" className="h-8 text-xs" disabled={Boolean(busyId)} onClick={() => setProtectionPosition(null)}>Cancel</Button>
              <Button size="sm" className="h-8 text-xs" disabled={Boolean(busyId)} onClick={submitProtection}>
                {busyId ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <SlidersHorizontal className="mr-1.5 size-3.5" />}
                Apply protection
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(closePosition)} onOpenChange={(open) => { if (!open && !busyId) setClosePosition(null) }}>
        <DialogContent className="max-w-md gap-3 p-4">
          <DialogHeader className="gap-1">
            <DialogTitle className="flex items-center gap-2 text-base text-rose-600 dark:text-rose-400"><CircleStop className="size-4" /> Close position · {closePosition?.symbol}</DialogTitle>
            <DialogDescription className="text-xs">
              A coordinated reduce-only close is submitted. The row remains visible until the exchange confirms zero open quantity.
            </DialogDescription>
          </DialogHeader>
          {closePosition ? (
            <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/20 p-2 text-[10px]">
              <div><span className="text-muted-foreground">Direction</span><div className="font-semibold uppercase">{positionDirection(closePosition)}</div></div>
              <div><span className="text-muted-foreground">Quantity</span><div className="font-mono font-semibold">{formatQuantity(positionQuantity(closePosition))}</div></div>
              <div><span className="text-muted-foreground">Open PnL</span><div className={`font-mono font-semibold ${positionPnl(closePosition) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{formatMoney(positionPnl(closePosition))}</div></div>
            </div>
          ) : null}
          <DialogFooter className="gap-1.5">
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={Boolean(busyId)} onClick={() => setClosePosition(null)}>Keep open</Button>
            <Button variant="destructive" size="sm" className="h-8 text-xs" disabled={Boolean(busyId)} onClick={confirmClose}>
              {busyId ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <CircleStop className="mr-1.5 size-3.5" />}
              Confirm close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
