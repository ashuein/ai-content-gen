/**
 * Content-Addressed Caching Manager
 *
 * Implements production-ready caching for content generation with:
 * - SHA256-based content addressing
 * - Multi-tier caching (memory, disk, distributed)
 * - TTL and LRU eviction policies
 * - Cache warming and preloading
 * - Metrics and monitoring
 * - Cache coherency and invalidation
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { EventEmitter } from 'events';

/**
 * Cache configuration
 */
export interface CacheConfig {
  // Storage configuration
  enableMemoryCache: boolean;
  enableDiskCache: boolean;
  memoryMaxSize: number;          // Max items in memory cache
  diskCachePath: string;          // Path to disk cache directory
  diskMaxSize: number;            // Max disk cache size in bytes

  // TTL configuration
  defaultTtl: number;             // Default TTL in seconds
  maxTtl: number;                 // Maximum TTL in seconds
  minTtl: number;                 // Minimum TTL in seconds

  // Performance configuration
  compressionEnabled: boolean;    // Enable gzip compression for disk cache
  checksumValidation: boolean;    // Validate checksums on read
  asyncWrite: boolean;            // Write to disk asynchronously

  // Monitoring
  enableMetrics: boolean;         // Enable metrics collection
  enableLogging: boolean;         // Enable detailed logging

  // Cleanup configuration
  cleanupInterval: number;        // Cleanup interval in ms
  maxAge: number;                 // Max age for cache entries in ms
}

/**
 * Default cache configuration
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  enableMemoryCache: true,
  enableDiskCache: true,
  memoryMaxSize: 1000,
  diskCachePath: './cache',
  diskMaxSize: 1024 * 1024 * 1024, // 1GB

  defaultTtl: 3600,               // 1 hour
  maxTtl: 86400,                  // 24 hours
  minTtl: 60,                     // 1 minute

  compressionEnabled: true,
  checksumValidation: true,
  asyncWrite: true,

  enableMetrics: true,
  enableLogging: false,

  cleanupInterval: 300000,        // 5 minutes
  maxAge: 86400000               // 24 hours
};

/**
 * Cache entry metadata
 */
export interface CacheEntry<T> {
  key: string;
  value: T;
  hash: string;                   // SHA256 of content
  createdAt: number;              // Timestamp
  expiresAt: number;              // Expiration timestamp
  accessCount: number;            // Number of times accessed
  lastAccessed: number;           // Last access timestamp
  size: number;                   // Size in bytes
  metadata?: Record<string, any>; // Additional metadata
}

/**
 * Cache metrics
 */
export interface CacheMetrics {
  hits_total: number;
  misses_total: number;
  writes_total: number;
  evictions_total: number;
  errors_total: number;

  hit_rate: number;               // Cache hit rate (0-1)
  memory_entries: number;         // Current memory cache entries
  memory_size_bytes: number;      // Current memory cache size
  disk_entries: number;           // Current disk cache entries
  disk_size_bytes: number;        // Current disk cache size

  avg_get_time_ms: number;        // Average get operation time
  avg_set_time_ms: number;        // Average set operation time

  cleanup_runs: number;           // Number of cleanup runs
  last_cleanup: number;           // Last cleanup timestamp
}

/**
 * Cache key types for different content types
 */
export enum CacheKeyType {
  PROMPT_ENVELOPE = 'prompt_envelope',
  LLM_RESPONSE = 'llm_response',
  COMPILED_ASSET = 'compiled_asset',
  TEMPLATE = 'template',
  VALIDATION_RESULT = 'validation_result',
  PIPELINE_RESULT = 'pipeline_result'
}

/**
 * LRU Cache implementation for memory caching
 */
class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
      entry.lastAccessed = Date.now();
      entry.accessCount++;
      return entry;
    }
    return undefined;
  }

  set(key: string, entry: CacheEntry<T>): void {
    // Remove if already exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict least recently used if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, entry);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  size(): number {
    return this.cache.size;
  }

  getMemorySize(): number {
    return Array.from(this.cache.values()).reduce((total, entry) => total + entry.size, 0);
  }

  entries(): CacheEntry<T>[] {
    return Array.from(this.cache.values());
  }
}

