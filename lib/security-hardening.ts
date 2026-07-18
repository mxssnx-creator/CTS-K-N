/**
 * Security Hardening
 * 
 * Implements security best practices and OWASP protections
 * Input validation, rate limiting, encryption, audit logging
 */

import { metricsCollector, MetricType } from './metrics-collector'
// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from 'crypto'

export interface SecurityConfig {
  enableValidation: boolean
  enableRateLimit: boolean
  enableEncryption: boolean
  enableAuditLog: boolean
  allowedOrigins: string[]
  maxPayloadSize: number
}

export interface SecurityEvent {
  type: 'access' | 'modification' | 'error' | 'alert'
  timestamp: Date
  userId?: string
  action: string
  resource: string
  status: 'success' | 'failure'
  details?: any
}

function resolveEncryptionSecret(explicit?: string): string {
  const secret = String(explicit || process.env.ENCRYPTION_KEY || "").trim()
  if (secret.length >= 16 && !/^(?:replace|change|your)[_-]?/i.test(secret)) return secret
  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY must contain at least 16 non-placeholder characters in production")
  }
  return "cts-k-n-development-only-encryption-key"
}

function encryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest()
}

/**
 * Security Manager
 */
export class SecurityManager {
  private config: SecurityConfig
  private auditLog: SecurityEvent[] = []
  private maxAuditSize = 10000
  private suspiciousActivity = new Map<string, number>()

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = {
      enableValidation: config.enableValidation ?? true,
      enableRateLimit: config.enableRateLimit ?? true,
      enableEncryption: config.enableEncryption ?? true,
      enableAuditLog: config.enableAuditLog ?? true,
      allowedOrigins: config.allowedOrigins ?? ['localhost', 'localhost:3000', 'localhost:3001', 'localhost:3002'],
      maxPayloadSize: config.maxPayloadSize ?? 1048576 // 1MB
    }

