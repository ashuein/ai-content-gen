/**
 * Security Middleware
 * Comprehensive security layer with rate limiting, validation, and attack protection
 * Implements OWASP security best practices for API endpoints
 */

import { Request, Response, NextFunction } from 'express';
import { rateLimit, RateLimitRequestHandler } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../config/paths.js';

export interface SecurityConfig {
  // Rate limiting
  globalRateLimit: {
    windowMs: number;
    max: number;
    skipSuccessfulRequests: boolean;
  };

  // API key authentication
  apiKeys: {
    enabled: boolean;
    headerName: string;
    allowedKeys: string[];
    hashKeys: boolean;
  };

  // Request validation
  validation: {
    maxPayloadSize: number;
    allowedContentTypes: string[];
    maxHeaderSize: number;
    maxUrlLength: number;
  };

  // Security headers
  headers: {
    enableHSTS: boolean;
    enableCSP: boolean;
    enableFrameDeny: boolean;
    enableXSSProtection: boolean;
  };

  // Attack protection
  protection: {
    enableSQLInjectionDetection: boolean;
    enableXSSDetection: boolean;
    enablePathTraversalDetection: boolean;
    enableCommandInjectionDetection: boolean;
    blockedPatterns: RegExp[];
  };

  // IP filtering
  ipFiltering: {
    enabled: boolean;
    allowlist: string[];
    blocklist: string[];
  };

  // Logging and monitoring
  logging: {
    logFailedRequests: boolean;
    logSuspiciousActivity: boolean;
    maxLogSize: number;
  };
}

interface SecurityViolation {
  type: 'rate_limit' | 'invalid_auth' | 'malicious_payload' | 'blocked_ip' | 'invalid_request';
  severity: 'low' | 'medium' | 'high' | 'critical';
  ip: string;
  userAgent?: string;
  path: string;
  timestamp: number;
  details: string;
}

interface RateLimitInfo {
  ip: string;
  path: string;
  count: number;
  windowStart: number;
  lastRequest: number;
}

