'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react'

interface WorkflowStep {
  id: number
  title: string
  description: string
  status: 'pending' | 'current' | 'complete'
  action?: {
    label: string
    onClick: () => void
    href?: string
  }
}

export function WorkflowOnboarding() {
  const [steps, setSteps] = useState<WorkflowStep[]>([
    {
      id: 1,
      title: 'Add API Credentials',
      description: 'Go to Settings → Connections → Select an exchange (BingX, Bybit, Binance, OKX) → Click Edit → Enter your API key and secret',
      status: 'current',
      action: {
        label: 'Go to Settings',
        href: '/settings?tab=connections',
        onClick: () => {}, // Navigation handled via href
      }
    },
    {
      id: 2,
      title: 'Add to Main Panel',
      description: 'Return to Dashboard → Click "Add Connection" → Select your connection → It will appear in the Main Connections (Active Connections) panel',
      status: 'pending',
    },
    {
      id: 3,
      title: 'Enable Processing',
      description: 'In the Main Connections panel, toggle the Enable switch → The engine will start processing market data and indicators',
      status: 'pending',
    },
    {
      id: 4,
      title: 'Monitor Progress',
      description: 'Watch the progression indicators and view engine status in the System Monitor → Check logs in the Progression panel',
      status: 'pending',
    },
  ])

  const [systemStatus, setSystemStatus] = useState({
    connectionsWithCredentials: 0,
    activeConnections: 0,
    dashboardEnabled: 0,
  })

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/system/demo-setup')
        const data = await res.json()
        setSystemStatus({
          connectionsWithCredentials: data.connectionsWithCredentials || 0,
          activeConnections: data.readyForProcessing || 0,
          dashboardEnabled: 0, // Can add this to status endpoint
        })

        // Update steps based on status
        const newSteps = [...steps]
        if (data.connectionsWithCredentials > 0) {
          newSteps[0].status = 'complete'
          newSteps[1].status = 'current'
        }
        if (data.readyForProcessing > 0) {
          newSteps[1].status = 'complete'
          newSteps[2].status = 'current'
        }
        setSteps(newSteps)
      } catch { /* non-critical */ }
    }

    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <Card className="p-6 border-l-4 border-l-blue-500 bg-blue-50">
      <div className="space-y-4">
        {/* Header */}
        <div>
          <h3 className="text-lg font-semibold text-blue-900">Setup Workflow</h3>
          <p className="text-sm text-blue-700 mt-1">
            Follow these steps to enable the trading engine
          </p>
        </div>

        {/* Current Status Summary */}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="bg-white rounded p-2">
            <div className="text-xs text-gray-600">With Credentials</div>
            <div className="text-lg font-semibold text-gray-900">{systemStatus.connectionsWithCredentials}</div>
          </div>
          <div className="bg-white rounded p-2">
            <div className="text-xs text-gray-600">In Active Panel</div>
            <div className="text-lg font-semibold text-gray-900">{systemStatus.activeConnections}</div>
          </div>
          <div className="bg-white rounded p-2">
            <div className="text-xs text-gray-600">Engine Ready</div>
            <div className="text-lg font-semibold text-gray-900">{systemStatus.dashboardEnabled}</div>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-3">
          {steps.map((step, index) => (
            <div key={step.id} className="flex gap-3">
              {/* Step Indicator */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                    step.status === 'complete'
                      ? 'bg-green-500 text-white'
                      : step.status === 'current'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-300 text-gray-600'
                  }`}
                >
                  {step.status === 'complete' ? <CheckCircle2 size={16} /> : step.id}
                </div>
                {index < steps.length - 1 && (
                  <div className="w-0.5 h-8 bg-gray-300 my-1" />
                )}
              </div>

              {/* Step Content */}
              <div className="flex-1 pb-4">
                <p className="font-medium text-gray-900">{step.title}</p>
                <p className="text-sm text-gray-600 mt-1">{step.description}</p>
                {step.action && (
                  <a href={step.action.href || '#'} onClick={step.action.onClick}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 text-xs"
                    >
                      {step.action.label}
                      <ArrowRight size={12} className="ml-1" />
                    </Button>
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Help Section */}
        <div className="bg-white rounded p-3 border border-blue-200">
          <div className="flex gap-2 text-sm">
            <AlertCircle size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-blue-900">Need help?</p>
              <p className="text-blue-700 text-xs mt-1">
                All connections start with empty API credentials. You must add your real exchange API keys in Settings before the engine can trade.
                Demo endpoint available at <code className="bg-blue-100 px-1 rounded">/api/system/demo-setup</code>
              </p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
