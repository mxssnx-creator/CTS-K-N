'use client'

import { useEffect, useRef } from 'react'
import { getSystemVersionInfo, COMPONENT_VERSIONS, API_VERSIONS } from '@/lib/system-version'

let initializationPromise: Promise<void> | null = null
let hasInitialized = false

async function initializeSystem() {
  // Prevent multiple concurrent initializations
  if (initializationPromise) {
    return initializationPromise
  }
  if (hasInitialized) {
    return Promise.resolve()
  }

  initializationPromise = (async () => {
    try {
      const versionInfo = getSystemVersionInfo()
      
      // STEP 1: Run /api/init for general initialization
      const initResponse = await fetch('/api/init', { 
        method: 'GET',
        cache: 'no-store',
        headers: {
          'X-System-Version': versionInfo.system,
          'X-Component-Version': COMPONENT_VERSIONS.systemInitializer,
        },
      })
      
      await initResponse.json().catch(() => {})
      
      // STEP 2: Run comprehensive startup initialization
      const startupResponse = await fetch('/api/startup/initialize', {
        method: 'POST',
        cache: 'no-store',
        headers: { 
          'Content-Type': 'application/json',
          'X-System-Version': versionInfo.system,
          'X-API-Version': API_VERSIONS.tradeEngine,
        },
      })
      
      if (!startupResponse.ok) return

      const startupResult = await startupResponse.json()
      if (startupResult.success) {
        hasInitialized = true
      }
    } catch {
      // non-critical — system may already be initialized
    } finally {
      initializationPromise = null
    }
  })()

  return initializationPromise
}

export function SystemInitializer() {
  const hasTriedInit = useRef(false)

  useEffect(() => {
    if (hasTriedInit.current) return
    hasTriedInit.current = true

    // Initialize system immediately
    initializeSystem()
  }, [])

  return null
}
