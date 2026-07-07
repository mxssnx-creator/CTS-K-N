'use client'

import { useState, useMemo } from 'react'
import { ChevronDown, Copy, Download, AlertTriangle, Info, CheckCircle2, XCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export interface ErrorLog {
  timestamp: string
  correlationId?: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'
  category: string
  message: string
  context?: Record<string, any>
  error?: {
    name: string
    message: string
    stack?: string
    code?: string
  }
  metrics?: {
    duration?: number
    memoryBefore?: number
    memoryAfter?: number
  }
}

interface ExpandableErrorPanelProps {
  logs: ErrorLog[]
  title?: string
  description?: string
  onRefresh?: () => Promise<void>
  filterByLevel?: string
}

const getLevelIcon = (level: string) => {
  switch (level) {
    case 'DEBUG':
      return <Info className="w-4 h-4 text-blue-500" />
    case 'INFO':
      return <Info className="w-4 h-4 text-green-500" />
    case 'WARN':
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />
    case 'ERROR':
      return <XCircle className="w-4 h-4 text-red-500" />
    case 'CRITICAL':
      return <XCircle className="w-4 h-4 text-red-700" />
    default:
      return <Info className="w-4 h-4" />
  }
}

const getLevelColor = (level: string) => {
  switch (level) {
    case 'DEBUG':
      return 'bg-blue-100 text-blue-800'
    case 'INFO':
      return 'bg-green-100 text-green-800'
    case 'WARN':
      return 'bg-yellow-100 text-yellow-800'
    case 'ERROR':
      return 'bg-red-100 text-red-800'
    case 'CRITICAL':
      return 'bg-red-200 text-red-900'
    default:
      return 'bg-gray-100 text-gray-800'
  }
}

export function ExpandableErrorPanel({
  logs,
  title = 'System Logs',
  description = 'Detailed logs with expandable details',
  onRefresh,
  filterByLevel
}: ExpandableErrorPanelProps) {
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set())
  const [filterLevel, setFilterLevel] = useState<string | null>(filterByLevel || null)
  const [searchTerm, setSearchTerm] = useState('')

  // Filter logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (filterLevel && log.level !== filterLevel) return false
      if (searchTerm && !log.message.toLowerCase().includes(searchTerm.toLowerCase())) return false
      return true
    })
  }, [logs, filterLevel, searchTerm])

  const toggleExpand = (index: number) => {
    const newExpanded = new Set(expandedLogs)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedLogs(newExpanded)
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const downloadLogs = () => {
    const json = JSON.stringify(filteredLogs, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `logs-${new Date().toISOString()}.json`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex gap-2">
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh}>
                Refresh
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={downloadLogs}>
              <Download className="w-4 h-4 mr-2" />
              Export
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-1">
            {['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'].map(level => (
              <Button
                key={level}
                variant={filterLevel === level ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilterLevel(filterLevel === level ? null : level)}
                className="text-xs"
              >
                {level}
              </Button>
            ))}
          </div>
        </div>

        {/* Log Count */}
        <div className="text-sm text-gray-500">
          Showing {filteredLogs.length} of {logs.length} logs
        </div>

        {/* Logs List */}
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {filteredLogs.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No logs found
            </div>
          ) : (
            filteredLogs.map((log, index) => (
              <div
                key={index}
                className="border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
              >
                {/* Log Header - Always Visible */}
                <button
                  onClick={() => toggleExpand(index)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {getLevelIcon(log.level)}
                    <Badge className={getLevelColor(log.level)}>
                      {log.level}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate text-left">{log.message}</p>
                      <p className="text-xs text-gray-500">
                        {log.timestamp} {log.correlationId && `(${log.correlationId})`}
                      </p>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform flex-shrink-0 ${
                      expandedLogs.has(index) ? 'transform rotate-180' : ''
                    }`}
                  />
                </button>

                {/* Expanded Details */}
                {expandedLogs.has(index) && (
                  <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 space-y-3">
                    {/* Category & Correlation */}
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-gray-500 font-medium">Category:</span>
                        <p className="text-gray-900">{log.category}</p>
                      </div>
                      {log.correlationId && (
                        <div>
                          <span className="text-gray-500 font-medium">Correlation ID:</span>
                          <div className="flex items-center gap-2">
                            <p className="text-gray-900 font-mono text-xs truncate">
                              {log.correlationId}
                            </p>
                            <button
                              onClick={() => copyToClipboard(log.correlationId!)}
                              className="text-gray-400 hover:text-gray-600"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Context */}
                    {log.context && Object.keys(log.context).length > 0 && (
                      <div>
                        <span className="text-gray-500 font-medium text-sm">Context:</span>
                        <pre className="text-xs bg-white border border-gray-200 rounded p-2 overflow-x-auto mt-1">
                          {JSON.stringify(log.context, null, 2)}
                        </pre>
                      </div>
                    )}

                    {/* Error Details */}
                    {log.error && (
                      <div className="bg-red-50 border border-red-200 rounded p-3">
                        <span className="text-red-700 font-medium text-sm">Error Details:</span>
                        <div className="mt-2 space-y-1 text-sm">
                          <p>
                            <span className="text-gray-500 font-medium">Name:</span>{' '}
                            <span className="text-gray-900">{log.error.name}</span>
                          </p>
                          <p>
                            <span className="text-gray-500 font-medium">Message:</span>{' '}
                            <span className="text-gray-900">{log.error.message}</span>
                          </p>
                          {log.error.code && (
                            <p>
                              <span className="text-gray-500 font-medium">Code:</span>{' '}
                              <span className="text-gray-900">{log.error.code}</span>
                            </p>
                          )}
                          {log.error.stack && (
                            <details>
                              <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                                Stack Trace
                              </summary>
                              <pre className="text-xs bg-white border border-gray-200 rounded p-2 overflow-x-auto mt-1">
                                {log.error.stack}
                              </pre>
                            </details>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Metrics */}
                    {log.metrics && Object.keys(log.metrics).length > 0 && (
                      <div className="bg-blue-50 border border-blue-200 rounded p-3">
                        <span className="text-blue-700 font-medium text-sm">Metrics:</span>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                          {log.metrics.duration !== undefined && (
                            <p>
                              <span className="text-gray-500 font-medium">Duration:</span>{' '}
                              <span className="text-gray-900">{log.metrics.duration}ms</span>
                            </p>
                          )}
                          {log.metrics.memoryBefore !== undefined && (
                            <p>
                              <span className="text-gray-500 font-medium">Memory Before:</span>{' '}
                              <span className="text-gray-900">
                                {(log.metrics.memoryBefore / 1024 / 1024).toFixed(2)}MB
                              </span>
                            </p>
                          )}
                          {log.metrics.memoryAfter !== undefined && (
                            <p>
                              <span className="text-gray-500 font-medium">Memory After:</span>{' '}
                              <span className="text-gray-900">
                                {(log.metrics.memoryAfter / 1024 / 1024).toFixed(2)}MB
                              </span>
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Copy JSON */}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(JSON.stringify(log, null, 2))}
                        className="w-full"
                      >
                        <Copy className="w-3 h-3 mr-2" />
                        Copy JSON
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