    this.registerMetrics()
    console.log('[SECURITY] Security manager initialized')
  }

  /**
   * Register security metrics
   */
  private registerMetrics(): void {
    metricsCollector.registerMetric({
      name: 'security_validation_failures',
      type: MetricType.COUNTER,
      help: 'Input validation failures'
    })

    metricsCollector.registerMetric({
      name: 'security_suspicious_activity',
      type: MetricType.COUNTER,
      help: 'Suspicious activity detected'
    })

    metricsCollector.registerMetric({
      name: 'security_audit_events',
      type: MetricType.COUNTER,
      help: 'Audit log events'
    })

    metricsCollector.registerMetric({
      name: 'security_failed_authentications',
      type: MetricType.COUNTER,
      help: 'Failed authentication attempts'
    })
  }

  /**
   * Validate input
   */
  validateInput(input: any, rules: {
    type?: string
    required?: boolean
    minLength?: number
    maxLength?: number
    pattern?: RegExp
    whitelist?: any[]
  }): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!this.config.enableValidation) {
      return { valid: true, errors: [] }
    }

    // Required check
    if (rules.required && (input === null || input === undefined || input === '')) {
      errors.push('Field is required')
    }

    if (input === null || input === undefined) {
      return { valid: errors.length === 0, errors }
    }

    // Type check
    if (rules.type) {
      if (typeof input !== rules.type) {
        errors.push(`Expected type ${rules.type}, got ${typeof input}`)
      }
    }

    // String validations
    if (typeof input === 'string') {
      if (rules.minLength && input.length < rules.minLength) {
        errors.push(`Minimum length is ${rules.minLength}`)
      }
      if (rules.maxLength && input.length > rules.maxLength) {
        errors.push(`Maximum length is ${rules.maxLength}`)
      }
      if (rules.pattern && !rules.pattern.test(input)) {
        errors.push(`Input does not match pattern`)
      }
    }

    // Whitelist check
    if (rules.whitelist && !rules.whitelist.includes(input)) {
      errors.push(`Value not in whitelist`)
    }

    if (errors.length > 0) {
      metricsCollector.incrementCounter('security_validation_failures', 1)
      this.logSecurityEvent({
        type: 'alert',
        action: 'validation_failure',
        resource: 'input',
        status: 'failure',
        details: { errors }
      })
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * Sanitize input
   */
  sanitizeInput(input: string): string {
    if (typeof input !== 'string') {
      return String(input)
    }

    // Remove potentially dangerous characters
    return input
      .replace(/[<>\"']/g, '') // Remove script tags and quotes
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .trim()
  }

  /**
   * Encrypt data
   */
  encryptData(data: string, key?: string): string {
    if (!this.config.enableEncryption) {
      return data
    }

    const secret = resolveEncryptionSecret(key)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv)
    const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()])
    return `v2:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`
  }

  /**
   * Decrypt data
   */
  decryptData(encrypted: string, key?: string): string {
    if (!this.config.enableEncryption) {
      return encrypted
    }

    const secret = resolveEncryptionSecret(key)
    const parts = encrypted.split(":")
    if (parts[0] === "v2" && parts.length === 4) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(parts[1], "hex"))
      decipher.setAuthTag(Buffer.from(parts[2], "hex"))
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], "hex")),
        decipher.final(),
      ]).toString("utf8")
    }

    // Read compatibility for values emitted by the legacy AES-CBC format.
    // Legacy encryption only succeeded for secrets whose padded UTF-8 value
    // was exactly 32 bytes; new writes always use authenticated v2/GCM.
    if (parts.length !== 2) throw new Error("Encrypted payload format is invalid")
    const legacyKey = Buffer.from(secret.padEnd(32).slice(0, 32), "utf8")
    if (legacyKey.length !== 32) throw new Error("Legacy encryption key is invalid")
    const decipher = crypto.createDecipheriv("aes-256-cbc", legacyKey, Buffer.from(parts[0], "hex"))
    return decipher.update(parts[1], "hex", "utf8") + decipher.final("utf8")
  }

  /**
   * Hash password
   */
  hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex')
  }

  /**
   * Verify password
   */
  verifyPassword(password: string, hash: string): boolean {
    return this.hashPassword(password) === hash
  }

  /**
   * Check origin
   */
  isOriginAllowed(origin: string): boolean {
    return this.config.allowedOrigins.includes(origin)
  }

  /**
   * Detect suspicious activity
   */
  checkSuspiciousActivity(identifier: string, threshold: number = 5): boolean {
    const count = (this.suspiciousActivity.get(identifier) || 0) + 1
    this.suspiciousActivity.set(identifier, count)

    if (count > threshold) {
      metricsCollector.incrementCounter('security_suspicious_activity', 1)
      this.logSecurityEvent({
        type: 'alert',
        action: 'suspicious_activity_detected',
        resource: identifier,
        status: 'failure',
        details: { count }
      })
      return true
    }

    return false
  }

  /**
   * Reset suspicious activity counter
   */
  resetSuspiciousActivity(identifier: string): void {
    this.suspiciousActivity.delete(identifier)
  }

  /**
   * Log security event
   */
  logSecurityEvent(event: Omit<SecurityEvent, 'timestamp'>): void {
    if (!this.config.enableAuditLog) {
      return
    }

    const securityEvent: SecurityEvent = {
      ...event,
      timestamp: new Date()
    }

    this.auditLog.push(securityEvent)
    if (this.auditLog.length > this.maxAuditSize) {
      this.auditLog.shift()
    }

    metricsCollector.incrementCounter('security_audit_events', 1, { type: event.type })

    // Log to console for critical events
    if (event.type === 'alert' || event.status === 'failure') {
      console.warn(`[SECURITY] ${event.type.toUpperCase()}: ${event.action} on ${event.resource}`)
    }
  }

  /**
   * Get audit log
   */
  getAuditLog(limit: number = 100): SecurityEvent[] {
    return this.auditLog.slice(-limit)
  }

  /**
   * Analyze security trends
   */
  analyzeTrends(windowMinutes: number = 60): {
    validationFailures: number
    suspiciousActivities: number
    failedAuthentications: number
    securityScore: number
  } {
    const cutoff = Date.now() - (windowMinutes * 60 * 1000)

    const recentEvents = this.auditLog.filter(e => e.timestamp.getTime() > cutoff)

    const validationFailures = recentEvents.filter(e => e.action === 'validation_failure').length
    const suspiciousActivities = recentEvents.filter(e => e.action === 'suspicious_activity_detected').length
    const failedAuthentications = recentEvents.filter(e => e.action === 'failed_authentication').length

    // Calculate security score (0-100)
    const score = Math.max(0, 100 - (validationFailures + suspiciousActivities * 2 + failedAuthentications * 3))

    return {
      validationFailures,
      suspiciousActivities,
      failedAuthentications,
      securityScore: score
    }
  }

  /**
   * Export security report
   */
  exportReport(): {
    config: SecurityConfig
    auditLog: SecurityEvent[]
    trends: any
    recommendations: string[]
  } {
    const trends = this.analyzeTrends()
    const recommendations: string[] = []

    if (trends.securityScore < 80) {
      recommendations.push('Review recent suspicious activities')
    }

    if (trends.failedAuthentications > 10) {
      recommendations.push('Check for brute force attacks')
    }

    if (trends.validationFailures > 20) {
      recommendations.push('Validate input validation rules')
    }

    return {
      config: this.config,
      auditLog: this.getAuditLog(50),
      trends,
      recommendations
    }
  }
}

// Export singleton
export const securityManager = new SecurityManager()

export default SecurityManager
