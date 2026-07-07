"use client"

import { useEffect } from "react"
import { SiteLogger } from "@/lib/site-logger"

export function useSiteLogger(componentName: string) {
  useEffect(() => {
    SiteLogger.info("Component", `${componentName} mounted`, {
      path: window.location.pathname,
    })

    return () => {
      SiteLogger.debug("Component", `${componentName} unmounted`, {
        path: window.location.pathname,
      })
    }
  }, [componentName])

  return {
    logInfo: (message: string, details?: any) => {
      SiteLogger.info(componentName, message, details)
    },
    logWarning: (message: string, details?: any) => {
      SiteLogger.warning(componentName, message, details)
    },
    logError: (message: string, details?: any) => {
      SiteLogger.error(componentName, message, details)
    },
    logDebug: (message: string, details?: any) => {
      SiteLogger.debug(componentName, message, details)
    },
  }
}
