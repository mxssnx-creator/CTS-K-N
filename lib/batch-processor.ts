/**
 * Batch Processor for Exchange Operations
 * Handles batch connection tests, multi-connection operations, and bulk status updates
 */

interface BatchTask<T = any> {
  id: string
  connectionId: string
  operation: "test" | "balance" | "capabilities" | "health-check"
  params?: T
  priority: number
  timestamp: number
}

interface BatchResult<T = any> {
  taskId: string
  connectionId: string
  success: boolean
  data?: T
  error?: string
  duration: number
  timestamp: number
}

export class BatchProcessor {
  private static instance: BatchProcessor
  private queue: BatchTask[] = []
  private processing = false
  private results: Map<string, BatchResult> = new Map()
  private maxConcurrentTasks = 10
  private activeTasks = 0

  private constructor() {}

  static getInstance(): BatchProcessor {
    if (!BatchProcessor.instance) {
      BatchProcessor.instance = new BatchProcessor()
    }
    return BatchProcessor.instance
  }

  /**
   * Add a batch task to the queue
   */
  enqueue<T = any>(task: Omit<BatchTask<T>, "timestamp">): string {
    const fullTask: BatchTask<T> = {
      ...task,
      timestamp: Date.now(),
    }

    this.queue.push(fullTask)
    this.queue.sort((a, b) => b.priority - a.priority) // Sort by priority (higher first)

    console.log(`[v0] Batch task enqueued: ${task.id} (queue size: ${this.queue.length})`)
    this.processBatch()

    return fullTask.id
  }

  /**
   * Enqueue multiple tasks at once
   */
  enqueueBatch<T = any>(tasks: Omit<BatchTask<T>, "timestamp">[]): string[] {
    return tasks.map((task) => this.enqueue(task))
  }

  /**
   * Process batch tasks with concurrency control
   */
  private async processBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return
    }

    this.processing = true

    try {
      while (this.queue.length > 0 && this.activeTasks < this.maxConcurrentTasks) {
        const task = this.queue.shift()
        if (!task) break

        this.activeTasks++

        // Process task without awaiting
        this.executeTask(task)
          .then((result) => {
            this.results.set(task.id, result)
            console.log(`[v0] Batch task completed: ${task.id} (success: ${result.success})`)
          })
          .catch((error) => {
            const result: BatchResult = {
              taskId: task.id,
              connectionId: task.connectionId,
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
              duration: Date.now() - task.timestamp,
              timestamp: Date.now(),
            }
            this.results.set(task.id, result)
            console.error(`[v0] Batch task failed: ${task.id}`, error)
          })
          .finally(() => {
            this.activeTasks--
            this.processBatch() // Continue processing
          })
      }
    } finally {
      this.processing = false
    }
  }

  /**
   * Execute a single batch task
   */
  private async executeTask(task: BatchTask): Promise<BatchResult> {
    const startTime = Date.now()

    try {
      let data: any

      switch (task.operation) {
        case "test": {
          // Test connection - will be implemented by caller
          data = { status: "test_complete" }
          break
        }
        case "balance": {
          // Get balance - will be implemented by caller
          data = { balance: 0 }
          break
        }
        case "capabilities": {
          // Get capabilities - will be implemented by caller
          data = { capabilities: [] }
          break
        }
        case "health-check": {
          // Health check - will be implemented by caller
          data = { healthy: true }
          break
        }
      }

      return {
        taskId: task.id,
        connectionId: task.connectionId,
        success: true,
        data,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      }
    } catch (error) {
      return {
        taskId: task.id,
        connectionId: task.connectionId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      }
    }
  }

  /**
   * Get result of a batch task
   */
  getResult(taskId: string): BatchResult | undefined {
    return this.results.get(taskId)
  }

  /**
   * Get all results
   */
  getAllResults(): BatchResult[] {
    return Array.from(this.results.values())
  }

  /**
   * Get queue status
   */
  getQueueStatus() {
    return {
      queueLength: this.queue.length,
      activeTasks: this.activeTasks,
      maxConcurrent: this.maxConcurrentTasks,
      completedTasks: this.results.size,
    }
  }

  /**
   * Clear old results (older than 1 hour)
   */
  clearOldResults(): number {
    const oneHourAgo = Date.now() - 3600000
    let cleared = 0

    for (const [taskId, result] of this.results.entries()) {
      if (result.timestamp < oneHourAgo) {
        this.results.delete(taskId)
        cleared++
      }
    }

    return cleared
  }
}

export type { BatchTask, BatchResult }
