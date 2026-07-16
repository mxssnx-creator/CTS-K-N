export const TOP_INFO_LAYER_STORAGE_KEY = "top-info-layer"

export const TOP_INFO_LAYER_OPTIONS = [
  { id: "circuit-flow", label: "Circuit Flow", description: "Calm circuit paths and data nodes" },
  { id: "market-mesh", label: "Market Mesh", description: "Dynamic market waves and graph mesh" },
  { id: "signal-grid", label: "Signal Grid", description: "Minimal telemetry grid and pulse line" },
  { id: "none", label: "None", description: "Plain theme background" },
] as const

export type TopInfoLayerId = (typeof TOP_INFO_LAYER_OPTIONS)[number]["id"]

export const DEFAULT_TOP_INFO_LAYER: TopInfoLayerId = "circuit-flow"

export function normalizeTopInfoLayer(value: string | null | undefined): TopInfoLayerId {
  return TOP_INFO_LAYER_OPTIONS.some((option) => option.id === value)
    ? value as TopInfoLayerId
    : DEFAULT_TOP_INFO_LAYER
}

export function applyTopInfoLayer(root: HTMLElement, value: TopInfoLayerId): void {
  root.dataset.topInfoLayer = value
}