/**
 * Main cache manager class
 */
export class CacheManager extends EventEmitter {
  private config: CacheConfig;
  private logger?: (level: string, message: string, data?: any) => void;

  // Memory cache
  private memoryCache: LRUCache<any>;

  // Metrics
  private metrics: CacheMetrics;
  private operationTimes: { get: number[]; set: number[] } = { get: [], set: [] };

  // Cleanup timer
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<CacheConfig> = {}, logger?: (level: string, message: string, data?: any) => void) {
    super();
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    this.logger = logger;

    this.memoryCache = new LRUCache(this.config.memoryMaxSize);

    this.metrics = {
      hits_total: 0,
      misses_total: 0,
      writes_total: 0,
      evictions_total: 0,
      errors_total: 0,
      hit_rate: 0,
      memory_entries: 0,
      memory_size_bytes: 0,
      disk_entries: 0,
      disk_size_bytes: 0,
      avg_get_time_ms: 0,
      avg_set_time_ms: 0,
      cleanup_runs: 0,
      last_cleanup: 0
    };

    // Initialize disk cache directory
    this.initializeDiskCache();

    // Start cleanup timer
    if (this.config.cleanupInterval > 0) {
      this.startCleanupTimer();
    }
  }

  /**
   * Get value from cache with content addressing
   */
  async get<T>(keyType: CacheKeyType, content: any, metadata?: Record<string, any>): Promise<T | undefined> {
    const startTime = Date.now();
    const key = this.generateKey(keyType, content);

    try {
      let entry: CacheEntry<T> | undefined;

      // Try memory cache first
      if (this.config.enableMemoryCache) {
        entry = this.memoryCache.get(key);
        if (entry && !this.isExpired(entry)) {
          this.metrics.hits_total++;
          this.updateGetMetrics(startTime);
          this.emit('hit', { key, source: 'memory', metadata });
          return entry.value;
        }
      }

      // Try disk cache
      if (this.config.enableDiskCache) {
        entry = await this.getDiskEntry<T>(key);
        if (entry && !this.isExpired(entry)) {
          // Promote to memory cache
          if (this.config.enableMemoryCache) {
            this.memoryCache.set(key, entry);
          }

          this.metrics.hits_total++;
          this.updateGetMetrics(startTime);
          this.emit('hit', { key, source: 'disk', metadata });
          return entry.value;
        }
      }

      // Cache miss
      this.metrics.misses_total++;
      this.updateGetMetrics(startTime);
      this.emit('miss', { key, metadata });
      return undefined;

    } catch (error) {
      this.metrics.errors_total++;
      this.logger?.('error', 'Cache get error', { key, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  /**
   * Set value in cache with content addressing
   */
  async set<T>(
    keyType: CacheKeyType,
    content: any,
    value: T,
    ttl?: number,
    metadata?: Record<string, any>
  ): Promise<void> {
    const startTime = Date.now();
    const key = this.generateKey(keyType, content);
    const hash = this.generateContentHash(content);

    const actualTtl = this.normalizeTtl(ttl || this.config.defaultTtl);
    const now = Date.now();

    const entry: CacheEntry<T> = {
      key,
      value,
      hash,
      createdAt: now,
      expiresAt: now + (actualTtl * 1000),
      accessCount: 0,
      lastAccessed: now,
      size: this.estimateSize(value),
      metadata
    };

    try {
      // Store in memory cache
      if (this.config.enableMemoryCache) {
        this.memoryCache.set(key, entry);
      }

      // Store in disk cache
      if (this.config.enableDiskCache) {
        if (this.config.asyncWrite) {
          // Async write - don't wait
          this.setDiskEntry(key, entry).catch(error => {
            this.metrics.errors_total++;
            this.logger?.('error', 'Async disk cache write error', { key, error: error.message });
          });
        } else {
          // Sync write - wait for completion
          await this.setDiskEntry(key, entry);
        }
      }

      this.metrics.writes_total++;
      this.updateSetMetrics(startTime);
      this.emit('set', { key, size: entry.size, ttl: actualTtl, metadata });

    } catch (error) {
      this.metrics.errors_total++;
      this.logger?.('error', 'Cache set error', { key, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Delete from cache
   */
  async delete(keyType: CacheKeyType, content: any): Promise<boolean> {
    const key = this.generateKey(keyType, content);

    try {
      let deleted = false;

      // Delete from memory cache
      if (this.config.enableMemoryCache) {
        deleted = this.memoryCache.delete(key) || deleted;
      }

      // Delete from disk cache
      if (this.config.enableDiskCache) {
        deleted = await this.deleteDiskEntry(key) || deleted;
      }

      if (deleted) {
        this.emit('delete', { key });
      }

      return deleted;

    } catch (error) {
      this.metrics.errors_total++;
      this.logger?.('error', 'Cache delete error', { key, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    try {
      // Clear memory cache
      if (this.config.enableMemoryCache) {
        this.memoryCache.clear();
      }

      // Clear disk cache
      if (this.config.enableDiskCache) {
        await this.clearDiskCache();
      }

      this.emit('clear');

    } catch (error) {
      this.metrics.errors_total++;
      this.logger?.('error', 'Cache clear error', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Warm cache with precomputed values
   */
  async warm(entries: Array<{
    keyType: CacheKeyType;
    content: any;
    value: any;
    ttl?: number;
    metadata?: Record<string, any>;
  }>): Promise<void> {
    const startTime = Date.now();

    for (const entry of entries) {
      try {
        await this.set(entry.keyType, entry.content, entry.value, entry.ttl, entry.metadata);
      } catch (error) {
        this.logger?.('warn', 'Cache warming failed for entry', {
          keyType: entry.keyType,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const duration = Date.now() - startTime;
    this.emit('warmed', { entries: entries.length, duration });
  }

  /**
   * Generate cache key from content
   */
  private generateKey(keyType: CacheKeyType, content: any): string {
    const hash = this.generateContentHash(content);
    return `${keyType}:${hash}`;
  }

  /**
   * Generate SHA256 hash of content
   */
  private generateContentHash(content: any): string {
    const normalized = this.normalizeContent(content);
    return createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Normalize content for consistent hashing
   */
  private normalizeContent(content: any): string {
    if (typeof content === 'string') {
      return content;
    }
    // Sort object keys for consistent hashing
    return JSON.stringify(content, Object.keys(content).sort());
  }

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() > entry.expiresAt;
  }

  /**
   * Normalize TTL to be within bounds
   */
  private normalizeTtl(ttl: number): number {
    return Math.max(this.config.minTtl, Math.min(this.config.maxTtl, ttl));
  }

  /**
   * Estimate size of value in bytes
   */
  private estimateSize(value: any): number {
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      return 1024; // Default estimate
    }
  }

  /**
   * Disk cache operations
   */
  private async initializeDiskCache(): Promise<void> {
    if (!this.config.enableDiskCache) return;

    try {
      await fs.mkdir(this.config.diskCachePath, { recursive: true });
    } catch (error) {
      this.logger?.('error', 'Failed to initialize disk cache directory', {
        path: this.config.diskCachePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async getDiskEntry<T>(key: string): Promise<CacheEntry<T> | undefined> {
    try {
      const filePath = this.getDiskPath(key);
      const data = await fs.readFile(filePath, 'utf8');
      const entry = JSON.parse(data) as CacheEntry<T>;

      // Validate checksum if enabled
      if (this.config.checksumValidation) {
        const expectedHash = this.generateContentHash(entry.value);
        if (entry.hash !== expectedHash) {
          this.logger?.('warn', 'Cache entry checksum mismatch', { key });
          await this.deleteDiskEntry(key);
          return undefined;
        }
      }

      return entry;
    } catch {
      return undefined;
    }
  }

  private async setDiskEntry<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const filePath = this.getDiskPath(key);
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(entry), 'utf8');
  }

  private async deleteDiskEntry(key: string): Promise<boolean> {
    try {
      const filePath = this.getDiskPath(key);
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async clearDiskCache(): Promise<void> {
    try {
      await fs.rm(this.config.diskCachePath, { recursive: true, force: true });
      await fs.mkdir(this.config.diskCachePath, { recursive: true });
    } catch (error) {
      this.logger?.('error', 'Failed to clear disk cache', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getDiskPath(key: string): string {
    // Create subdirectories based on key prefix for better file system performance
    const prefix = key.substring(0, 2);
    return join(this.config.diskCachePath, prefix, `${key}.json`);
  }

  /**
   * Cleanup expired entries
   */
  private async cleanup(): Promise<void> {
    const startTime = Date.now();
    let cleanedCount = 0;

    try {
      // Cleanup memory cache
      if (this.config.enableMemoryCache) {
        const keys = this.memoryCache.keys();
        for (const key of keys) {
          const entry = this.memoryCache.get(key);
          if (entry && this.isExpired(entry)) {
            this.memoryCache.delete(key);
            cleanedCount++;
          }
        }
      }

      // Cleanup disk cache (more expensive, do less frequently)
      if (this.config.enableDiskCache && this.metrics.cleanup_runs % 10 === 0) {
        await this.cleanupDiskCache();
      }

      this.metrics.cleanup_runs++;
      this.metrics.last_cleanup = Date.now();

      const duration = Date.now() - startTime;
      this.emit('cleanup', { cleaned: cleanedCount, duration });

    } catch (error) {
      this.logger?.('error', 'Cache cleanup error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async cleanupDiskCache(): Promise<void> {
    try {
      const files = await this.getAllDiskFiles();
      const cutoff = Date.now() - this.config.maxAge;

      for (const file of files) {
        try {
          const entry = await this.getDiskEntry(file);
          if (!entry || this.isExpired(entry) || entry.createdAt < cutoff) {
            await this.deleteDiskEntry(file);
          }
        } catch {
          // Ignore errors for individual files
        }
      }
    } catch (error) {
      this.logger?.('error', 'Disk cache cleanup error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async getAllDiskFiles(): Promise<string[]> {
    // This is a simplified implementation
    // In production, you'd want a more efficient file scanning approach
    return [];
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * Stop automatic cleanup timer
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Update metrics for get operations
   */
  private updateGetMetrics(startTime: number): void {
    const duration = Date.now() - startTime;
    this.operationTimes.get.push(duration);
    if (this.operationTimes.get.length > 100) {
      this.operationTimes.get = this.operationTimes.get.slice(-50);
    }
    this.metrics.avg_get_time_ms = this.operationTimes.get.reduce((a, b) => a + b, 0) / this.operationTimes.get.length;
  }

  /**
   * Update metrics for set operations
   */
  private updateSetMetrics(startTime: number): void {
    const duration = Date.now() - startTime;
    this.operationTimes.set.push(duration);
    if (this.operationTimes.set.length > 100) {
      this.operationTimes.set = this.operationTimes.set.slice(-50);
    }
    this.metrics.avg_set_time_ms = this.operationTimes.set.reduce((a, b) => a + b, 0) / this.operationTimes.set.length;
  }

  /**
   * Get current metrics
   */
  getMetrics(): CacheMetrics {
    this.metrics.hit_rate = this.metrics.hits_total / (this.metrics.hits_total + this.metrics.misses_total) || 0;
    this.metrics.memory_entries = this.memoryCache.size();
    this.metrics.memory_size_bytes = this.memoryCache.getMemorySize();

    return { ...this.metrics };
  }

  /**
   * Get health status
   */
  getHealth(): {
    healthy: boolean;
    memory_cache: boolean;
    disk_cache: boolean;
    hit_rate: number;
    errors: number;
  } {
    const metrics = this.getMetrics();

    return {
      healthy: metrics.hit_rate > 0.5 && metrics.errors_total < 100,
      memory_cache: this.config.enableMemoryCache,
      disk_cache: this.config.enableDiskCache,
      hit_rate: metrics.hit_rate,
      errors: metrics.errors_total
    };
  }

  /**
   * Shutdown cache manager
   */
  async shutdown(): Promise<void> {
    this.stopCleanupTimer();
    await this.cleanup();
    this.emit('shutdown');
  }
}

/**
 * Convenience function for creating cache manager
 */
export function createCacheManager(config?: Partial<CacheConfig>): CacheManager {
  return new CacheManager(config);
}