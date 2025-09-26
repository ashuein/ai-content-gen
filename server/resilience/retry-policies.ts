/**
 * Retry Policies System
 * Configurable retry strategies for different pipeline phases
 * Handles transient failures with exponential backoff and circuit breakers
 */

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs: number;
  retryableErrors: (string | RegExp)[];
  circuitBreakerConfig?: CircuitBreakerConfig;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenMaxCalls: number;
  enabled: boolean;
}

export interface RetryContext {
  operation: string;
  phase: PipelinePhase;
  attempt: number;
  totalElapsedMs: number;
  lastError?: Error;
  metadata?: any;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalTimeMs: number;
  circuitBreakerTripped?: boolean;
}

export type PipelinePhase =
  | 'llm-request'
  | 'content-generation'
  | 'asset-compilation'
  | 'file-operations'
  | 'validation'
  | 'rendering';

enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

interface CircuitBreakerStats {
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  halfOpenCalls: number;
}

/**
 * Default retry configurations for different pipeline phases
 */
const DEFAULT_RETRY_CONFIGS: Record<PipelinePhase, RetryConfig> = {
  'llm-request': {
    maxAttempts: 5,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterMs: 500,
    retryableErrors: [
      /rate.?limit/i,
      /timeout/i,
      /connection/i,
      /network/i,
      /502|503|504/,
      'ECONNRESET',
      'ETIMEDOUT'
    ],
    circuitBreakerConfig: {
      failureThreshold: 5,
      recoveryTimeoutMs: 60000,
      halfOpenMaxCalls: 3,
      enabled: true
    }
  },
  'content-generation': {
    maxAttempts: 3,
    initialDelayMs: 2000,
    maxDelayMs: 15000,
    backoffMultiplier: 1.5,
    jitterMs: 1000,
    retryableErrors: [
      /timeout/i,
      /temporary/i,
      /busy/i
    ],
    circuitBreakerConfig: {
      failureThreshold: 3,
      recoveryTimeoutMs: 30000,
      halfOpenMaxCalls: 2,
      enabled: true
    }
  },
  'asset-compilation': {
    maxAttempts: 4,
    initialDelayMs: 500,
    maxDelayMs: 8000,
    backoffMultiplier: 2,
    jitterMs: 200,
    retryableErrors: [
      /EBUSY/i,
      /EMFILE/i,
      /ENFILE/i,
      /resource/i
    ],
    circuitBreakerConfig: {
      failureThreshold: 4,
      recoveryTimeoutMs: 20000,
      halfOpenMaxCalls: 2,
      enabled: true
    }
  },
  'file-operations': {
    maxAttempts: 6,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    backoffMultiplier: 1.8,
    jitterMs: 100,
    retryableErrors: [
      /EBUSY/i,
      /EMFILE/i,
      /ENFILE/i,
      /EAGAIN/i,
      /EACCES/i
    ],
    circuitBreakerConfig: {
      failureThreshold: 8,
      recoveryTimeoutMs: 10000,
      halfOpenMaxCalls: 3,
      enabled: false // File operations usually need immediate feedback
    }
  },
  'validation': {
    maxAttempts: 2,
    initialDelayMs: 500,
    maxDelayMs: 2000,
    backoffMultiplier: 2,
    jitterMs: 100,
    retryableErrors: [
      /schema.?not.?available/i,
      /validation.?service.?unavailable/i
    ],
    circuitBreakerConfig: {
      failureThreshold: 5,
      recoveryTimeoutMs: 15000,
      halfOpenMaxCalls: 2,
      enabled: true
    }
  },
  'rendering': {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    jitterMs: 500,
    retryableErrors: [
      /memory/i,
      /resource/i,
      /timeout/i
    ],
    circuitBreakerConfig: {
      failureThreshold: 3,
      recoveryTimeoutMs: 25000,
      halfOpenMaxCalls: 1,
      enabled: true
    }
  }
};

/**
 * Retry policy manager with circuit breaker support
 */
export class RetryPolicyManager {
  private configs: Map<PipelinePhase, RetryConfig> = new Map();
  private circuitBreakers: Map<string, CircuitBreakerStats> = new Map();
  private retryStats: Map<string, { attempts: number; successes: number; failures: number }> = new Map();

  constructor() {
    // Initialize with default configurations
    for (const [phase, config] of Object.entries(DEFAULT_RETRY_CONFIGS)) {
      this.configs.set(phase as PipelinePhase, config);
    }
  }

  /**
   * Update retry configuration for a specific phase
   */
  setRetryConfig(phase: PipelinePhase, config: Partial<RetryConfig>): void {
    const existingConfig = this.configs.get(phase) || DEFAULT_RETRY_CONFIGS[phase];
    this.configs.set(phase, { ...existingConfig, ...config });
  }

