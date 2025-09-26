/**
 * Shared Cache System
 * Two-tier cache with memory and disk storage for maximum performance
 * Shared between API endpoints and build scripts
 */

import { readFile, writeFile, mkdir, readdir, unlink, access, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../../config/paths';

export interface CacheEntry<T = any> {
  data: T;
  expires: number;
  created: number;
  hits: number;
  size: number; // Approximate size in bytes
}

export interface CacheConfig {
  maxMemorySize: number;    // Max memory cache size in bytes
  maxDiskSize: number;      // Max disk cache size in bytes
  defaultTtl: number;       // Default TTL in milliseconds
  cleanupInterval: number;  // Cleanup interval in milliseconds
  enableCompression: boolean; // Compress disk cache entries
}

export interface CacheStats {
  memoryHits: number;
  diskHits: number;
  misses: number;
  memorySize: number;
  diskSize: number;
  totalEntries: number;
  memoryEntries: number;
  diskEntries: number;
  hitRate: number;
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxMemorySize: 100 * 1024 * 1024,    // 100MB
  maxDiskSize: 1024 * 1024 * 1024,     // 1GB
  defaultTtl: 3600000,                 // 1 hour
  cleanupInterval: 300000,             // 5 minutes
  enableCompression: true
};

export class SharedCache {
  private config: CacheConfig;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private diskCacheDir: string;
  private stats: CacheStats = {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    memorySize: 0,
    diskSize: 0,
    totalEntries: 0,
    memoryEntries: 0,
    diskEntries: 0,
    hitRate: 0
  };
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    this.diskCacheDir = join(PATHS.CACHE_DIR, 'shared');

    this.initializeCache();
    this.startCleanupTimer();
  }

  /**
   * Initialize cache directory
   */
  private async initializeCache(): Promise<void> {
    try {
      await mkdir(this.diskCacheDir, { recursive: true });

      // Load initial disk cache stats
      await this.updateDiskStats();

    } catch (error) {
      console.error('Failed to initialize cache:', error);
    }
  }

  /**
   * Get value from cache (checks memory first, then disk)
   */
  async get<T = any>(key: string): Promise<T | null> {
    const hashedKey = this.hashKey(key);

    // Check memory cache first
    const memoryEntry = this.memoryCache.get(hashedKey);
    if (memoryEntry && this.isValid(memoryEntry)) {
      memoryEntry.hits++;
      this.stats.memoryHits++;
      this.updateHitRate();
      return memoryEntry.data as T;
    }

    // Remove expired memory entry
    if (memoryEntry && !this.isValid(memoryEntry)) {
      this.memoryCache.delete(hashedKey);
      this.updateMemoryStats();
    }

    // Check disk cache
    try {
      const diskPath = this.getDiskPath(hashedKey);
      const diskData = await readFile(diskPath, 'utf8');
      const diskEntry: CacheEntry<T> = JSON.parse(diskData);

      if (this.isValid(diskEntry)) {
        diskEntry.hits++;
        this.stats.diskHits++;
        this.updateHitRate();

        // Promote frequently accessed items to memory cache
        if (diskEntry.hits >= 3) {
          await this.promoteToMemory(hashedKey, diskEntry);
        }

        // Update disk entry hit count
        await writeFile(diskPath, JSON.stringify(diskEntry));

        return diskEntry.data;
      } else {
        // Remove expired disk entry
        await unlink(diskPath).catch(() => {}); // Ignore errors
      }
    } catch (error) {
      // Entry doesn't exist or is corrupted - this is normal
    }

    this.stats.misses++;
    this.updateHitRate();
    return null;
  }

  /**
   * Set value in cache
   */
  async set<T = any>(key: string, data: T, ttl: number = this.config.defaultTtl): Promise<void> {
    const hashedKey = this.hashKey(key);
    const now = Date.now();
    const dataString = JSON.stringify(data);
    const entry: CacheEntry<T> = {
      data,
      expires: now + ttl,
      created: now,
      hits: 0,
      size: dataString.length
    };

    // Always try to put in memory cache first
    await this.setInMemory(hashedKey, entry);

    // Also write to disk for persistence
    await this.setOnDisk(hashedKey, entry);

    this.updateTotalStats();
  }

  /**
   * Delete key from both memory and disk cache
   */
  async delete(key: string): Promise<boolean> {
    const hashedKey = this.hashKey(key);
    let deleted = false;

    // Remove from memory
    if (this.memoryCache.delete(hashedKey)) {
      deleted = true;
      this.updateMemoryStats();
    }

    // Remove from disk
    try {
      await unlink(this.getDiskPath(hashedKey));
      deleted = true;
      await this.updateDiskStats();
    } catch (error) {
      // File might not exist
    }

    return deleted;
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    // Clear memory cache
    this.memoryCache.clear();
    this.stats.memorySize = 0;
    this.stats.memoryEntries = 0;

    // Clear disk cache
    try {
      const files = await readdir(this.diskCacheDir);
      await Promise.all(
        files.map(file =>
          unlink(join(this.diskCacheDir, file)).catch(() => {})
        )
      );
      this.stats.diskSize = 0;
      this.stats.diskEntries = 0;
    } catch (error) {
      console.error('Failed to clear disk cache:', error);
    }

    this.updateTotalStats();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get health status of cache
   */
  async getHealth(): Promise<{
    healthy: boolean;
    memoryUsage: number;
    diskUsage: number;
    hitRate: number;
    errors?: string[];
  }> {
    const errors: string[] = [];

    try {
      await access(this.diskCacheDir);
    } catch (error) {
      errors.push(`Disk cache directory not accessible: ${error instanceof Error ? error.message : String(error)}`);
    }

    const memoryUsage = this.stats.memorySize / this.config.maxMemorySize;
    const diskUsage = this.stats.diskSize / this.config.maxDiskSize;

    return {
      healthy: errors.length === 0 && memoryUsage < 0.9 && diskUsage < 0.9,
      memoryUsage,
      diskUsage,
      hitRate: this.stats.hitRate,
      ...(errors.length > 0 && { errors })
    };
  }

  /**
   * Hash cache key for consistent storage
   */
  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /**
   * Check if cache entry is still valid
   */
  private isValid(entry: CacheEntry): boolean {
    return Date.now() < entry.expires;
  }

  /**
   * Get disk cache file path
   */
  private getDiskPath(hashedKey: string): string {
    return join(this.diskCacheDir, `${hashedKey}.json`);
  }

  /**
   * Set entry in memory cache with LRU eviction
   */
  private async setInMemory<T>(hashedKey: string, entry: CacheEntry<T>): Promise<void> {
    // Check if we need to evict entries
    while (this.stats.memorySize + entry.size > this.config.maxMemorySize && this.memoryCache.size > 0) {
      await this.evictLeastRecentlyUsed();
    }

    this.memoryCache.set(hashedKey, entry);
    this.updateMemoryStats();
  }

  /**
   * Set entry on disk
   */
  private async setOnDisk<T>(hashedKey: string, entry: CacheEntry<T>): Promise<void> {
    try {
      const diskPath = this.getDiskPath(hashedKey);
      await writeFile(diskPath, JSON.stringify(entry));
      await this.updateDiskStats();

      // Cleanup disk if needed
      if (this.stats.diskSize > this.config.maxDiskSize) {
        await this.cleanupDiskCache();
      }
    } catch (error) {
      console.error('Failed to write to disk cache:', error);
    }
  }

  /**
   * Promote frequently accessed disk entries to memory
   */
  private async promoteToMemory<T>(hashedKey: string, entry: CacheEntry<T>): Promise<void> {
    if (this.stats.memorySize + entry.size <= this.config.maxMemorySize) {
      this.memoryCache.set(hashedKey, entry);
      this.updateMemoryStats();
    }
  }

  /**
   * Evict least recently used entry from memory
   */
  private async evictLeastRecentlyUsed(): Promise<void> {
    let oldestKey = '';
    let oldestTime = Date.now();

    for (const [key, entry] of Array.from(this.memoryCache.entries())) {
      if (entry.created < oldestTime) {
        oldestTime = entry.created;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.memoryCache.delete(oldestKey);
      this.updateMemoryStats();
    }
  }

  /**
   * Clean up expired disk cache entries
   */
  private async cleanupDiskCache(): Promise<void> {
    try {
      const files = await readdir(this.diskCacheDir);
      const now = Date.now();

      for (const file of files) {
        const filePath = join(this.diskCacheDir, file);
        try {
          const data = await readFile(filePath, 'utf8');
          const entry: CacheEntry = JSON.parse(data);

          if (now >= entry.expires) {
            await unlink(filePath);
          }
        } catch (error) {
          // Remove corrupted files
          await unlink(filePath).catch(() => {});
        }
      }

      await this.updateDiskStats();
    } catch (error) {
      console.error('Disk cache cleanup failed:', error);
    }
  }

  /**
   * Update memory cache statistics
   */
  private updateMemoryStats(): void {
    this.stats.memoryEntries = this.memoryCache.size;
    this.stats.memorySize = Array.from(this.memoryCache.values())
      .reduce((total, entry) => total + entry.size, 0);
  }

  /**
   * Update disk cache statistics
   */
  private async updateDiskStats(): Promise<void> {
    try {
      const files = await readdir(this.diskCacheDir);
      this.stats.diskEntries = files.length;

      // Calculate total disk size
      let totalSize = 0;
      for (const file of files) {
        try {
          const stats = await stat(join(this.diskCacheDir, file));
          totalSize += stats.size;
        } catch (error) {
          // File might have been deleted, ignore
        }
      }
      this.stats.diskSize = totalSize;
    } catch (error) {
      console.error('Failed to update disk stats:', error);
    }
  }

  /**
   * Update total statistics
   */
  private updateTotalStats(): void {
    this.stats.totalEntries = this.stats.memoryEntries + this.stats.diskEntries;
  }

  /**
   * Update hit rate calculation
   */
  private updateHitRate(): void {
    const totalRequests = this.stats.memoryHits + this.stats.diskHits + this.stats.misses;
    if (totalRequests > 0) {
      this.stats.hitRate = (this.stats.memoryHits + this.stats.diskHits) / totalRequests;
    }
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      await this.cleanupDiskCache();
    }, this.config.cleanupInterval);
  }

  /**
   * Stop cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}

// Export singleton instance
export const sharedCache = new SharedCache();

/**
 * Utility functions for cache key generation
 */
export const cacheKeys = {
  /**
   * Generate cache key for compilation results
   */
  compile: (type: string, identifier: string): string =>
    `compile:${type}:${identifier}`,

  /**
   * Generate cache key for spec files
   */
  spec: (specPath: string, checksum: string): string =>
    `spec:${specPath}:${checksum}`,

  /**
   * Generate cache key for rendered chapters
   */
  chapter: (promptId: string, version: string): string =>
    `chapter:${promptId}:${version}`,

  /**
   * Generate cache key for pipeline results
   */
  pipeline: (inputHash: string, modelParams: string): string =>
    `pipeline:${inputHash}:${modelParams}`
};