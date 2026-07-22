# CTS-K-N System / Modules Picture

This document is a visual map of the CTS-K-N trading platform. It shows how the UI, API routes, trade engines, data-processing modules, exchange connectors, Redis persistence, monitoring, and deployment flows fit together.

## 1. Full System Overview

```mermaid
flowchart TB
  User["Operator / Trader"]

  subgraph Browser["Next.js Browser UI"]
    SettingsUI["Settings\nOverall / Exchange / Strategy / System"]
    Dashboards["Dashboards\nMain, Monitoring, Statistics, Tracking"]
    LiveUI["Live Trading & Positions"]
    PresetsUI["Presets / Sets / Backtests"]
    AlertsUI["Alerts & Logs"]
  end

  subgraph AppRouter["Next.js App Router"]
    Pages["app/* pages"]
    APIRoutes["app/api/* route handlers"]
    Health["Health / Readiness APIs"]
    InstallAPI["Install / Remote SSH Deploy APIs"]
    CronAPI["Cron / Continuity APIs"]
  end

  subgraph Core["Core Services (lib/*)"]
    Startup["Startup Coordinator\npre-startup, migrations, seeders"]
    Settings["Settings & Connection Managers"]
    Engine["Trade Engine Manager"]
    Progression["Progression / Statistics / Tracking"]
    Monitoring["Monitoring, Logs, Metrics, Alerts"]
    Backup["Backup / Import / Export"]
  end

  subgraph Pipeline["Trading Data Pipeline"]
    MarketData["Market Data Loader / Fetcher"]
    Indicators["Indication Calculators & Sets"]
    Strategies["Strategy Evaluators & Sets"]
    PseudoPos["Pseudo Position Managers"]
    RealStage["Real-stage Gates / Coordination"]
    LiveOrders["Live Order Safety & Executor"]
  end

  subgraph Exchanges["Exchange Connectors"]
    BingX["BingX"]
    Binance["Binance"]
    Bybit["Bybit"]
    OKX["OKX"]
    OrangeX["OrangeX"]
    Pionex["Pionex"]
    Simulated["Simulated"]
  end

  subgraph Persistence["Redis Persistence Layer"]
    RedisOps["redis-operations / redis-service"]
    Migrations["redis-migrations"]
    Keys["Connections, Settings, Progress, Positions, Logs, Metrics"]
    LocalFallback["Inline Local Redis fallback\nself-host/dev single process"]
  end

  subgraph Production["Production Deployment"]
    Build["Frozen install + full validation + build"]
    Runtime["systemd or PM2\napp + minute scheduler"]
    RemoteSSH["Remote SSH installer"]
    Verify["Schema + HTTP + persistence + restart verification"]
  end

  User --> Browser
  Browser --> Pages
  Pages --> APIRoutes
  APIRoutes --> Core
  APIRoutes --> Pipeline
  Core --> Pipeline
  Core --> Persistence
  Pipeline --> Persistence
  Pipeline --> Exchanges
  Exchanges --> Pipeline
  Monitoring --> Browser
  Persistence --> Monitoring
  InstallAPI --> RemoteSSH
  RemoteSSH --> Build --> Runtime --> Verify
  Health --> Verify
  CronAPI --> Core
```

## 2. Module Responsibilities

| Layer | Main files / directories | Responsibility |
| --- | --- | --- |
| UI pages | `app/*`, `components/*` | User-facing pages, settings forms, dashboards, statistics, live-trading views, monitoring panels, alerts, and install controls. |
| API layer | `app/api/*` | Server actions for settings, install, trade-engine control, progression stats, health checks, monitoring, backups, presets, positions, and exchange operations. |
| Startup / deploy | `lib/startup-coordinator.ts`, `lib/pre-startup.ts`, `lib/redis-migrations.ts`, `app/api/install/*` | Initialize Redis schema, seed required defaults, expose install/status endpoints, and support production/remote deployment. |
| Settings / connections | `lib/connection-manager*.ts`, `lib/connection-settings.ts`, `lib/settings-storage.ts`, `components/settings/*` | Store and edit exchange connections, credentials, symbols, engine options, per-connection settings, and global settings. |
| Trade engine | `lib/trade-engine.ts`, `lib/trade-engine/*`, `lib/symbol-data-processor.ts` | Main runtime loop that loads market data, computes indications/strategies, coordinates stages, manages progress, and controls live execution. |
| Indicators / strategies | `lib/indication-*.ts`, `lib/strategy-*.ts`, `lib/indicators/*` | Calculate indication sets, evaluate strategies, process strategy sets, and produce signals used by pseudo/real/live stages. |
| Positions / orders | `lib/*position*.ts`, `lib/order-executor.ts`, `lib/live-order-safety.ts`, `lib/real-trade-gates.ts` | Track pseudo and live positions, enforce gates/safety, size orders, reconcile live state, and place/close exchange orders. |
| Exchanges | `lib/exchange-connectors/*` | Exchange-specific adapters for market data, account data, orders, positions, and simulated trading. |
| Persistence | `lib/redis-*.ts`, `lib/local-redis.ts`, `lib/db-*.ts` | Redis-backed data store plus compatibility helpers and local single-process fallback. |
| Monitoring | `lib/*logger*.ts`, `lib/*metrics*.ts`, `app/api/monitoring/*`, `components/monitoring/*` | Runtime logs, structured logs, metrics, status, alerts, dashboards, and troubleshooting endpoints. |
| Presets / backtests | `lib/preset-*.ts`, `lib/backtest-engine.ts`, `components/presets/*` | Preset management, preset coordination engines, evaluations, backtests, and performance displays. |

## 3. Trading Pipeline Picture

