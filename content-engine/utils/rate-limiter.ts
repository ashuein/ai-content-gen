/**
 * Rate Limiting and Backoff Infrastructure
 *
 * Implements production-ready rate limiting for LLM API calls with:
 * - Per-correlation-ID queuing
 * - Exponential backoff with jitter
 * - Circuit breaker pattern
 * - Metrics collection
 * - Graceful degradation
 */

import { EventEmitter } from 'events';

/**
 * Rate limiting configuration
 */
export interface RateLimiterConfig {
  // Queue configuration
  maxConcurrentRequests: number;    // Max parallel requests
  queueTimeout: number;             // Max time to wait in queue (ms)

  // Retry configuration
  maxRetries: number;               // Max retry attempts
  baseDelay: number;                // Base delay between retries (ms)
  maxDelay: number;                 // Maximum delay (ms)
  backoffMultiplier: number;        // Exponential backoff multiplier
  jitterFactor: number;             // Random jitter (0-1)

  // Circuit breaker configuration
  failureThreshold: number;         // Failures before circuit opens
  recoveryTimeout: number;          // Time before attempting recovery (ms)
  successThreshold: number;         // Successes needed to close circuit

  // Rate limiting
  requestsPerMinute: number;        // Max requests per minute per correlation ID
  burstLimit: number;               // Max burst requests

  // Monitoring
  enableMetrics: boolean;           // Enable metrics collection
  enableLogging: boolean;           // Enable detailed logging
}

/**
 * Default configuration optimized for OpenAI API
 */
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxConcurrentRequests: 4,
  queueTimeout: 180000, // 3 minutes to allow long generations to queue

  maxRetries: 4,
  baseDelay: 1500,     // 1.5 seconds
  maxDelay: 60000,     // 60 seconds
  backoffMultiplier: 2,
  jitterFactor: 0.1,

  failureThreshold: 8,
  recoveryTimeout: 120000, // 2 minutes
  successThreshold: 2,

  requestsPerMinute: 30,
  burstLimit: 8,

  enableMetrics: true,
  enableLogging: false
};

/**
 * Request context for tracking
 */
export interface RequestContext {
  correlationId: string;
  operation: string;
  timestamp: number;
  attempt: number;
  metadata?: Record<string, any>;
}

/**
 * Rate limiter metrics
 */
export interface RateLimiterMetrics {
  requests_total: number;
  requests_successful: number;
  requests_failed: number;
  requests_retried: number;
  requests_queued: number;
  requests_circuit_broken: number;

  queue_size_current: number;
  queue_time_avg_ms: number;

  circuit_state: 'closed' | 'half-open' | 'open';
  circuit_failures: number;
  circuit_successes: number;

  processing_time_avg_ms: number;
  last_error?: string;
  last_success?: number;
}

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = 'closed',       // Normal operation
  HALF_OPEN = 'half-open', // Testing recovery
  OPEN = 'open'           // Failing fast
}

/**
 * Request queue item
 */
interface QueueItem {
  context: RequestContext;
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  queuedAt: number;
}

/**
 * Token bucket for rate limiting
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillRate: number // tokens per second
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(count: number = 1): boolean {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }

    return false;
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    const tokensToAdd = timePassed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  getTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/**
 * Main rate limiter class
 */
export class LLMRateLimiter extends EventEmitter {
  private config: RateLimiterConfig;
  private logger?: (level: string, message: string, data?: any) => void;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private circuitFailures: number = 0;
  private circuitSuccesses: number = 0;
  private circuitOpenedAt: number = 0;

  // Request queues per correlation ID
  private queues: Map<string, QueueItem[]> = new Map();
  private activeRequests: Map<string, number> = new Map();

  // Rate limiting buckets per correlation ID
  private buckets: Map<string, TokenBucket> = new Map();

  // Metrics
  private metrics: RateLimiterMetrics;
  private processingTimes: number[] = [];
  private queueTimes: number[] = [];

  constructor(config: Partial<RateLimiterConfig> = {}, logger?: (level: string, message: string, data?: any) => void) {
    super();
    this.config = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config };
    this.logger = logger;

    this.metrics = {
      requests_total: 0,
      requests_successful: 0,
      requests_failed: 0,
      requests_retried: 0,
      requests_queued: 0,
      requests_circuit_broken: 0,
      queue_size_current: 0,
      queue_time_avg_ms: 0,
      circuit_state: this.circuitState,
      circuit_failures: this.circuitFailures,
      circuit_successes: this.circuitSuccesses,
      processing_time_avg_ms: 0
    };

