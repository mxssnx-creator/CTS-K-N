"use client"

import { useEffect, useRef } from "react"

/**
 * Tab-leader election for the cron heartbeat.
 *
 * Problem: every open tab (or page reload) called /api/cron/generate-indications
 * every 3 s. With two tabs that meant double cycle counts and races on
 * progression:{conn} hincrby. The server-side Redis lock (cron_lock:generate-indications,
 * 5s NX EX) is the authoritative guard — it prevents double-processing regardless
 * of how many tabs exist. This client-side layer is a complementary optimisation:
 * it stops non-leader tabs from even sending the request, which reduces pointless
 * HTTP traffic and makes the "skipped" server response unnecessary for the common case.
 *
 * Algorithm (BroadcastChannel):
 *  1. On mount each tab generates a random tabId and announces itself as
 *     a candidate via the "cts:cron" channel.
 *  2. Tabs compete by lowest tabId (simple deterministic ordering that needs
 *     no round-trips). The tab whose tabId is the lexicographic minimum among
 *     all recently seen tabs becomes the leader.
 *  3. The leader fires the cron and broadcasts a "heartbeat" every intervalMs.
 *  4. Non-leaders receive the heartbeat and reset their "leader gone?" watchdog.
 *  5. When the leader tab closes or navigates away its BroadcastChannel closes
 *     and stops sending heartbeats. After 2× intervalMs without a heartbeat any
 *     surviving tab re-runs the election and the new minimum-tabId tab takes over.
 *  6. On page reload the old tab vanishes (unmount cleans up), so the remaining
 *     tabs elect a new leader within one watchdog window.
 *
 * Fallback: BroadcastChannel is unavailable in Safari < 15.4 and in some
 * private-browsing contexts. When unavailable every tab becomes its own leader
 * and the Redis lock provides the sole dedup guarantee.
 */

const CHANNEL_NAME    = "cts:cron-leader"
const HEARTBEAT_TYPE  = "heartbeat"
const ANNOUNCE_TYPE   = "announce"

type LeaderMsg =
  | { type: typeof HEARTBEAT_TYPE; tabId: string }
  | { type: typeof ANNOUNCE_TYPE;  tabId: string }

function makeCronTabId(): string {
  // Stable within a page session; reset on reload (intentional: old tab should yield).
  try {
    const stored = sessionStorage.getItem("cts:tabId")
    if (stored) return stored
  } catch { /* sessionStorage unavailable */ }
  const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  try { sessionStorage.setItem("cts:tabId", id) } catch { /* ignore */ }
  return id
}

/**
 * Client-side hook that periodically generates indications by calling the API.
 * Only the elected leader tab fires requests; all other tabs stand by and take
 * over automatically if the leader disappears.
 */
