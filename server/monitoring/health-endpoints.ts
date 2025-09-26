/**
 * Health and Status Endpoints
 * Comprehensive monitoring and diagnostics for the entire pipeline
 * Provides detailed health checks for all system components
 */

import { Request, Response } from 'express';
import { stat, access } from 'fs/promises';
import { join } from 'path';
import { freemem, totalmem, cpus, uptime, loadavg } from 'os';
import { PATHS } from '../../config/paths.js';
import { sharedCache } from '../cache/shared-cache.js';
import { atomicPublisher } from '../publishing/atomic-publisher.js';
import { idempotencyStore } from '../idempotency/store.js';
import { lockManager } from '../concurrency/lock-manager.js';
import { retryPolicyManager } from '../resilience/retry-policies.js';
import { securityMiddleware } from '../security/middleware.js';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
}

export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  metrics?: Record<string, any>;
  lastChecked: string;
  responseTime?: number;
}

export interface SystemMetrics {
  memory: {
    used: number;
    free: number;
    total: number;
    usagePercent: number;
  };
  cpu: {
    cores: number;
    loadAverage: number[];
    usagePercent: number;
  };
  disk: {
    available: boolean;
    paths: Record<string, { accessible: boolean; size?: number }>;
  };
  process: {
    pid: number;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
  };
}

export interface DetailedStatus {
  overall: HealthStatus;
  components: ComponentHealth[];
  metrics: SystemMetrics;
  dependencies: {
    cache: any;
    publisher: any;
    idempotency: any;
    locks: any;
    retries: any;
    security: any;
  };
}

/**
 * Health monitoring service
 */
export class HealthMonitor {
  private startTime: number = Date.now();
  private lastHealthCheck: number = 0;
  private cachedHealth: ComponentHealth[] = [];
  private healthCheckInterval: number = 30000; // 30 seconds

