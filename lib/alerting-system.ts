/**
 * Alerting System
 * 
 * Sends alerts to multiple channels (Slack, PagerDuty, Email, Webhooks)
 * Integrates with error handling and metrics collection
 */

export enum AlertSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical'
}

export enum AlertChannel {
  SLACK = 'slack',
  PAGERDUTY = 'pagerduty',
  EMAIL = 'email',
  WEBHOOK = 'webhook'
}

export interface Alert {
  id: string
  severity: AlertSeverity
  title: string
  message: string
  source: string
  timestamp: Date
  metadata?: { [key: string]: any }
}

export interface AlertConfig {
  channels: {
    slack?: {
      webhookUrl: string
      enabled: boolean
      mentionUsers?: string[]
    }
    pagerduty?: {
      integrationKey: string
      enabled: boolean
    }
    email?: {
      enabled: boolean
      recipients: string[]
      smtpConfig?: {
        host: string
        port: number
        user: string
        pass: string
      }
    }
    webhook?: {
      enabled: boolean
      url: string
      headers?: { [key: string]: string }
    }
  }
  minSeverity: AlertSeverity
  deduplication?: {
    enabled: boolean
    timeWindowMs: number
  }
}

/**
 * Alert Manager
 */
export class AlertManager {
  private config: AlertConfig
  private alertHistory: Alert[] = []
  private maxHistorySize = 1000
  private recentAlerts = new Map<string, Date>()

  constructor(config: Partial<AlertConfig> = {}) {
    this.config = {
      channels: config.channels || {},
      minSeverity: config.minSeverity || AlertSeverity.WARNING,
      deduplication: config.deduplication ?? {
        enabled: true,
        timeWindowMs: 60000 // 1 minute
      }
    }

    console.log('[ALERTING] Alert manager initialized')
  }

  /**
   * Send alert to all enabled channels
   */
  async sendAlert(
    title: string,
    message: string,
    options: {
      severity?: AlertSeverity
      source?: string
      metadata?: { [key: string]: any }
    } = {}
  ): Promise<void> {
    const {
      severity = AlertSeverity.WARNING,
      source = 'unknown',
      metadata
    } = options

    // Check if we should send this alert
    if (!this.shouldSendAlert(severity)) {
      console.log(
        `[ALERTING] Skipping alert (severity ${severity} below minimum ${this.config.minSeverity})`
      )
      return
    }

    // Check for duplicate
    const alertKey = `${source}:${title}`
    if (this.isDuplicate(alertKey)) {
      console.log(`[ALERTING] Skipping duplicate alert: ${alertKey}`)
      return
    }

    // Create alert
    const alert: Alert = {
      id: this.generateAlertId(),
      severity,
      title,
      message,
      source,
      timestamp: new Date(),
      metadata
    }

    // Store in history
    this.alertHistory.push(alert)
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.shift()
    }

    // Track recent alert
    this.recentAlerts.set(alertKey, new Date())

    // Send to channels
    const tasks: Promise<void>[] = []

    if (this.config.channels.slack?.enabled) {
      tasks.push(this.sendToSlack(alert).catch(err =>
        console.error('[ALERTING] Failed to send Slack alert:', err)
      ))
    }

    if (this.config.channels.pagerduty?.enabled) {
      tasks.push(this.sendToPagerDuty(alert).catch(err =>
        console.error('[ALERTING] Failed to send PagerDuty alert:', err)
      ))
    }

    if (this.config.channels.email?.enabled) {
      tasks.push(this.sendEmail(alert).catch(err =>
        console.error('[ALERTING] Failed to send email alert:', err)
      ))
    }

    if (this.config.channels.webhook?.enabled) {
      tasks.push(this.sendToWebhook(alert).catch(err =>
        console.error('[ALERTING] Failed to send webhook alert:', err)
      ))
    }

