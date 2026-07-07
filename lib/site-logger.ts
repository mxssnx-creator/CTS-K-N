"use client"

export class SiteLogger {
  private static isInitialized = false

  private static async log(level: string, category: string, message: string, details?: any) {
    if (typeof window === "undefined") return

    try {
      // Store logs locally for download functionality
      const logData = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        level,
        category,
        message,
        details: details ? JSON.stringify(details, null, 2) : undefined,
        stack: details?.stack,
        url: window.location.href,
        userAgent: navigator.userAgent,
      }

      // Store in localStorage for download
      const storedLogs = localStorage.getItem("site_logs")
      const logs = storedLogs ? JSON.parse(storedLogs) : []
      logs.push(logData)
      
      // Keep only last 1000 logs
      if (logs.length > 1000) {
        logs.shift()
      }
      
      localStorage.setItem("site_logs", JSON.stringify(logs))

      // Log to console
      if (process.env.NODE_ENV === "development") {
        console.log(`[Site ${level.toUpperCase()}]`, message, details)
      }
    } catch (error) {
      // Silently fail to prevent blocking
    }
  }

  static info(category: string, message: string, details?: any) {
    return this.log("info", category, message, details)
  }

  static warning(category: string, message: string, details?: any) {
    return this.log("warning", category, message, details)
  }

  static error(category: string, message: string, details?: any) {
    return this.log("error", category, message, details)
  }

  static debug(category: string, message: string, details?: any) {
    return this.log("debug", category, message, details)
  }

  static initialize() {
    if (this.isInitialized || typeof window === "undefined") return
    this.isInitialized = true

    try {
      console.log("[v0] SiteLogger initializing...")

      this.info("System", "Site logger initialized", {
        path: window.location.pathname,
        userAgent: navigator.userAgent,
      })

      // Log page load
      this.info("Navigation", "Page loaded", {
        path: window.location.pathname,
        referrer: document.referrer,
      })

      // Global error handler
      window.addEventListener("error", (event) => {
        this.error("Global", event.message, {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack,
        })
      })

      // Unhandled promise rejections
      window.addEventListener("unhandledrejection", (event) => {
        this.error("Promise", "Unhandled promise rejection", {
          reason: event.reason,
          stack: event.reason?.stack,
        })
      })

      // Navigation tracking
      const originalPushState = history.pushState
      const originalReplaceState = history.replaceState

      history.pushState = function (...args) {
        originalPushState.apply(this, args)
        SiteLogger.info("Navigation", "Route changed (pushState)", {
          url: window.location.href,
        })
      }

      history.replaceState = function (...args) {
        originalReplaceState.apply(this, args)
        SiteLogger.info("Navigation", "Route changed (replaceState)", {
          url: window.location.href,
        })
      }

      window.addEventListener("popstate", () => {
        this.info("Navigation", "Route changed (popstate)", {
          url: window.location.href,
        })
      })

      // Performance monitoring
      if (window.performance && window.performance.timing) {
        window.addEventListener("load", () => {
          setTimeout(() => {
            const timing = window.performance.timing
            const loadTime = timing.loadEventEnd - timing.navigationStart
            this.info("Performance", "Page load complete", {
              loadTime: `${loadTime}ms`,
              domReady: `${timing.domContentLoadedEventEnd - timing.navigationStart}ms`,
            })
          }, 0)
        })
      }

      // Log visibility changes
      document.addEventListener("visibilitychange", () => {
        this.info("User", `Page ${document.hidden ? "hidden" : "visible"}`, {
          hidden: document.hidden,
        })
      })

      // Log when user leaves page
      window.addEventListener("beforeunload", () => {
        this.info("Navigation", "Page unload", {
          path: window.location.pathname,
        })
      })
    } catch (error) {
      // Silently fail to prevent blocking the app
      console.error("Failed to initialize SiteLogger:", error)
    }
  }
}

// Initialize will be called from SiteLoggerProvider component instead