  /**
   * Execute operation with retry logic and circuit breaker
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    phase: PipelinePhase,
    operationId: string,
    metadata?: any
  ): Promise<RetryResult<T>> {
    const config = this.configs.get(phase) || DEFAULT_RETRY_CONFIGS[phase];
    const startTime = Date.now();
    let attempt = 0;
    let lastError: Error | undefined;

    // Check circuit breaker
    const circuitBreakerKey = `${phase}:${operationId}`;
    if (config.circuitBreakerConfig?.enabled) {
      const breakerResult = this.checkCircuitBreaker(circuitBreakerKey, config.circuitBreakerConfig);
      if (!breakerResult.canProceed) {
        return {
          success: false,
          error: new Error(`Circuit breaker is open for ${phase}`),
          attempts: 0,
          totalTimeMs: Date.now() - startTime,
          circuitBreakerTripped: true
        };
      }
    }

    while (attempt < config.maxAttempts) {
      attempt++;

      const context: RetryContext = {
        operation: operationId,
        phase,
        attempt,
        totalElapsedMs: Date.now() - startTime,
        lastError,
        metadata
      };

      try {
        // Attempt the operation
        const result = await operation();

        // Success - update circuit breaker and stats
        if (config.circuitBreakerConfig?.enabled) {
          this.recordCircuitBreakerSuccess(circuitBreakerKey);
        }

        this.recordSuccess(phase, operationId, attempt);

        return {
          success: true,
          result,
          attempts: attempt,
          totalTimeMs: Date.now() - startTime
        };

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        if (!this.isRetryableError(lastError, config)) {
          // Non-retryable error - fail immediately
          this.recordFailure(phase, operationId, attempt);

          if (config.circuitBreakerConfig?.enabled) {
            this.recordCircuitBreakerFailure(circuitBreakerKey, config.circuitBreakerConfig);
          }

          return {
            success: false,
            error: lastError,
            attempts: attempt,
            totalTimeMs: Date.now() - startTime
          };
        }

        // Record failure for circuit breaker
        if (config.circuitBreakerConfig?.enabled) {
          this.recordCircuitBreakerFailure(circuitBreakerKey, config.circuitBreakerConfig);
        }

        // If this was the last attempt, fail
        if (attempt >= config.maxAttempts) {
          this.recordFailure(phase, operationId, attempt);
          break;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt, config);

        // Log retry attempt
        console.warn(`Retry attempt ${attempt}/${config.maxAttempts} for ${phase}:${operationId} after ${delay}ms`, {
          error: lastError.message,
          context
        });

        // Wait before next attempt
        await this.delay(delay);
      }
    }

    // All attempts failed
    this.recordFailure(phase, operationId, attempt);

    return {
      success: false,
      error: lastError || new Error('All retry attempts failed'),
      attempts: attempt,
      totalTimeMs: Date.now() - startTime
    };
  }

  /**
   * Get retry statistics
   */
  getRetryStats(): Record<string, { attempts: number; successes: number; failures: number; successRate: number }> {
    const stats: Record<string, any> = {};

    for (const [key, data] of Array.from(this.retryStats.entries())) {
      const total = data.successes + data.failures;
      stats[key] = {
        ...data,
        successRate: total > 0 ? data.successes / total : 0
      };
    }

    return stats;
  }

  /**
   * Get circuit breaker states
   */
  getCircuitBreakerStates(): Record<string, CircuitBreakerStats> {
    const states: Record<string, CircuitBreakerStats> = {};

    for (const [key, stats] of Array.from(this.circuitBreakers.entries())) {
      states[key] = { ...stats };
    }

    return states;
  }

  /**
   * Reset circuit breaker for specific operation
   */
  resetCircuitBreaker(phase: PipelinePhase, operationId: string): void {
    const key = `${phase}:${operationId}`;
    this.circuitBreakers.delete(key);
  }

  /**
   * Reset all statistics
   */
  resetStats(): void {
    this.retryStats.clear();
    this.circuitBreakers.clear();
  }

  /**
   * Check if circuit breaker allows operation
   */
  private checkCircuitBreaker(
    key: string,
    config: CircuitBreakerConfig
  ): { canProceed: boolean; reason?: string } {
    const stats = this.circuitBreakers.get(key);

    if (!stats) {
      // Initialize circuit breaker
      this.circuitBreakers.set(key, {
        state: CircuitBreakerState.CLOSED,
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        halfOpenCalls: 0
      });
      return { canProceed: true };
    }

    const now = Date.now();

    switch (stats.state) {
      case CircuitBreakerState.CLOSED:
        return { canProceed: true };

      case CircuitBreakerState.OPEN:
        // Check if recovery timeout has passed
        if (now - stats.lastFailureTime >= config.recoveryTimeoutMs) {
          stats.state = CircuitBreakerState.HALF_OPEN;
          stats.halfOpenCalls = 0;
          return { canProceed: true };
        }
        return { canProceed: false, reason: 'Circuit breaker is open' };

      case CircuitBreakerState.HALF_OPEN:
        if (stats.halfOpenCalls < config.halfOpenMaxCalls) {
          stats.halfOpenCalls++;
          return { canProceed: true };
        }
        return { canProceed: false, reason: 'Half-open call limit reached' };

      default:
        return { canProceed: true };
    }
  }