    await Promise.all(tasks)
    console.log(
      `[ALERTING] Alert sent: ${alert.id} - ${title} (${severity})`
    )
  }

  /**
   * Send alert to Slack
   */
  private async sendToSlack(alert: Alert): Promise<void> {
    const config = this.config.channels.slack
    if (!config?.webhookUrl) {
      throw new Error('Slack webhook URL not configured')
    }

    const color = this.getSeverityColor(alert.severity)
    const mentions = config.mentionUsers
      ? config.mentionUsers.map(u => `<@${u}>`).join(' ')
      : ''

    const payload = {
      attachments: [
        {
          color,
          title: alert.title,
          text: alert.message,
          fields: [
            {
              title: 'Severity',
              value: alert.severity.toUpperCase(),
              short: true
            },
            {
              title: 'Source',
              value: alert.source,
              short: true
            },
            {
              title: 'Time',
              value: alert.timestamp.toISOString(),
              short: false
            }
          ],
          footer: 'CTS Alert System'
        }
      ],
      text: mentions ? `${mentions} ${alert.title}` : alert.title
    }

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      throw new Error(`Slack API returned ${response.status}`)
    }
  }

  /**
   * Send alert to PagerDuty
   */
  private async sendToPagerDuty(alert: Alert): Promise<void> {
    const config = this.config.channels.pagerduty
    if (!config?.integrationKey) {
      throw new Error('PagerDuty integration key not configured')
    }

    const severity = this.mapSeverityToPagerDuty(alert.severity)

    const payload = {
      routing_key: config.integrationKey,
      event_action: 'trigger',
      dedup_key: alert.id,
      payload: {
        summary: alert.title,
        severity,
        source: alert.source,
        custom_details: {
          message: alert.message,
          timestamp: alert.timestamp.toISOString(),
          ...alert.metadata
        }
      }
    }

    const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      throw new Error(`PagerDuty API returned ${response.status}`)
    }
  }

  /**
   * Send email alert
   */
  private async sendEmail(alert: Alert): Promise<void> {
    const config = this.config.channels.email
    if (!config?.recipients || config.recipients.length === 0) {
      throw new Error('Email recipients not configured')
    }

    // For now, just log that email would be sent
    // In production, integrate with email service (SendGrid, SES, etc.)
    console.log(
      `[ALERTING] Would send email to ${config.recipients.join(', ')}: ${alert.title}`
    )
  }

  /**
   * Send to webhook
   */
  private async sendToWebhook(alert: Alert): Promise<void> {
    const config = this.config.channels.webhook
    if (!config?.url) {
      throw new Error('Webhook URL not configured')
    }

    const payload = {
      alert: {
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        source: alert.source,
        timestamp: alert.timestamp.toISOString(),
        metadata: alert.metadata
      }
    }

    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`)
    }
  }

  /**
   * Check if alert should be sent
   */
  private shouldSendAlert(severity: AlertSeverity): boolean {
    const severityOrder = [AlertSeverity.INFO, AlertSeverity.WARNING, AlertSeverity.ERROR, AlertSeverity.CRITICAL]
    const minOrder = severityOrder.indexOf(this.config.minSeverity)
    const currentOrder = severityOrder.indexOf(severity)

    return currentOrder >= minOrder
  }

  /**
   * Check for duplicate alert
   */
  private isDuplicate(key: string): boolean {
    if (!this.config.deduplication?.enabled) {
      return false
    }

    const lastTime = this.recentAlerts.get(key)
    if (!lastTime) {
      return false
    }

    const elapsed = Date.now() - lastTime.getTime()
    return elapsed < (this.config.deduplication.timeWindowMs || 60000)
  }

  /**
   * Generate alert ID
   */
  private generateAlertId(): string {
    return `alert-${Date.now()}-${Math.random().toString(36).substring(7)}`
  }

  /**
   * Map alert severity to Slack color
   */
  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.INFO:
        return '#36a64f'
      case AlertSeverity.WARNING:
        return '#ff9900'
      case AlertSeverity.ERROR:
        return '#ff6b6b'
      case AlertSeverity.CRITICAL:
        return '#8b0000'
      default:
        return '#808080'
    }
  }

  /**
   * Map alert severity to PagerDuty severity
   */
  private mapSeverityToPagerDuty(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.INFO:
        return 'info'
      case AlertSeverity.WARNING:
        return 'warning'
      case AlertSeverity.ERROR:
        return 'error'
      case AlertSeverity.CRITICAL:
        return 'critical'
      default:
        return 'error'
    }
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit: number = 50): Alert[] {
    return this.alertHistory.slice(-limit)
  }

  /**
   * Clear alert history
   */
  clearAlertHistory(): void {
    this.alertHistory = []
  }

  /**
   * Get alert statistics
   */
  getAlertStats(): {
    total: number
    bySource: { [source: string]: number }
    bySeverity: { [severity: string]: number }
  } {
    const stats = {
      total: this.alertHistory.length,
      bySource: {} as { [source: string]: number },
      bySeverity: {} as { [severity: string]: number }
    }

    for (const alert of this.alertHistory) {
      stats.bySource[alert.source] = (stats.bySource[alert.source] || 0) + 1
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1
    }

    return stats
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...config }
    console.log('[ALERTING] Alert manager configuration updated')
  }
}

// Export singleton instance
export const alertManager = new AlertManager()

export default AlertManager
