import { NextResponse } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionEligibleForEngine,
  isConnectionInActivePanel,
} from "@/lib/connection-state-utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/system/complete-workflow
 * Returns comprehensive workflow documentation and current system state
 */
export async function GET() {
  try {
    await initRedis()
    const connections = await getAllConnections()

    // Analyze current state
    const analysis = {
      total: connections.length,
      baseExchanges: connections.filter((c: any) => 
        ["bybit", "bingx", "binance", "okx", "gateio", "kucoin", "mexc", "bitget", "pionex", "orangex", "huobi"].includes(
          (c.exchange || "").toLowerCase()
        )
      ).length,
      withCredentials: connections.filter((c: any) => hasConnectionCredentials(c, 10)).length,
      inActivePanel: connections.filter((c: any) => isConnectionInActivePanel(c)).length,
      dashboardEnabled: connections.filter((c: any) => isConnectionDashboardEnabled(c)).length,
      readyForProcessing: connections.filter((c: any) => isConnectionEligibleForEngine(c)).length,
    }

    return NextResponse.json({
      status: "complete",
      version: "3.2",
      timestamp: new Date().toISOString(),
      
      // System Analysis
      systemState: analysis,
      
      // Complete Workflow Documentation
      workflow: {
        overview: "4-step process to enable trading engine processing",
        steps: [
          {
            step: 1,
            title: "Prepare API Credentials",
            description: "Obtain API credentials from your exchange (BingX, Bybit, Binance, OKX, etc.)",
            requirements: [
              "API Key (public key from exchange)",
              "API Secret (private key from exchange)",
              "Read/Write permissions for trading",
              "Sub-account permissions if using sub-account"
            ],
            documentation: {
              bingx: "https://bingx-api.github.io/docs/",
              bybit: "https://bybit-exchange.github.io/docs/",
              binance: "https://binance-docs.github.io/apidocs/",
              okx: "https://www.okx.com/docs-v5/en/",
              gateio: "https://www.gate.io/docs/developers/apiv4/",
              kucoin: "https://docs.kucoin.com/",
            }
          },
          {
            step: 2,
            title: "Add Connection with Credentials",
            description: "Go to Settings → Connections → Select exchange → Edit → Enter API key and secret",
            substeps: [
              "Click Settings (top nav)",
              "Select Connections tab",
              "Find your exchange (Bybit X03, BingX X01, etc.)",
              "Click Edit / Credentials icon",
              "Enter API Key and API Secret",
              "Leave testnet as OFF (mainnet only)",
              "Click Test Connection to verify",
              "Click Save Credentials"
            ],
            expected: "✓ Connection shows test status (passed/failed)",
            endpoint: "POST /api/settings/connections/{id}/test",
          },
          {
            step: 3,
            title: "Add to Active Connections Panel",
            description: "Return to Dashboard and add connection to Active panel",
            substeps: [
              "Go to Dashboard (click logo or home)",
              "Click 'Add Connection' button in Active Connections",
              "Select your connection from the list",
              "Connection appears in Active Connections panel",
              "It shows disabled by default"
            ],
            expected: "✓ Connection visible in Active Connections section",
            endpoint: "POST /api/settings/connections/add-to-active",
          },
          {
            step: 4,
            title: "Enable Processing",
            description: "Toggle the Enable switch to start engine processing",
            substeps: [
              "In Active Connections panel, find your connection",
              "Click the Enable toggle (currently OFF/gray)",
              "Toggle switches to ON/blue",
              "Engine immediately starts processing",
              "Watch the progression bar fill",
              "Monitor logs in the progression panel"
            ],
            expected: "✓ Engine processes market data, indications, strategies",
            endpoint: "POST /api/settings/connections/{id}/toggle-dashboard",
            processing: {
              phase1: "Market Data Collection (1-2 seconds)",
              phase2: "Historical Data Analysis (3-5 seconds)",
              phase3: "Indication Calculation (continuous)",
              phase4: "Strategy Evaluation (continuous)",
              phase5: "Real-time Monitoring (active)",
              phase6: "Live Trading Signals (when enabled)"
            }
          }
        ],
        
        // Complete API Reference
        endpoints: {
          // Connections
          connections: {
            list: {
              method: "GET",
              path: "/api/settings/connections",
              description: "List all connections (predefined and user-created)",
              response: "Array of ExchangeConnection objects"
            },
            create: {
              method: "POST",
              path: "/api/settings/connections",
              description: "Create a new connection from predefined template",
              body: { api_key: "string", api_secret: "string", exchange: "string" }
            },
            test: {
              method: "POST",
              path: "/api/settings/connections/{id}/test",
              description: "Test connection with credentials (3 retries, 1s interval)",
              retry: "3 attempts, 1 second interval, 30 second timeout"
            },
            toggleDashboard: {
              method: "POST",
              path: "/api/settings/connections/{id}/toggle-dashboard",
              description: "Enable/disable connection on dashboard (starts engine processing)",
              effect: "Sets is_enabled_dashboard, triggers engine lifecycle"
            },
            addToActive: {
              method: "POST",
              path: "/api/settings/connections/add-to-active",
              description: "Add connection to Active panel"
            },
            initPredefined: {
              method: "GET",
              path: "/api/settings/connections/init-predefined",
              description: "Initialize predefined templates (auto-called on startup)"
            }
          },
          
          // Trade Engine
          engine: {
            status: {
              method: "GET",
              path: "/api/trade-engine/status",
              description: "Get global engine status and active connections",
              returns: "Active connections with cycle counts, results, errors"
            },
            start: {
              method: "POST",
              path: "/api/trade-engine/start",
              description: "Start trade engine global coordinator"
            },
            stop: {
              method: "POST",
              path: "/api/trade-engine/stop",
              description: "Stop all engine processing"
            },
            quickStart: {
              method: "POST",
              path: "/api/trade-engine/quick-start",
              description: "Auto-setup connection: test, add to active, enable processing",
              body: { action: "enable" }
            },
          },
          
          // Dashboard Stats
          stats: {
            system: {
              method: "GET",
              path: "/api/main/system-stats-v3",
              description: "Comprehensive system statistics",
              includes: "Connections, engine status, database metrics, credential count"
            },
            monitoring: {
              method: "GET",
              path: "/api/system/monitoring",
              description: "Real-time system monitoring",
              includes: "CPU, memory, database keys, engine cycles"
            }
          },
          
          // Setup & Demo
          setup: {
            demoStatus: {
              method: "GET",
              path: "/api/system/demo-setup",
              description: "Check demo setup status and requirements"
            },
            demoSetup: {
              method: "POST",
              path: "/api/system/demo-setup",
              description: "Quick setup with credentials for testing",
              body: { api_key: "string", api_secret: "string", exchange: "string" }
            }
          },
          
          // Progression & Logs
          progression: {
            get: {
              method: "GET",
              path: "/api/connections/progression/{connectionId}",
              description: "Get current progression phase and status"
            },
            logs: {
              method: "GET",
              path: "/api/connections/progression/{connectionId}/logs",
              description: "Get detailed progression logs"
            }
          }
        },
        
        // Configuration
        configuration: {
          entryLimits: {
            indications: {
              direction: 500,
              move: 500,
              active: 500,
              optimal: 500,
              active_advanced: 500,
            },
            strategies: {
              base: 500,
              main: 500,
              real: 500,
              live: 500,
            },
            progressionLogs: 500,
            endpoint: "POST /api/settings/set-limits"
          },
          
          intervals: {
            periodictesting: "Every 5 minutes",
            autotestOnCreation: "Yes, with 3 retries",
            marketDataCollection: "Every 1-2 seconds",
            indicationCalculation: "Continuous",
            strategyEvaluation: "Continuous",
            realtimeProcessing: "Streaming"
          }
        },
        
        // Troubleshooting
        troubleshooting: {
          "No connections eligible for processing": {
            cause: "No connections have valid API credentials",
            solution: [
              "1. Go to Settings → Connections",
              "2. Select a connection (e.g., BingX X01)",
              "3. Click Edit/Credentials",
              "4. Enter real API key and secret from your exchange",
              "5. Click Test Connection to verify",
              "6. Click Save",
              "7. Go to Dashboard and add to Active panel"
            ]
          },
          "Connection test failed": {
            cause: "Invalid API credentials or network issue",
            solution: [
              "1. Verify API key and secret are copied correctly",
              "2. Check API key has Read/Write permissions",
              "3. Check if sub-account is properly configured",
              "4. Wait a moment and try testing again (3 retries automatic)",
              "5. Verify exchange API documentation for your setup"
            ]
          },
          "Engine shows 0 cycles": {
            cause: "No connections enabled on dashboard or insufficient time elapsed",
            solution: [
              "1. Ensure connection is in Active panel",
              "2. Toggle the Enable switch to ON",
              "3. Wait 5-10 seconds for engine to initialize",
              "4. Check progression panel for phase updates",
              "5. Review system monitoring for CPU/memory issues"
            ]
          },
          "Preview not loading": {
            cause: "Client-side error or hydration mismatch",
            solution: [
              "1. Check browser console for errors",
              "2. Hard refresh the page (Ctrl+Shift+R)",
              "3. Clear browser cache",
              "4. Verify API endpoints are responding: GET /api/trade-engine/status",
              "5. Check server logs for errors"
            ]
          }
        }
      },
      
      // Quick Links
      quickLinks: {
        settings: "/settings?tab=connections",
        dashboard: "/",
        documentation: "/docs",
        api: "/api/system/complete-workflow",
        status: "/api/trade-engine/status",
        monitoring: "/api/system/monitoring",
      },
      
      // Current State Summary
      currentState: {
        readiness: analysis.readyForProcessing > 0 ? "Ready for Trading" : "Awaiting Setup",
        nextAction: analysis.withCredentials === 0 
          ? "Add API credentials to a connection in Settings"
          : analysis.inActivePanel === 0
          ? "Add connection to Active panel in Dashboard"
          : analysis.dashboardEnabled === 0
          ? "Toggle Enable switch in Active Connections"
          : "Engine is processing - monitor progression panel",
        details: analysis
      }
    })
  } catch (error) {
    return NextResponse.json({
      error: "Failed to fetch workflow documentation",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 })
  }
}