```mermaid
flowchart LR
  A["Configured Connection\ncredentials + symbols + settings"] --> B["Startup / Quick Start\nload defaults + migrations"]
  B --> C["Market Data\nlatest + prehistoric candles"]
  C --> D["Indicators\nstep-based and set processors"]
  D --> E["Strategies\nbase/main/real/live evaluation"]
  E --> F["Pseudo Positions\nsimulation and statistics"]
  F --> G["Real-stage Coordination\ngates, blocks, progression"]
  G --> H{"Live enabled?"}
  H -- "No" --> I["Stats only\nprogression + dashboards"]
  H -- "Yes" --> J["Live Safety\nlimits, system-close mode, sizing"]
  J --> K["Order Executor"]
  K --> L["Exchange Connector"]
  L --> M["Exchange API"]
  M --> N["Live Positions / Orders"]
  N --> O["Redis state + logs + metrics"]
  O --> I
  O --> C
```

## 4. Settings → Overall → Install / Remote Deploy Picture

```mermaid
sequenceDiagram
  autonumber
  actor Operator
  participant UI as Settings / Overall / Install UI
  participant API as POST /api/install/remote
  participant SSH as SSH session
  participant Server as Remote Linux server
  participant Redis as Redis service
  participant App as CTS-K-N app service

  Operator->>UI: Fill host, SSH auth, repo, branch, runtime, install dir, app port, Redis URL
  UI->>API: Submit remote install request
  API->>API: Validate host/user and sanitize install inputs
  API->>API: Create temporary SSH key file when private key is provided
  API->>SSH: Start ssh or sshpass and stream bash installer to stdin
  SSH->>Server: Execute installer with sudo-capable user
  Server->>Server: Install OS packages, Node.js, pnpm, git, build tools
  Server->>Redis: Enable/start local Redis when available
  Server->>Server: Clone or pull repository branch into install directory
  Server->>Server: Write .env.production and .env.local
  Server->>Server: Frozen install, typecheck, lint, Jest, production build
  Server->>App: Install app + scheduler under systemd or PM2
  Server->>App: Enable reboot startup and restart both processes
  App->>Server: Serve HTTP on configured port
  Server->>App: Initialize schema and run authenticated scheduler tick
  Server->>App: Verify /api/health, shared persistence, identity and continuity
  Server->>App: Restart and repeat the production contract
  Server-->>API: Return stdout/stderr logs
  API-->>UI: Return success/error, service name, URL, logs
  UI-->>Operator: Show live deployment result and logs
```

## 5. Data Flow / Redis Key Families

```mermaid
flowchart TB
  subgraph Writers["Writers"]
    SettingsW["Settings UI + APIs"]
    EngineW["Trade engine workers"]
    ExchangeW["Exchange sync"]
    MonitorW["Monitoring/logging"]
    InstallW["Migrations/seeders"]
  end

  subgraph Redis["Redis namespaces / data families"]
    ConnectionKeys["connection:*\nsettings:connection:*"]
    SettingsKeys["settings:*\nconnection_settings:*"]
    EngineKeys["trade_engine_state:*\nsettings:trade_engine_state:*"]
    ProgressKeys["progression:*\nprogress_settings_snapshot"]
    PositionKeys["positions / pseudo positions / live positions"]
    LogsKeys["logs / structured logs / metrics"]
    SchemaKeys["_schema_version\nsystem:database:health"]
  end

  subgraph Readers["Readers"]
    DashboardsR["Dashboards"]
    StatusR["Status APIs"]
    EngineR["Engine loops"]
    StatsR["Statistics pages"]
    BackupR["Backup/export"]
  end

  Writers --> Redis
  Redis --> Readers
  InstallW --> SchemaKeys
  SettingsW --> ConnectionKeys
  SettingsW --> SettingsKeys
  EngineW --> EngineKeys
  EngineW --> ProgressKeys
  EngineW --> PositionKeys
  MonitorW --> LogsKeys
```

## 6. Production Runtime Picture

```mermaid
flowchart TB
  subgraph RemoteHost["Remote Linux Host"]
    subgraph OS["Operating system"]
      Supervisor["systemd or PM2\nreboot startup + restart delay"]
      RedisLocal["redis-server\noptional local persistence"]
    end

    subgraph AppDir["Install directory, e.g. /opt/cts-k-n"]
      Repo["Git checkout"]
      Env[".env.production / .env.local"]
      NextBuild[".next production build"]
      NodeModules["pnpm dependencies"]
    end

    Service["next start\nlong-lived engine owner"]
    Scheduler["portable 60-second scheduler"]
    HealthAPI["/api/health\nreadiness + deployment contract"]
  end

  Internet["Operator browser / reverse proxy"] --> Service
  Supervisor --> Service
  Supervisor --> Scheduler
  Service --> HealthAPI
  Scheduler --> Service
  Service --> RedisLocal
  Service --> ExternalRedis["External Redis / Upstash\nwhen REDIS_URL points outside host"]
  Service --> ExchangeAPIs["Exchange APIs"]
  RemoteInstaller["Settings remote SSH installer"] --> Supervisor
  RemoteInstaller --> AppDir
```

## 7. Operational Notes

- The browser never calls exchanges directly; it calls Next.js API routes, and server-side modules call exchange connectors.
- Redis is the central coordination layer for settings, progress, positions, logs, health, and metrics.
- Self-hosted production runs one long-lived `next start` engine owner and one portable minute scheduler under systemd or PM2.
- Kilo/Cloudflare request workers own HTTP and the scheduled recovery trigger; a distinct long-lived owner is required for sub-second engine processing and SSH installation.
- Multi-instance or serverless production should use a shared durable Redis URL instead of relying on the inline local fallback.
- Remote SSH deployment requires a sudo-capable SSH user. Private-key auth is preferred; password auth only works when `sshpass` is installed on the web server that runs the installer endpoint.