const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  globalRateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // requests per window
    skipSuccessfulRequests: false
  },

  apiKeys: {
    enabled: process.env.REQUIRE_API_KEY === 'true',
    headerName: 'X-API-Key',
    allowedKeys: process.env.API_KEYS?.split(',') || [],
    hashKeys: true
  },

  validation: {
    maxPayloadSize: 50 * 1024 * 1024, // 50MB
    allowedContentTypes: [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain'
    ],
    maxHeaderSize: 8192, // 8KB
    maxUrlLength: 2048
  },

  headers: {
    enableHSTS: true,
    enableCSP: true,
    enableFrameDeny: true,
    enableXSSProtection: true
  },

  protection: {
    enableSQLInjectionDetection: true,
    enableXSSDetection: true,
    enablePathTraversalDetection: true,
    enableCommandInjectionDetection: true,
    blockedPatterns: [
      // SQL injection patterns
      /(\bunion\b.*\bselect\b)|(\bselect\b.*\bunion\b)/i,
      /(\bdrop\b.*\btable\b)|(\btable\b.*\bdrop\b)/i,
      /(\binsert\b.*\binto\b)|(\binto\b.*\binsert\b)/i,

      // XSS patterns
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:[^"']*/gi,
      /on\w+\s*=\s*["'][^"']*["']/gi,

      // Path traversal
      /\.\.[\/\\]/,
      /\.(exe|dll|bat|cmd|sh)$/i,

      // Command injection
      /[;&|`$()]/,
      /\b(eval|exec|system|shell_exec)\b/i
    ]
  },

  ipFiltering: {
    enabled: false,
    allowlist: [],
    blocklist: []
  },

  logging: {
    logFailedRequests: true,
    logSuspiciousActivity: true,
    maxLogSize: 100 * 1024 * 1024 // 100MB
  }
};

/**
 * Main security middleware class
 */
export class SecurityMiddleware {
  private config: SecurityConfig;
  private violations: SecurityViolation[] = [];
  private rateLimitData: Map<string, RateLimitInfo> = new Map();
  private hashedApiKeys: Set<string> = new Set();

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config };
    this.initializeApiKeys();
  }

  /**
   * Initialize hashed API keys for secure comparison
   */
  private async initializeApiKeys(): Promise<void> {
    if (this.config.apiKeys.enabled && this.config.apiKeys.hashKeys) {
      for (const key of this.config.apiKeys.allowedKeys) {
        const hashedKey = createHash('sha256').update(key).digest('hex');
        this.hashedApiKeys.add(hashedKey);
      }
    }
  }

  /**
   * Main security middleware function
   */
  securityMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Check IP filtering first
        if (!this.checkIPFilter(req)) {
          this.logViolation({
            type: 'blocked_ip',
            severity: 'high',
            ip: this.getClientIP(req),
            path: req.path,
            timestamp: Date.now(),
            details: 'IP address blocked'
          });
          return res.status(403).json({ error: 'Access denied' });
        }

        // Validate request format
        const validationResult = this.validateRequest(req);
        if (!validationResult.valid) {
          this.logViolation({
            type: 'invalid_request',
            severity: 'medium',
            ip: this.getClientIP(req),
            path: req.path,
            timestamp: Date.now(),
            details: validationResult.reason || 'Invalid request format'
          });
          return res.status(400).json({ error: validationResult.reason });
        }

        // Check API key authentication
        if (this.config.apiKeys.enabled && !this.validateApiKey(req)) {
          this.logViolation({
            type: 'invalid_auth',
            severity: 'high',
            ip: this.getClientIP(req),
            path: req.path,
            timestamp: Date.now(),
            details: 'Invalid or missing API key'
          });
          return res.status(401).json({ error: 'Invalid API key' });
        }

        // Scan for malicious payloads
        const maliciousContent = this.scanForMaliciousContent(req);
        if (maliciousContent.detected) {
          this.logViolation({
            type: 'malicious_payload',
            severity: 'critical',
            ip: this.getClientIP(req),
            userAgent: req.get('User-Agent'),
            path: req.path,
            timestamp: Date.now(),
            details: `Malicious pattern detected: ${maliciousContent.pattern}`
          });
          return res.status(400).json({ error: 'Malicious content detected' });
        }

        // Set security headers
        this.setSecurityHeaders(res);

        next();
      } catch (error) {
        console.error('Security middleware error:', error);
        res.status(500).json({ error: 'Internal security error' });
      }
    };
  }

  /**
   * Create rate limiting middleware
   */
  createRateLimit(options?: Partial<SecurityConfig['globalRateLimit']>): RateLimitRequestHandler {
    const config = { ...this.config.globalRateLimit, ...options };

    return rateLimit({
      windowMs: config.windowMs,
      max: config.max,
      skipSuccessfulRequests: config.skipSuccessfulRequests,
      message: {
        error: 'Too many requests',
        retryAfter: Math.ceil(config.windowMs / 1000)
      },
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req: Request, res: Response) => {
        this.logViolation({
          type: 'rate_limit',
          severity: 'medium',
          ip: this.getClientIP(req),
          path: req.path,
          timestamp: Date.now(),
          details: 'Rate limit exceeded'
        });

        res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil(config.windowMs / 1000)
        });
      }
    });
  }

  /**
   * Validate request format and size
   */
  private validateRequest(req: Request): { valid: boolean; reason?: string } {
    // Check URL length
    if (req.url.length > this.config.validation.maxUrlLength) {
      return { valid: false, reason: 'URL too long' };
    }

    // Check content type for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('content-type');
      if (contentType && !this.config.validation.allowedContentTypes.some(allowed =>
        contentType.toLowerCase().includes(allowed)
      )) {
        return { valid: false, reason: 'Invalid content type' };
      }
    }

    // Check header size (approximate)
    const headerSize = JSON.stringify(req.headers).length;
    if (headerSize > this.config.validation.maxHeaderSize) {
      return { valid: false, reason: 'Headers too large' };
    }

    return { valid: true };
  }

  /**
   * Validate API key
   */
  private validateApiKey(req: Request): boolean {
    if (!this.config.apiKeys.enabled) {
      return true;
    }

    const apiKey = req.get(this.config.apiKeys.headerName);
    if (!apiKey) {
      return false;
    }

    if (this.config.apiKeys.hashKeys) {
      const hashedKey = createHash('sha256').update(apiKey).digest('hex');
      return this.hashedApiKeys.has(hashedKey);
    } else {
      return this.config.apiKeys.allowedKeys.includes(apiKey);
    }
  }

  /**
   * Scan request for malicious content
   */
  private scanForMaliciousContent(req: Request): { detected: boolean; pattern?: string } {
    const textToScan = [
      req.url,
      JSON.stringify(req.query),
      JSON.stringify(req.body),
      req.get('User-Agent') || '',
      req.get('Referer') || ''
    ].join(' ');

    for (const pattern of this.config.protection.blockedPatterns) {
      if (pattern.test(textToScan)) {
        return { detected: true, pattern: pattern.toString() };
      }
    }

    return { detected: false };
  }

  /**
   * Check IP filtering
   */
  private checkIPFilter(req: Request): boolean {
    if (!this.config.ipFiltering.enabled) {
      return true;
    }

    const clientIP = this.getClientIP(req);

    // Check blocklist first
    if (this.config.ipFiltering.blocklist.includes(clientIP)) {
      return false;
    }

    // If allowlist is configured, check it
    if (this.config.ipFiltering.allowlist.length > 0) {
      return this.config.ipFiltering.allowlist.includes(clientIP);
    }

    return true;
  }

  /**
   * Set security headers
   */
  private setSecurityHeaders(res: Response): void {
    if (this.config.headers.enableHSTS) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (this.config.headers.enableCSP) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    }

    if (this.config.headers.enableFrameDeny) {
      res.setHeader('X-Frame-Options', 'DENY');
    }

    if (this.config.headers.enableXSSProtection) {
      res.setHeader('X-XSS-Protection', '1; mode=block');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  }

  /**
   * Get client IP address
   */
  private getClientIP(req: Request): string {
    return (req.get('X-Forwarded-For') ||
            req.get('X-Real-IP') ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress ||
            'unknown').split(',')[0].trim();
  }

  /**
   * Log security violation
   */
  private logViolation(violation: SecurityViolation): void {
    this.violations.push(violation);

    // Keep only recent violations to prevent memory issues
    if (this.violations.length > 10000) {
      this.violations = this.violations.slice(-5000);
    }

    if (this.config.logging.logSuspiciousActivity) {
      console.warn('Security violation detected:', violation);
    }
  }

  /**
   * Get security statistics
   */
  getSecurityStats(): {
    totalViolations: number;
    violationsByType: Record<string, number>;
    violationsBySeverity: Record<string, number>;
    topOffendingIPs: Array<{ ip: string; count: number }>;
    recentViolations: SecurityViolation[];
  } {
    const violationsByType: Record<string, number> = {};
    const violationsBySeverity: Record<string, number> = {};
    const ipCounts: Record<string, number> = {};

    for (const violation of this.violations) {
      violationsByType[violation.type] = (violationsByType[violation.type] || 0) + 1;
      violationsBySeverity[violation.severity] = (violationsBySeverity[violation.severity] || 0) + 1;
      ipCounts[violation.ip] = (ipCounts[violation.ip] || 0) + 1;
    }

    const topOffendingIPs = Object.entries(ipCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, count }));

    const recentViolations = this.violations
      .slice(-50)
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      totalViolations: this.violations.length,
      violationsByType,
      violationsBySeverity,
      topOffendingIPs,
      recentViolations
    };
  }

  /**
   * Add IP to blocklist
   */
  blockIP(ip: string): void {
    if (!this.config.ipFiltering.blocklist.includes(ip)) {
      this.config.ipFiltering.blocklist.push(ip);
      this.config.ipFiltering.enabled = true;
    }
  }

  /**
   * Remove IP from blocklist
   */
  unblockIP(ip: string): void {
    const index = this.config.ipFiltering.blocklist.indexOf(ip);
    if (index > -1) {
      this.config.ipFiltering.blocklist.splice(index, 1);
    }
  }

  /**
   * Clear violation history
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Update security configuration
   */
  updateConfig(newConfig: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.apiKeys) {
      this.initializeApiKeys();
    }
  }
}

/**
 * Additional security utilities
 */
export class SecurityUtils {
  /**
   * Generate secure API key
   */
  static generateApiKey(length: number = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Hash API key for secure storage
   */
  static hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Safe string comparison to prevent timing attacks
   */
  static safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);

    return timingSafeEqual(bufferA, bufferB);
  }

  /**
   * Sanitize input string
   */
  static sanitizeInput(input: string): string {
    return input
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .replace(/['"]/g, '') // Remove quotes
      .replace(/[;&|`$()]/g, '') // Remove command injection chars
      .trim();
  }

  /**
   * Validate UUID format
   */
  static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }
}

// Export singleton instance
export const securityMiddleware = new SecurityMiddleware();