/**
 * Concurrency Lock Manager
 * Prevents multiple instances of the same operation from running simultaneously
 * Uses distributed locking with Redis-like semantics but file-based implementation
 */

import { writeFile, readFile, unlink, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../../config/paths.js';

export interface LockConfig {
  defaultTtl: number; // milliseconds
  lockDir: string;
  maxRetries: number;
  retryDelayMs: number;
  cleanupInterval: number;
  enableDeadlockDetection: boolean;
}

export interface LockInfo {
  lockId: string;
  operationType: string;
  resourceId: string;
  ownerId: string;
  acquiredAt: number;
  expiresAt: number;
  metadata?: {
    correlationId?: string;
    userId?: string;
    sessionId?: string;
  };
}

export interface AcquireLockResult {
  acquired: boolean;
  lockInfo?: LockInfo;
  waitTimeMs?: number;
  error?: string;
  existingLock?: LockInfo;
}

const DEFAULT_LOCK_CONFIG: LockConfig = {
  defaultTtl: 300000, // 5 minutes
  lockDir: join(PATHS.CACHE_DIR, 'locks'),
  maxRetries: 10,
  retryDelayMs: 1000,
  cleanupInterval: 60000, // 1 minute
  enableDeadlockDetection: true
};

/**
 * Distributed lock manager for content generation operations
 */
export class ConcurrencyLockManager {
  private config: LockConfig;
  private lockDir: string;
  private ownerId: string;
  private activeLocks: Map<string, LockInfo> = new Map();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<LockConfig> = {}) {
    this.config = { ...DEFAULT_LOCK_CONFIG, ...config };
    this.lockDir = this.config.lockDir;
    this.ownerId = this.generateOwnerId();
    this.startCleanupTimer();
  }

  /**
   * Initialize lock directory
   */
  async initialize(): Promise<void> {
    await mkdir(this.lockDir, { recursive: true });
  }

  /**
   * Acquire lock for content generation operation
   */
  async acquireLock(
    operationType: 'generate' | 'compile' | 'render',
    resourceId: string,
    ttl: number = this.config.defaultTtl,
    metadata?: LockInfo['metadata']
  ): Promise<AcquireLockResult> {
    const startTime = Date.now();
    let retryCount = 0;

    // Generate lock identifier
    const lockId = this.generateLockId(operationType, resourceId);
    const lockPath = this.getLockPath(lockId);

    while (retryCount <= this.config.maxRetries) {
      try {
        // Try to acquire lock
        const lockInfo = await this.tryAcquireLock(
          lockId,
          operationType,
          resourceId,
          ttl,
          metadata
        );

        if (lockInfo) {
          // Successfully acquired lock
          this.activeLocks.set(lockId, lockInfo);

          return {
            acquired: true,
            lockInfo,
            waitTimeMs: Date.now() - startTime
          };
        }

        // Lock is held by someone else, check if it's expired
        const existingLock = await this.readLockFile(lockPath);
        if (existingLock && this.isLockExpired(existingLock)) {
          // Remove expired lock and retry
          await this.forceReleaseLock(lockId);
          continue;
        }

        // Lock is still valid, wait and retry
        if (retryCount < this.config.maxRetries) {
          await this.delay(this.config.retryDelayMs * (retryCount + 1));
          retryCount++;
        } else {
          return {
            acquired: false,
            waitTimeMs: Date.now() - startTime,
            error: 'Lock acquisition timeout',
            existingLock
          };
        }

      } catch (error) {
        return {
          acquired: false,
          waitTimeMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }

    return {
      acquired: false,
      waitTimeMs: Date.now() - startTime,
      error: 'Max retries exceeded'
    };
  }

  /**
   * Release lock
   */
  async releaseLock(lockId: string): Promise<boolean> {
    try {
      const lockPath = this.getLockPath(lockId);

      // Verify we own the lock
      const existingLock = await this.readLockFile(lockPath);
      if (!existingLock || existingLock.ownerId !== this.ownerId) {
        return false;
      }

      // Remove lock file
      await unlink(lockPath);

      // Remove from active locks
      this.activeLocks.delete(lockId);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if lock is currently held
   */
  async isLocked(operationType: string, resourceId: string): Promise<{
    locked: boolean;
    lockInfo?: LockInfo;
    ownedByUs?: boolean;
  }> {
    const lockId = this.generateLockId(operationType, resourceId);
    const lockPath = this.getLockPath(lockId);

    try {
      const lockInfo = await this.readLockFile(lockPath);
      if (!lockInfo) {
        return { locked: false };
      }

      if (this.isLockExpired(lockInfo)) {
        // Clean up expired lock
        await this.forceReleaseLock(lockId);
        return { locked: false };
      }

      return {
        locked: true,
        lockInfo,
        ownedByUs: lockInfo.ownerId === this.ownerId
      };
    } catch {
      return { locked: false };
    }
  }

  /**
   * Extend lock expiration
   */
  async extendLock(lockId: string, additionalTtl: number): Promise<boolean> {
    try {
      const lockPath = this.getLockPath(lockId);
      const existingLock = await this.readLockFile(lockPath);

      if (!existingLock || existingLock.ownerId !== this.ownerId) {
        return false;
      }

      // Update expiration time
      existingLock.expiresAt = Math.max(
        existingLock.expiresAt,
        Date.now() + additionalTtl
      );

      // Write updated lock
      await this.writeLockFile(lockPath, existingLock);

      // Update active locks
      this.activeLocks.set(lockId, existingLock);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all active locks (for monitoring)
   */
  async getActiveLocks(): Promise<LockInfo[]> {
    const locks: LockInfo[] = [];

    try {
      const lockFiles = await import('fs/promises').then(fs => fs.readdir(this.lockDir));

      for (const file of lockFiles) {
        if (file.endsWith('.lock')) {
          const lockPath = join(this.lockDir, file);
          const lockInfo = await this.readLockFile(lockPath);

          if (lockInfo && !this.isLockExpired(lockInfo)) {
            locks.push(lockInfo);
          } else if (lockInfo && this.isLockExpired(lockInfo)) {
            // Clean up expired lock
            await unlink(lockPath).catch(() => {});
          }
        }
      }
    } catch (error) {
      console.error('Failed to get active locks:', error);
    }

    return locks;
  }

  /**
   * Release all locks owned by this instance
   */
  async releaseAllOwnedLocks(): Promise<number> {
    let releasedCount = 0;

    for (const [lockId, lockInfo] of Array.from(this.activeLocks.entries())) {
      if (lockInfo.ownerId === this.ownerId) {
        const released = await this.releaseLock(lockId);
        if (released) {
          releasedCount++;
        }
      }
    }

    return releasedCount;
  }

  /**
   * Detect potential deadlocks
   */
  async detectDeadlocks(): Promise<{
    hasDeadlocks: boolean;
    suspiciousLocks: LockInfo[];
    recommendations: string[];
  }> {
    if (!this.config.enableDeadlockDetection) {
      return {
        hasDeadlocks: false,
        suspiciousLocks: [],
        recommendations: []
      };
    }

    const locks = await this.getActiveLocks();
    const suspiciousLocks: LockInfo[] = [];
    const recommendations: string[] = [];

    const now = Date.now();
    const suspiciousAge = 10 * 60 * 1000; // 10 minutes

    for (const lock of locks) {
      const age = now - lock.acquiredAt;

      if (age > suspiciousAge) {
        suspiciousLocks.push(lock);
      }
    }

    if (suspiciousLocks.length > 0) {
      recommendations.push(`Found ${suspiciousLocks.length} potentially stuck locks`);
      recommendations.push('Consider investigating long-running operations');

      if (suspiciousLocks.length > 5) {
        recommendations.push('High number of long-running locks may indicate deadlock');
      }
    }

    return {
      hasDeadlocks: suspiciousLocks.length > 3,
      suspiciousLocks,
      recommendations
    };
  }

  /**
   * Get lock statistics
   */
  async getStats(): Promise<{
    totalActiveLocks: number;
    locksByType: Record<string, number>;
    oldestLockAge: number;
    averageLockAge: number;
    locksOwnedByUs: number;
  }> {
    const locks = await this.getActiveLocks();
    const now = Date.now();

    const locksByType: Record<string, number> = {};
    let totalAge = 0;
    let oldestAge = 0;
    let locksOwnedByUs = 0;

    for (const lock of locks) {
      const age = now - lock.acquiredAt;
      totalAge += age;
      oldestAge = Math.max(oldestAge, age);

      locksByType[lock.operationType] = (locksByType[lock.operationType] || 0) + 1;

      if (lock.ownerId === this.ownerId) {
        locksOwnedByUs++;
      }
    }

    return {
      totalActiveLocks: locks.length,
      locksByType,
      oldestLockAge: oldestAge,
      averageLockAge: locks.length > 0 ? totalAge / locks.length : 0,
      locksOwnedByUs
    };
  }

  /**
   * Cleanup expired locks
   */
  async cleanup(): Promise<{ removed: number; errors: number }> {
    let removed = 0;
    let errors = 0;

    try {
      const lockFiles = await import('fs/promises').then(fs => fs.readdir(this.lockDir));

      for (const file of lockFiles) {
        if (file.endsWith('.lock')) {
          const lockPath = join(this.lockDir, file);

          try {
            const lockInfo = await this.readLockFile(lockPath);

            if (!lockInfo || this.isLockExpired(lockInfo)) {
              await unlink(lockPath);
              removed++;

              // Remove from active locks if it was ours
              if (lockInfo) {
                this.activeLocks.delete(lockInfo.lockId);
              }
            }
          } catch {
            // Remove corrupted lock files
            await unlink(lockPath).catch(() => {});
            errors++;
          }
        }
      }
    } catch (error) {
      console.error('Lock cleanup failed:', error);
      errors++;
    }

    return { removed, errors };
  }

  /**
   * Destroy lock manager and cleanup
   */
  async destroy(): Promise<void> {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Release all owned locks
    await this.releaseAllOwnedLocks();
  }

  /**
   * Private helper methods
   */
  private async tryAcquireLock(
    lockId: string,
    operationType: string,
    resourceId: string,
    ttl: number,
    metadata?: LockInfo['metadata']
  ): Promise<LockInfo | null> {
    const lockPath = this.getLockPath(lockId);
    const now = Date.now();

    const lockInfo: LockInfo = {
      lockId,
      operationType,
      resourceId,
      ownerId: this.ownerId,
      acquiredAt: now,
      expiresAt: now + ttl,
      metadata
    };

    try {
      // Try to check if lock already exists
      await stat(lockPath);
      // Lock file exists, cannot acquire
      return null;
    } catch {
      // Lock file doesn't exist, try to create it
      try {
        await this.writeLockFile(lockPath, lockInfo);
        return lockInfo;
      } catch {
        // Race condition - someone else created the lock
        return null;
      }
    }
  }

  private async readLockFile(lockPath: string): Promise<LockInfo | null> {
    try {
      const data = await readFile(lockPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async writeLockFile(lockPath: string, lockInfo: LockInfo): Promise<void> {
    await writeFile(lockPath, JSON.stringify(lockInfo, null, 2), { flag: 'wx' });
  }

  private async forceReleaseLock(lockId: string): Promise<void> {
    const lockPath = this.getLockPath(lockId);
    await unlink(lockPath).catch(() => {});
    this.activeLocks.delete(lockId);
  }

  private isLockExpired(lockInfo: LockInfo): boolean {
    return Date.now() > lockInfo.expiresAt;
  }

  private generateLockId(operationType: string, resourceId: string): string {
    const combined = `${operationType}:${resourceId}`;
    return createHash('sha256').update(combined).digest('hex');
  }

  private getLockPath(lockId: string): string {
    return join(this.lockDir, `${lockId}.lock`);
  }

  private generateOwnerId(): string {
    const hostname = require('os').hostname();
    const pid = process.pid;
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2);

    return createHash('md5').update(`${hostname}:${pid}:${timestamp}:${random}`).digest('hex');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      await this.cleanup();
    }, this.config.cleanupInterval);
  }
}

// Export singleton instance
export const lockManager = new ConcurrencyLockManager();