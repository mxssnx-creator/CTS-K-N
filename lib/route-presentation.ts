export interface RoutePresentation {
  title: string
  description: string
  eyebrow: string
}

const ROUTES: Record<string, RoutePresentation> = {
  "/": {
    title: "Command Center",
    description: "Quickstart, progression, live execution, and system health in one operational workspace.",
    eyebrow: "CTS-K-N",
  },
  "/active-exchange": {
    title: "Active Exchange",
    description: "Prehistoric analysis, market state, and execution metrics for the selected running connection.",
    eyebrow: "Command",
  },
  "/live-trading": {
    title: "Live Execution",
    description: "Authoritative exchange orders, positions, control orders, and execution progression.",
    eyebrow: "Command",
  },
  "/tracking": {
    title: "Execution Tracking",
    description: "Position lineage, progression health, exchange relations, and operational events.",
    eyebrow: "Command",
  },
  "/presets": {
    title: "Preset Optimizer",
    description: "Rank and coordinate complete preset configurations across independent progression stages.",
    eyebrow: "Strategy Lab",
  },
  "/indications": {
    title: "Indications",
    description: "Signal types, confidence, calculation windows, and current market-state outputs.",
    eyebrow: "Strategy Lab",
  },
  "/strategies": {
    title: "Strategy Matrix",
    description: "Independent strategy types, configurations, sets, results, and execution eligibility.",
    eyebrow: "Strategy Lab",
  },
  "/sets": {
    title: "Configuration Sets",
    description: "Create and control complete strategy-set definitions without hidden execution ceilings.",
    eyebrow: "Strategy Lab",
  },
  "/statistics": {
    title: "Statistics",
    description: "Net results, ratios, profit factor, progression quality, and live exchange analytics.",
    eyebrow: "Intelligence",
  },
  "/statistics/direct-trade": {
    title: "Direct-Trade Analytics",
    description: "Block comparisons, DDT, position cost, ratios, volumes, and execution outcomes.",
    eyebrow: "Intelligence",
  },
  "/statistics/indications/common": {
    title: "Common Indication Analytics",
    description: "Independent common-indication quality, windows, positions, and result statistics.",
    eyebrow: "Intelligence",
  },
  "/statistics/indications/signal": {
    title: "Signal Analytics",
    description: "Signal progression, position outcomes, source coverage, and calculation quality.",
    eyebrow: "Intelligence",
  },
  "/analysis": {
    title: "Position Analysis",
    description: "Pseudo-position ratios, costs, range behavior, and result-quality analysis.",
    eyebrow: "Intelligence",
  },
  "/portfolios": {
    title: "Portfolios",
    description: "Portfolio-level positions, orders, performance, and risk controls.",
    eyebrow: "Intelligence",
  },
  "/logistics": {
    title: "Processing Logistics",
    description: "Queues, async batches, worker coordination, persistence, and processing throughput.",
    eyebrow: "Operations",
  },
  "/structure": {
    title: "System Structure",
    description: "Cross-stage topology, data flow, runtime relations, and functional readiness.",
    eyebrow: "Operations",
  },
  "/monitoring": {
    title: "Monitoring",
    description: "Runtime health, CPU and memory, logs, continuity, and self-healing state.",
    eyebrow: "Operations",
  },
  "/monitoring-advanced": {
    title: "Advanced Monitoring",
    description: "Broadcaster, SSE, processing-phase, and connection telemetry in real time.",
    eyebrow: "Operations",
  },
  "/alerts": {
    title: "Alerts",
    description: "Operational, execution, connection, and market alert management.",
    eyebrow: "Operations",
  },
  "/settings": {
    title: "Settings",
    description: "Connections, engine defaults, strategies, indications, and runtime safeguards.",
    eyebrow: "Control",
  },
  "/settings/indications/auto": {
    title: "Auto Indication Settings",
    description: "Configure adaptive indication ranges and independent calculation behavior.",
    eyebrow: "Settings",
  },
  "/settings/indications/common": {
    title: "Common Indication Settings",
    description: "Configure common types, windows, periods, and persisted calculation inputs.",
    eyebrow: "Settings",
  },
  "/settings/indications/main": {
    title: "Main Indication Settings",
    description: "Configure main-stage indication formulas, type independence, and source coordination.",
    eyebrow: "Settings",
  },
  "/settings/indications/optimal": {
    title: "Optimal Indication Settings",
    description: "Configure optimization ranges, evaluation rules, and adaptive indication behavior.",
    eyebrow: "Settings",
  },
  "/settings/indications/signal": {
    title: "Signal Indication Settings",
    description: "Configure signal sources, tracking windows, and complete position evaluation.",
    eyebrow: "Settings",
  },
  "/autotest": {
    title: "Autotest & Debug",
    description: "Run bounded diagnostics across APIs, data contracts, processing, and execution safety.",
    eyebrow: "Validation",
  },
  "/testing/connection": {
    title: "Connection Validation",
    description: "Validate exchange connectivity and authenticated API capabilities safely.",
    eyebrow: "Validation",
  },
  "/testing/orders": {
    title: "Order Safety Lab",
    description: "Explicitly gated order lifecycle, cancellation, control-order, and tracking checks.",
    eyebrow: "Validation",
  },
  "/testing/engine": {
    title: "Engine Validation",
    description: "Inspect processing stages, worker controls, and runtime progression behavior.",
    eyebrow: "Validation",
  },
  "/additional": {
    title: "Reference Tools",
    description: "Supplementary diagnostics, calculation references, and local workspace utilities.",
    eyebrow: "Reference",
  },
  "/additional/chat-history": {
    title: "Chat History",
    description: "Review and export locally persisted workspace conversation records.",
    eyebrow: "Reference",
  },
  "/additional/volume-corrections": {
    title: "Volume Ratio Reference",
    description: "Systemwide volume, leverage, progression, and ratio-calculation reference.",
    eyebrow: "Reference",
  },
  "/admin/check-tables": {
    title: "Database Inspector",
    description: "Read-only visibility into required tables, schema state, and migration readiness.",
    eyebrow: "Administration",
  },
  "/admin/migrate": {
    title: "Database Migrations",
    description: "Authenticated migration status, repair workflow, and schema readiness.",
    eyebrow: "Administration",
  },
  "/main": {
    title: "Command Center",
    description: "Primary trading and progression control workspace.",
    eyebrow: "CTS-K-N",
  },
  "/main/realtime": {
    title: "Realtime Processing",
    description: "Continuous post-historic processing, updates, and connection telemetry.",
    eyebrow: "Command",
  },
  "/health": {
    title: "Application Health",
    description: "Minimal server-render and application-shell readiness check.",
    eyebrow: "Diagnostics",
  },
  "/simple": {
    title: "System Snapshot",
    description: "Compact authenticated application and migration-state snapshot.",
    eyebrow: "Diagnostics",
  },
  "/minimal": {
    title: "Minimal Runtime",
    description: "Reduced control-plane runtime and connectivity verification.",
    eyebrow: "Diagnostics",
  },
  "/test": {
    title: "Authentication Test",
    description: "Internal authenticated rendering and context validation.",
    eyebrow: "Diagnostics",
  },
  "/test-layout": {
    title: "Layout Test",
    description: "Internal application-shell rendering validation.",
    eyebrow: "Diagnostics",
  },
  "/test-simple": {
    title: "System Test",
    description: "Internal page and component rendering validation.",
    eyebrow: "Diagnostics",
  },
}

function humanize(segment: string): string {
  return decodeURIComponent(segment)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function getRoutePresentation(pathname: string): RoutePresentation {
  const normalized = pathname !== "/" ? pathname.replace(/\/+$/, "") : "/"
  const exact = ROUTES[normalized]
  if (exact) return exact

  if (normalized.startsWith("/portfolios/")) {
    return {
      title: "Portfolio Detail",
      description: "Performance metrics, positions, and portfolio risk controls.",
      eyebrow: "Intelligence",
    }
  }

  const segments = normalized.split("/").filter(Boolean)
  const title = humanize(segments.at(-1) || "Command Center")
  const eyebrow = segments.length > 1 ? humanize(segments[0]) : "CTS-K-N"
  return {
    title,
    description: "CTS-K-N operational workspace.",
    eyebrow,
  }
}