export function useIndicationGenerator(enabled: boolean = true, intervalMs: number = 3000) {
  const isLeaderRef  = useRef(false)
  const tabIdRef     = useRef<string>("")
  const channelRef   = useRef<BroadcastChannel | null>(null)
  const peerTabIds   = useRef<Set<string>>(new Set())
  const watchdogRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const cronRef      = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return

    // ── Bootstrap ───────────────────────────────────────────────────────────
    const myTabId = makeCronTabId()
    tabIdRef.current = myTabId

    const generateIndications = async () => {
      try {
        await fetch("/api/cron/generate-indications", {
          method: "GET",
          cache: "no-store",
          headers: { "x-client-trigger": "indication-hook" },
        })
      } catch {
        // Silently ignore network errors — the server has its own error handling.
      }
    }

    // ── Helper: become the leader ────────────────────────────────────────────
    const becomeLeader = () => {
      if (isLeaderRef.current) return   // already leader
      isLeaderRef.current = true

      // Start firing cron + broadcasting heartbeat
      generateIndications()
      cronRef.current = setInterval(generateIndications, intervalMs)

      heartbeatRef.current = setInterval(() => {
        const ch = channelRef.current
        if (!ch) return
        const msg: LeaderMsg = { type: HEARTBEAT_TYPE, tabId: myTabId }
        try { ch.postMessage(msg) } catch { /* channel closed — no-op */ }
      }, Math.max(intervalMs, 2000))
    }

    // ── Helper: resign leadership (another tab with lower tabId appeared) ────
    const resignLeader = () => {
      if (!isLeaderRef.current) return
      isLeaderRef.current = false
      if (cronRef.current)      { clearInterval(cronRef.current);      cronRef.current = undefined }
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = undefined }
    }

    // ── Helper: re-run election based on seen peers ──────────────────────────
    const runElection = () => {
      // Build the full candidate pool including ourselves.
      const allIds = [myTabId, ...Array.from(peerTabIds.current)]
      const leader = allIds.slice().sort()[0]   // lexicographic minimum
      if (leader === myTabId) {
        becomeLeader()
      } else {
        resignLeader()
      }
    }

    // ── BroadcastChannel setup ───────────────────────────────────────────────
    let hasBroadcastChannel = false
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const ch = new BroadcastChannel(CHANNEL_NAME)
        channelRef.current = ch
        hasBroadcastChannel = true

        ch.onmessage = (ev: MessageEvent<LeaderMsg>) => {
          const { type, tabId } = ev.data

          if (type === ANNOUNCE_TYPE) {
            // New peer appeared — record it and re-run election.
            peerTabIds.current.add(tabId)
            runElection()
            // Respond with our own announcement so the new tab knows we exist.
            try {
              ch.postMessage({ type: ANNOUNCE_TYPE, tabId: myTabId } satisfies LeaderMsg)
            } catch { /* ignore */ }
          }

          if (type === HEARTBEAT_TYPE) {
            // The current leader is alive — record it and reset watchdog.
            peerTabIds.current.add(tabId)

            if (watchdogRef.current) clearTimeout(watchdogRef.current)
            watchdogRef.current = setTimeout(() => {
              // No heartbeat for 2× intervalMs → leader is gone.
              // Remove it from peers and re-elect.
              peerTabIds.current.delete(tabId)
              runElection()
            }, intervalMs * 2 + 500)

            // If the heartbeat came from a tab with lower id than ours,
            // make sure we're not running as leader.
            if (tabId < myTabId) {
              resignLeader()
            }
          }
        }

        // Announce ourselves so all existing tabs know we joined.
        try {
          ch.postMessage({ type: ANNOUNCE_TYPE, tabId: myTabId } satisfies LeaderMsg)
        } catch { /* ignore */ }

        // Give peers 300ms to respond with their announcements, then elect.
        const electionTimeout = setTimeout(runElection, 300)
        // Clean up the election timeout if the component unmounts before it fires.
        return () => {
          clearTimeout(electionTimeout)
          clearTimeout(watchdogRef.current)
          clearInterval(cronRef.current)
          clearInterval(heartbeatRef.current)
          try { ch.close() } catch { /* ignore */ }
          channelRef.current = null
          isLeaderRef.current = false
        }
      }
    } catch {
      hasBroadcastChannel = false
    }

    // ── Fallback: no BroadcastChannel — every tab is its own "leader" ────────
    // The server-side Redis lock ensures only one execution per 5s window.
    if (!hasBroadcastChannel) {
      becomeLeader()
      return () => {
        clearInterval(cronRef.current)
        clearInterval(heartbeatRef.current)
        isLeaderRef.current = false
      }
    }
  }, [enabled, intervalMs])
}

/**
 * Component version that can be dropped into any page.
 */
export function IndicationGeneratorProvider({ children }: { children?: React.ReactNode }) {
  // Production progress is server-owned (engine + portable minute scheduler),
  // so closing/reloading the dashboard cannot pause it and browsers do not need
  // access to protected cron endpoints. Keep the legacy browser heartbeat only
  // for local development or an explicit diagnostic opt-in.
  const browserHeartbeatEnabled =
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PUBLIC_ENABLE_BROWSER_INDICATION_CRON === "1"
  useIndicationGenerator(browserHeartbeatEnabled, 3000)
  return <>{children}</>
}