    // Clean up old buckets periodically
    setInterval(() => this.cleanupBuckets(), 300000); // 5 minutes
  }

  /**
   * Execute a function with rate limiting and retry logic
   */
  async execute<T>(
    context: RequestContext,
    fn: () => Promise<T>
  ): Promise<T> {
    this.metrics.requests_total++;

    // Circuit breaker check
    if (this.isCircuitOpen()) {
      this.metrics.requests_circuit_broken++;
      const error = new Error('Circuit breaker is open - service is temporarily unavailable');
      this.emit('circuit_broken', { context, error });
      throw error;
    }

    // Get or create token bucket for this correlation ID
    const bucket = this.getBucket(context.correlationId);

    // Check rate limit
    if (!bucket.tryConsume()) {
      this.metrics.requests_failed++;
      const error = new Error('Rate limit exceeded for correlation ID');
      this.emit('rate_limited', { context, error });
      throw error;
    }

    // Add to queue
    return this.enqueue(context, fn);
  }

  /**
   * Add request to queue for processing
   */
  private async enqueue<T>(
    context: RequestContext,
    fn: () => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const queueItem: QueueItem = {
        context,
        execute: fn,
        resolve,
        reject,
        queuedAt: Date.now()
      };

      // Get or create queue for correlation ID
      if (!this.queues.has(context.correlationId)) {
        this.queues.set(context.correlationId, []);
      }

      const queue = this.queues.get(context.correlationId)!;
      queue.push(queueItem);

      this.metrics.requests_queued++;
      this.metrics.queue_size_current = this.getTotalQueueSize();

      this.emit('queued', { context, queueSize: queue.length });

      // Process queue
      this.processQueue(context.correlationId);

      // Set timeout for queue
      setTimeout(() => {
        const index = queue.indexOf(queueItem);
        if (index > -1) {
          queue.splice(index, 1);
          this.metrics.queue_size_current = this.getTotalQueueSize();
          reject(new Error('Queue timeout exceeded'));
        }
      }, this.config.queueTimeout);
    });
  }

  /**
   * Process requests in queue for a specific correlation ID
   */
  private async processQueue(correlationId: string): Promise<void> {
    const queue = this.queues.get(correlationId);
    if (!queue || queue.length === 0) return;

    const activeCount = this.activeRequests.get(correlationId) || 0;
    if (activeCount >= this.config.maxConcurrentRequests) return;

    const queueItem = queue.shift();
    if (!queueItem) return;

    this.metrics.queue_size_current = this.getTotalQueueSize();

    // Track active request
    this.activeRequests.set(correlationId, activeCount + 1);

    // Calculate queue time
    const queueTime = Date.now() - queueItem.queuedAt;
    this.queueTimes.push(queueTime);
    if (this.queueTimes.length > 100) {
      this.queueTimes = this.queueTimes.slice(-50);
    }
    this.metrics.queue_time_avg_ms = this.queueTimes.reduce((a, b) => a + b, 0) / this.queueTimes.length;

    try {
      const startTime = Date.now();
      const result = await this.executeWithRetry(queueItem.context, queueItem.execute);
      const processingTime = Date.now() - startTime;

      // Update metrics
      this.processingTimes.push(processingTime);
      if (this.processingTimes.length > 100) {
        this.processingTimes = this.processingTimes.slice(-50);
      }
      this.metrics.processing_time_avg_ms = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
      this.metrics.requests_successful++;
      this.metrics.last_success = Date.now();

      // Circuit breaker success
      this.recordSuccess();

      queueItem.resolve(result);

      this.emit('completed', { context: queueItem.context, processingTime });

    } catch (error) {
      this.metrics.requests_failed++;
      this.metrics.last_error = error instanceof Error ? error.message : String(error);

      // Circuit breaker failure
      this.recordFailure();

      queueItem.reject(error);

      this.emit('failed', { context: queueItem.context, error });
    } finally {
      // Reduce active count
      const newActiveCount = Math.max(0, (this.activeRequests.get(correlationId) || 0) - 1);
      this.activeRequests.set(correlationId, newActiveCount);

      // Process next item in queue
      setTimeout(() => this.processQueue(correlationId), 10);
    }
  }

  /**
   * Execute function with retry logic
   */
  private async executeWithRetry<T>(
    context: RequestContext,
    fn: () => Promise<T>
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        context.attempt = attempt + 1;
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries && this.isRetryableError(lastError)) {
          this.metrics.requests_retried++;

          const delay = this.calculateDelay(attempt);
          this.emit('retry', { context, attempt, delay, error: lastError });

          if (this.config.enableLogging) {
            this.logger?.('warn', 'Retrying request after error', {
              correlationId: context.correlationId,
              attempt: attempt + 1,
              delay,
              error: lastError.message
            });
          }

          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    throw lastError!;
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelay * Math.pow(this.config.backoffMultiplier, attempt);
    const jitter = exponentialDelay * this.config.jitterFactor * Math.random();
    return Math.min(this.config.maxDelay, exponentialDelay + jitter);
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const retryablePatterns = [
      /rate limit/i,
      /timeout/i,
      /connection/i,
      /network/i,
      /503/,
      /502/,
      /500/
    ];

    return retryablePatterns.some(pattern => pattern.test(error.message));
  }

  /**
   * Circuit breaker logic
   */
  private isCircuitOpen(): boolean {
    switch (this.circuitState) {
      case CircuitState.CLOSED:
        return false;

      case CircuitState.OPEN:
        // Check if recovery timeout has passed
        if (Date.now() - this.circuitOpenedAt >= this.config.recoveryTimeout) {
          this.circuitState = CircuitState.HALF_OPEN;
          this.circuitSuccesses = 0;
          this.emit('circuit_half_open');
        }
        return this.circuitState === CircuitState.OPEN;

      case CircuitState.HALF_OPEN:
        return false;

      default:
        return false;
    }
  }

  private recordSuccess(): void {
    if (this.circuitState === CircuitState.HALF_OPEN) {
      this.circuitSuccesses++;
      if (this.circuitSuccesses >= this.config.successThreshold) {
        this.circuitState = CircuitState.CLOSED;
        this.circuitFailures = 0;
        this.emit('circuit_closed');
      }
    } else if (this.circuitState === CircuitState.CLOSED) {
      this.circuitFailures = Math.max(0, this.circuitFailures - 1);
    }

    this.metrics.circuit_state = this.circuitState;
    this.metrics.circuit_successes = this.circuitSuccesses;
    this.metrics.circuit_failures = this.circuitFailures;
  }

  private recordFailure(): void {
    this.circuitFailures++;

    if (this.circuitState === CircuitState.CLOSED && this.circuitFailures >= this.config.failureThreshold) {
      this.circuitState = CircuitState.OPEN;
      this.circuitOpenedAt = Date.now();
      this.emit('circuit_opened', { failures: this.circuitFailures });
    } else if (this.circuitState === CircuitState.HALF_OPEN) {
      this.circuitState = CircuitState.OPEN;
      this.circuitOpenedAt = Date.now();
      this.emit('circuit_opened_from_half_open');
    }

    this.metrics.circuit_state = this.circuitState;
    this.metrics.circuit_failures = this.circuitFailures;
  }

  /**
   * Get or create token bucket for correlation ID
   */
  private getBucket(correlationId: string): TokenBucket {
    if (!this.buckets.has(correlationId)) {
      const bucket = new TokenBucket(
        this.config.burstLimit,
        this.config.requestsPerMinute / 60 // convert to per-second
      );
      this.buckets.set(correlationId, bucket);
    }

    return this.buckets.get(correlationId)!;
  }

  /**
   * Clean up old buckets to prevent memory leaks
   */
  private cleanupBuckets(): void {
    const cutoff = Date.now() - 3600000; // 1 hour ago

    for (const [correlationId, queue] of this.queues.entries()) {
      if (queue.length === 0 && (this.activeRequests.get(correlationId) || 0) === 0) {
        this.queues.delete(correlationId);
        this.activeRequests.delete(correlationId);
        this.buckets.delete(correlationId);
      }
    }
  }

  /**
   * Get total queue size across all correlation IDs
   */
  private getTotalQueueSize(): number {
    return Array.from(this.queues.values()).reduce((total, queue) => total + queue.length, 0);
  }

  /**
   * Utility method to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current metrics
   */
  getMetrics(): RateLimiterMetrics {
    this.metrics.queue_size_current = this.getTotalQueueSize();
    return { ...this.metrics };
  }

  /**
   * Reset circuit breaker manually
   */
  resetCircuit(): void {
    this.circuitState = CircuitState.CLOSED;
    this.circuitFailures = 0;
    this.circuitSuccesses = 0;
    this.metrics.circuit_state = this.circuitState;
    this.emit('circuit_reset');
  }

  /**
   * Get health status
   */
  getHealth(): {
    healthy: boolean;
    circuit_state: string;
    queue_size: number;
    active_requests: number;
    last_error?: string;
  } {
    const totalActive = Array.from(this.activeRequests.values()).reduce((a, b) => a + b, 0);

    return {
      healthy: this.circuitState !== CircuitState.OPEN && this.getTotalQueueSize() < 100,
      circuit_state: this.circuitState,
      queue_size: this.getTotalQueueSize(),
      active_requests: totalActive,
      last_error: this.metrics.last_error
    };
  }
}

/**
 * Convenience function for quick setup
 */
export function createRateLimiter(config?: Partial<RateLimiterConfig>): LLMRateLimiter {
  return new LLMRateLimiter(config);
}