  /**
   * Get overall system health
   */
  async getHealth(): Promise<HealthStatus> {
    const components = await this.checkAllComponents();
    const unhealthyCount = components.filter(c => c.status === 'unhealthy').length;
    const degradedCount = components.filter(c => c.status === 'degraded').length;

    let overallStatus: HealthStatus['status'] = 'healthy';
    if (unhealthyCount > 0) {
      overallStatus = 'unhealthy';
    } else if (degradedCount > 0) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };
  }

  /**
   * Get detailed system status
   */
  async getDetailedStatus(): Promise<DetailedStatus> {
    const [overall, components, metrics] = await Promise.all([
      this.getHealth(),
      this.checkAllComponents(),
      this.getSystemMetrics()
    ]);

    const dependencies = await this.getDependencyStatus();

    return {
      overall,
      components,
      metrics,
      dependencies
    };
  }

  /**
   * Check all system components
   */
  async checkAllComponents(): Promise<ComponentHealth[]> {
    const now = Date.now();

    // Use cached results if recent enough
    if (now - this.lastHealthCheck < this.healthCheckInterval && this.cachedHealth.length > 0) {
      return this.cachedHealth;
    }

    const checks = [
      this.checkFileSystem(),
      this.checkCache(),
      this.checkPublisher(),
      this.checkIdempotencyStore(),
      this.checkLockManager(),
      this.checkRetryPolicies(),
      this.checkSecurity(),
      this.checkEnvironment(),
      this.checkDependencies()
    ];

    this.cachedHealth = await Promise.all(checks);
    this.lastHealthCheck = now;

    return this.cachedHealth;
  }

  /**
   * Get system performance metrics
   */
  async getSystemMetrics(): Promise<SystemMetrics> {
    const memUsage = process.memoryUsage();
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;

    const loadAvg = loadavg();
    const cpuCount = cpus().length;

    // Check disk accessibility for configured paths
    const pathChecks = await Promise.allSettled([
      this.checkPath(PATHS.ROOT_DIR),
      this.checkPath(join(PATHS.ROOT_DIR, PATHS.TEMP_DIR)),
      this.checkPath(join(PATHS.ROOT_DIR, PATHS.CACHE_DIR)),
      this.checkPath(join(PATHS.ROOT_DIR, PATHS.PUBLIC_DIR))
    ]);

    const paths: Record<string, { accessible: boolean; size?: number }> = {};
    const pathNames = ['root', 'temp', 'cache', 'public'];

    pathChecks.forEach((result, index) => {
      const pathName = pathNames[index];
      if (result.status === 'fulfilled') {
        paths[pathName] = result.value;
      } else {
        paths[pathName] = { accessible: false };
      }
    });

    return {
      memory: {
        used: usedMem,
        free: freeMem,
        total: totalMem,
        usagePercent: (usedMem / totalMem) * 100
      },
      cpu: {
        cores: cpuCount,
        loadAverage: loadAvg,
        usagePercent: loadAvg[0] / cpuCount * 100
      },
      disk: {
        available: Object.values(paths).some(p => p.accessible),
        paths
      },
      process: {
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: memUsage
      }
    };
  }

  /**
   * Check file system health
   */
  private async checkFileSystem(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      // Check critical directories
      const criticalPaths = [
        PATHS.ROOT_DIR,
        join(PATHS.ROOT_DIR, PATHS.TEMP_DIR),
        join(PATHS.ROOT_DIR, PATHS.CACHE_DIR),
        join(PATHS.ROOT_DIR, PATHS.PUBLIC_DIR)
      ];

      const checks = await Promise.allSettled(
        criticalPaths.map(path => access(path))
      );

      const failures = checks.filter(result => result.status === 'rejected').length;

      return {
        component: 'filesystem',
        status: failures === 0 ? 'healthy' : failures < criticalPaths.length ? 'degraded' : 'unhealthy',
        message: failures === 0 ? 'All paths accessible' : `${failures}/${criticalPaths.length} paths inaccessible`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'filesystem',
        status: 'unhealthy',
        message: `File system error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check cache system health
   */
  private async checkCache(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      const health = await sharedCache.getHealth();
      const stats = sharedCache.getStats();

      return {
        component: 'cache',
        status: health.healthy ? 'healthy' : 'degraded',
        message: health.healthy ? 'Cache system operational' : 'Cache issues detected',
        metrics: {
          hitRate: stats.hitRate,
          memoryUsage: health.memoryUsage,
          diskUsage: health.diskUsage,
          totalEntries: stats.totalEntries
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'cache',
        status: 'unhealthy',
        message: `Cache error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check atomic publisher health
   */
  private async checkPublisher(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      const health = await atomicPublisher.getHealth();

      return {
        component: 'publisher',
        status: health.healthy ? 'healthy' : 'degraded',
        message: health.healthy ? 'Publisher operational' : 'Publisher issues detected',
        metrics: {
          canWrite: health.canWrite,
          publishDir: health.publishDir,
          backupDir: health.backupDir
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'publisher',
        status: 'unhealthy',
        message: `Publisher error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check idempotency store health
   */
  private async checkIdempotencyStore(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      await idempotencyStore.initialize();
      const stats = await idempotencyStore.getStats();

      return {
        component: 'idempotency',
        status: 'healthy',
        message: 'Idempotency store operational',
        metrics: {
          activeRecords: stats.activeRecords,
          totalAttachments: stats.totalAttachments,
          storageSize: stats.storageSize
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'idempotency',
        status: 'unhealthy',
        message: `Idempotency store error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check lock manager health
   */
  private async checkLockManager(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      await lockManager.initialize();
      const stats = await lockManager.getStats();
      const deadlocks = await lockManager.detectDeadlocks();

      return {
        component: 'locks',
        status: deadlocks.hasDeadlocks ? 'degraded' : 'healthy',
        message: deadlocks.hasDeadlocks ? 'Potential deadlocks detected' : 'Lock manager operational',
        metrics: {
          activeLocks: stats.totalActiveLocks,
          locksByType: stats.locksByType,
          averageLockAge: stats.averageLockAge,
          suspiciousLocks: deadlocks.suspiciousLocks.length
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'locks',
        status: 'unhealthy',
        message: `Lock manager error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check retry policies health
   */
  private async checkRetryPolicies(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      const retryStats = retryPolicyManager.getRetryStats();
      const circuitBreakers = retryPolicyManager.getCircuitBreakerStates();

      const openCircuits = Object.values(circuitBreakers).filter(cb => cb.state === 'open').length;

      return {
        component: 'retries',
        status: openCircuits > 3 ? 'degraded' : 'healthy',
        message: openCircuits > 3 ? 'Multiple circuit breakers open' : 'Retry policies operational',
        metrics: {
          operationsTracked: Object.keys(retryStats).length,
          openCircuits,
          circuitBreakerStates: circuitBreakers
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'retries',
        status: 'unhealthy',
        message: `Retry policies error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check security middleware health
   */
  private async checkSecurity(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      const securityStats = securityMiddleware.getSecurityStats();
      const recentViolations = securityStats.recentViolations.filter(
        v => Date.now() - v.timestamp < 300000 // Last 5 minutes
      );

      const criticalViolations = recentViolations.filter(v => v.severity === 'critical').length;

      return {
        component: 'security',
        status: criticalViolations > 5 ? 'degraded' : 'healthy',
        message: criticalViolations > 5 ? 'High security violations' : 'Security middleware operational',
        metrics: {
          totalViolations: securityStats.totalViolations,
          recentViolations: recentViolations.length,
          criticalViolations,
          topOffendingIPs: securityStats.topOffendingIPs.slice(0, 3)
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'security',
        status: 'unhealthy',
        message: `Security middleware error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check environment configuration
   */
  private async checkEnvironment(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      const requiredEnvVars = ['NODE_ENV'];
      const optionalEnvVars = ['OPENAI_API_KEY', 'PORT', 'API_KEYS'];

      const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
      const present = optionalEnvVars.filter(envVar => process.env[envVar]);

      return {
        component: 'environment',
        status: missing.length === 0 ? 'healthy' : 'degraded',
        message: missing.length === 0 ? 'Environment configured' : `Missing: ${missing.join(', ')}`,
        metrics: {
          nodeEnv: process.env.NODE_ENV,
          hasOpenAI: !!process.env.OPENAI_API_KEY,
          hasApiKeys: !!process.env.API_KEYS,
          presentOptional: present.length,
          missingRequired: missing.length
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'environment',
        status: 'unhealthy',
        message: `Environment check error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check external dependencies
   */
  private async checkDependencies(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      // In a real implementation, you would check external services here
      // For now, we'll just check that critical modules are loadable

      const dependencies = ['fs/promises', 'crypto', 'path'];
      const loadableCount = dependencies.filter(dep => {
        try {
          require(dep);
          return true;
        } catch {
          return false;
        }
      }).length;

      return {
        component: 'dependencies',
        status: loadableCount === dependencies.length ? 'healthy' : 'degraded',
        message: `${loadableCount}/${dependencies.length} core dependencies available`,
        metrics: {
          coreModules: loadableCount,
          totalChecked: dependencies.length
        },
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };

    } catch (error) {
      return {
        component: 'dependencies',
        status: 'unhealthy',
        message: `Dependencies error: ${error instanceof Error ? error.message : String(error)}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Get dependency status for detailed view
   */
  private async getDependencyStatus(): Promise<DetailedStatus['dependencies']> {
    try {
      const [cache, publisher, idempotency, locks, retries, security] = await Promise.allSettled([
        sharedCache.getStats(),
        atomicPublisher.getHealth(),
        idempotencyStore.getStats(),
        lockManager.getStats(),
        Promise.resolve(retryPolicyManager.getRetryStats()),
        Promise.resolve(securityMiddleware.getSecurityStats())
      ]);

      return {
        cache: cache.status === 'fulfilled' ? cache.value : { error: cache.reason },
        publisher: publisher.status === 'fulfilled' ? publisher.value : { error: publisher.reason },
        idempotency: idempotency.status === 'fulfilled' ? idempotency.value : { error: idempotency.reason },
        locks: locks.status === 'fulfilled' ? locks.value : { error: locks.reason },
        retries: retries.status === 'fulfilled' ? retries.value : { error: retries.reason },
        security: security.status === 'fulfilled' ? security.value : { error: security.reason }
      };
    } catch (error) {
      return {
        cache: { error: 'Failed to get cache status' },
        publisher: { error: 'Failed to get publisher status' },
        idempotency: { error: 'Failed to get idempotency status' },
        locks: { error: 'Failed to get locks status' },
        retries: { error: 'Failed to get retries status' },
        security: { error: 'Failed to get security status' }
      };
    }
  }

  /**
   * Helper method to check path accessibility
   */
  private async checkPath(path: string): Promise<{ accessible: boolean; size?: number }> {
    try {
      await access(path);
      const stats = await stat(path);
      return { accessible: true, size: stats.size };
    } catch {
      return { accessible: false };
    }
  }
}

/**
 * Express route handlers
 */
export class HealthEndpoints {
  private monitor = new HealthMonitor();

  /**
   * Basic health check endpoint
   */
  health = async (req: Request, res: Response): Promise<void> => {
    try {
      const health = await this.monitor.getHealth();
      const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

      res.status(statusCode).json(health);
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  };

  /**
   * Detailed status endpoint
   */
  status = async (req: Request, res: Response): Promise<void> => {
    try {
      const status = await this.monitor.getDetailedStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  };

  /**
   * System metrics endpoint
   */
  metrics = async (req: Request, res: Response): Promise<void> => {
    try {
      const metrics = await this.monitor.getSystemMetrics();
      res.json(metrics);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  };

  /**
   * Readiness probe endpoint
   */
  ready = async (req: Request, res: Response): Promise<void> => {
    try {
      const components = await this.monitor.checkAllComponents();
      const criticalComponents = ['filesystem', 'cache', 'publisher'];

      const criticalHealthy = criticalComponents.every(name =>
        components.find(c => c.component === name)?.status === 'healthy'
      );

      if (criticalHealthy) {
        res.status(200).json({ ready: true, timestamp: new Date().toISOString() });
      } else {
        res.status(503).json({ ready: false, timestamp: new Date().toISOString() });
      }
    } catch (error) {
      res.status(503).json({
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  };

  /**
   * Liveness probe endpoint
   */
  live = async (req: Request, res: Response): Promise<void> => {
    // Simple liveness check - just verify the process is responding
    res.status(200).json({
      alive: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  };
}

// Export singleton instance
export const healthEndpoints = new HealthEndpoints();