  /**
   * Record circuit breaker success
   */
  private recordCircuitBreakerSuccess(key: string): void {
    const stats = this.circuitBreakers.get(key);
    if (!stats) return;

    stats.successes++;

    if (stats.state === CircuitBreakerState.HALF_OPEN) {
      // Success in half-open state - close the circuit
      stats.state = CircuitBreakerState.CLOSED;
      stats.failures = 0;
    }
  }

  /**
   * Record circuit breaker failure
   */
  private recordCircuitBreakerFailure(key: string, config: CircuitBreakerConfig): void {
    const stats = this.circuitBreakers.get(key);
    if (!stats) return;

    stats.failures++;
    stats.lastFailureTime = Date.now();

    if (stats.state === CircuitBreakerState.HALF_OPEN) {
      // Failure in half-open state - open the circuit again
      stats.state = CircuitBreakerState.OPEN;
    } else if (stats.state === CircuitBreakerState.CLOSED && stats.failures >= config.failureThreshold) {
      // Too many failures - open the circuit
      stats.state = CircuitBreakerState.OPEN;
    }
  }

  /**
   * Check if error is retryable based on configuration
   */
  private isRetryableError(error: Error, config: RetryConfig): boolean {
    const errorMessage = error.message || '';
    const errorName = error.name || '';
    const errorString = `${errorName}: ${errorMessage}`;

    return config.retryableErrors.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(errorString);
      } else {
        return errorString.toLowerCase().includes(pattern.toLowerCase());
      }
    });
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
    const jitter = Math.random() * config.jitterMs;
    const totalDelay = Math.min(baseDelay + jitter, config.maxDelayMs);

    return Math.floor(totalDelay);
  }

  /**
   * Record successful operation
   */
  private recordSuccess(phase: PipelinePhase, operationId: string, attempts: number): void {
    const key = `${phase}:${operationId}`;
    const stats = this.retryStats.get(key) || { attempts: 0, successes: 0, failures: 0 };

    stats.attempts += attempts;
    stats.successes++;

    this.retryStats.set(key, stats);
  }

  /**
   * Record failed operation
   */
  private recordFailure(phase: PipelinePhase, operationId: string, attempts: number): void {
    const key = `${phase}:${operationId}`;
    const stats = this.retryStats.get(key) || { attempts: 0, successes: 0, failures: 0 };

    stats.attempts += attempts;
    stats.failures++;

    this.retryStats.set(key, stats);
  }

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Convenience wrapper for common retry patterns
 */
export class RetryHelper {
  constructor(private retryManager: RetryPolicyManager) {}

  /**
   * Retry LLM API calls
   */
  async retryLLMCall<T>(
    operation: () => Promise<T>,
    operationId: string = 'llm-call',
    metadata?: any
  ): Promise<RetryResult<T>> {
    return this.retryManager.executeWithRetry(operation, 'llm-request', operationId, metadata);
  }

  /**
   * Retry file operations
   */
  async retryFileOperation<T>(
    operation: () => Promise<T>,
    operationId: string = 'file-op',
    metadata?: any
  ): Promise<RetryResult<T>> {
    return this.retryManager.executeWithRetry(operation, 'file-operations', operationId, metadata);
  }

  /**
   * Retry asset compilation
   */
  async retryAssetCompilation<T>(
    operation: () => Promise<T>,
    operationId: string = 'asset-compile',
    metadata?: any
  ): Promise<RetryResult<T>> {
    return this.retryManager.executeWithRetry(operation, 'asset-compilation', operationId, metadata);
  }

  /**
   * Retry content generation
   */
  async retryContentGeneration<T>(
    operation: () => Promise<T>,
    operationId: string = 'content-gen',
    metadata?: any
  ): Promise<RetryResult<T>> {
    return this.retryManager.executeWithRetry(operation, 'content-generation', operationId, metadata);
  }

  /**
   * Retry validation operations
   */
  async retryValidation<T>(
    operation: () => Promise<T>,
    operationId: string = 'validation',
    metadata?: any
  ): Promise<RetryResult<T>> {
    return this.retryManager.executeWithRetry(operation, 'validation', operationId, metadata);
  }

  /**
   * Retry rendering operations
   */
  async retryRendering<T>(
    operation: () => Promise<T>,
    operationId: string = 'rendering',
    metadata?: any
  ): Promise<RetryResult<T>> {
    return this.retryManager.executeWithRetry(operation, 'rendering', operationId, metadata);
  }
}

// Export singleton instances
export const retryPolicyManager = new RetryPolicyManager();
export const retryHelper = new RetryHelper(retryPolicyManager);