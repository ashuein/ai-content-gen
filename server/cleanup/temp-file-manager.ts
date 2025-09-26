/**
 * Temporary File Manager
 * Automatic cleanup system for temporary files with TTL support
 * Prevents disk space exhaustion and ensures secure cleanup
 */

import { readdir, stat, unlink, rmdir, access, writeFile } from 'fs/promises';
import { join, extname, basename } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../../config/paths.js';

export interface TTLConfig {
  defaultTtlMs: number;
  checkIntervalMs: number;
  maxFileAge: number;
  maxDirectorySize: number; // bytes
  aggressiveCleanupThreshold: number; // percentage
  retentionPolicies: Record<string, number>; // file extension -> TTL in ms
}

export interface FileMetadata {
  path: string;
  size: number;
  createdAt: number;
  lastAccessed: number;
  ttl: number;
  expiresAt: number;
  fileType: string;
  checksum?: string;
  isProtected: boolean;
}

export interface CleanupResult {
  filesRemoved: number;
  bytesFreed: number;
  directoriesRemoved: number;
  errors: string[];
  duration: number;
  timestamp: string;
}

export interface DirectoryStats {
  path: string;
  totalFiles: number;
  totalSize: number;
  oldestFile: number;
  newestFile: number;
  filesByType: Record<string, number>;
  averageAge: number;
}

const DEFAULT_TTL_CONFIG: TTLConfig = {
  defaultTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  checkIntervalMs: 30 * 60 * 1000, // 30 minutes
  maxFileAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxDirectorySize: 1024 * 1024 * 1024, // 1GB
  aggressiveCleanupThreshold: 80, // 80% full triggers aggressive cleanup
  retentionPolicies: {
    '.tmp': 1 * 60 * 60 * 1000, // 1 hour
    '.temp': 2 * 60 * 60 * 1000, // 2 hours
    '.log': 7 * 24 * 60 * 60 * 1000, // 7 days
    '.json': 24 * 60 * 60 * 1000, // 24 hours
    '.cache': 3 * 24 * 60 * 60 * 1000, // 3 days
    '.svg': 12 * 60 * 60 * 1000, // 12 hours
    '.png': 6 * 60 * 60 * 1000, // 6 hours
    '.txt': 24 * 60 * 60 * 1000, // 24 hours
    '.lock': 5 * 60 * 1000, // 5 minutes (locks should be short-lived)
    '.meta': 24 * 60 * 60 * 1000 // 24 hours
  }
};

/**
 * Temporary file management and cleanup system
 */
export class TempFileManager {
  private config: TTLConfig;
  private cleanupTimer?: NodeJS.Timeout;
  private managedDirectories: string[];
  private isCleanupRunning: boolean = false;
  private cleanupHistory: CleanupResult[] = [];
  private protectedFiles: Set<string> = new Set();

  constructor(config: Partial<TTLConfig> = {}) {
    this.config = { ...DEFAULT_TTL_CONFIG, ...config };
    this.managedDirectories = [
      join(PATHS.ROOT_DIR, PATHS.TEMP_DIR),
      join(PATHS.ROOT_DIR, PATHS.CACHE_DIR),
      join(PATHS.ROOT_DIR, 'temp/uploads'),
      join(PATHS.ROOT_DIR, '.cache/idempotency'),
      join(PATHS.ROOT_DIR, '.cache/locks'),
      join(PATHS.ROOT_DIR, '.cache/backups')
    ];

    this.startCleanupTimer();
  }

  /**
   * Create temporary file with automatic TTL
   */
  async createTempFile(
    content: string | Buffer,
    options: {
      directory?: string;
      prefix?: string;
      suffix?: string;
      ttl?: number;
      isProtected?: boolean;
    } = {}
  ): Promise<{ path: string; metadata: FileMetadata }> {
    const {
      directory = join(PATHS.ROOT_DIR, PATHS.TEMP_DIR),
      prefix = 'temp',
      suffix = '.tmp',
      ttl = this.getTTLForFileType(suffix),
      isProtected = false
    } = options;

    // Generate unique filename
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2);
    const filename = `${prefix}_${timestamp}_${random}${suffix}`;
    const filePath = join(directory, filename);

    // Calculate checksum
    const checksum = createHash('sha256').update(content).digest('hex');

    // Create metadata
    const metadata: FileMetadata = {
      path: filePath,
      size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content),
      createdAt: timestamp,
      lastAccessed: timestamp,
      ttl,
      expiresAt: timestamp + ttl,
      fileType: suffix,
      checksum,
      isProtected
    };

    // Write file
    await writeFile(filePath, content);

    // Write metadata
    await this.writeFileMetadata(filePath, metadata);

    // Protect file if requested
    if (isProtected) {
      this.protectedFiles.add(filePath);
    }

    return { path: filePath, metadata };
  }

  /**
   * Mark file as protected from cleanup
   */
  protectFile(filePath: string): void {
    this.protectedFiles.add(filePath);
  }

  /**
   * Remove protection from file
   */
  unprotectFile(filePath: string): void {
    this.protectedFiles.delete(filePath);
  }

  /**
   * Update file access time (extends TTL)
   */
  async touchFile(filePath: string): Promise<boolean> {
    try {
      const metadata = await this.readFileMetadata(filePath);
      if (!metadata) return false;

      metadata.lastAccessed = Date.now();
      // Extend expiration by half the original TTL
      metadata.expiresAt = Math.max(metadata.expiresAt, Date.now() + metadata.ttl / 2);

      await this.writeFileMetadata(filePath, metadata);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run cleanup process
   */
  async runCleanup(aggressive: boolean = false): Promise<CleanupResult> {
    if (this.isCleanupRunning) {
      throw new Error('Cleanup already in progress');
    }

    this.isCleanupRunning = true;
    const startTime = Date.now();

    const result: CleanupResult = {
      filesRemoved: 0,
      bytesFreed: 0,
      directoriesRemoved: 0,
      errors: [],
      duration: 0,
      timestamp: new Date().toISOString()
    };

    try {
      for (const directory of this.managedDirectories) {
        try {
          await access(directory);
          const dirResult = await this.cleanupDirectory(directory, aggressive);

          result.filesRemoved += dirResult.filesRemoved;
          result.bytesFreed += dirResult.bytesFreed;
          result.directoriesRemoved += dirResult.directoriesRemoved;
          result.errors.push(...dirResult.errors);

        } catch (error) {
          result.errors.push(`Failed to access directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      result.duration = Date.now() - startTime;

      // Store cleanup history
      this.cleanupHistory.push(result);
      if (this.cleanupHistory.length > 100) {
        this.cleanupHistory = this.cleanupHistory.slice(-50);
      }

      console.log(`Cleanup completed: ${result.filesRemoved} files removed, ${(result.bytesFreed / 1024 / 1024).toFixed(2)}MB freed`);

      return result;

    } finally {
      this.isCleanupRunning = false;
    }
  }

  /**
   * Get directory statistics
   */
  async getDirectoryStats(directory: string): Promise<DirectoryStats> {
    const files = await this.scanDirectory(directory);
    const now = Date.now();

    let totalSize = 0;
    let oldestFile = now;
    let newestFile = 0;
    const filesByType: Record<string, number> = {};
    let totalAge = 0;

    for (const file of files) {
      totalSize += file.size;
      oldestFile = Math.min(oldestFile, file.createdAt);
      newestFile = Math.max(newestFile, file.createdAt);
      totalAge += (now - file.createdAt);

      const ext = extname(file.path).toLowerCase();
      filesByType[ext] = (filesByType[ext] || 0) + 1;
    }

    return {
      path: directory,
      totalFiles: files.length,
      totalSize,
      oldestFile,
      newestFile,
      filesByType,
      averageAge: files.length > 0 ? totalAge / files.length : 0
    };
  }

  /**
   * Get cleanup statistics
   */
  getCleanupStats(): {
    lastCleanup?: CleanupResult;
    totalCleanupsRun: number;
    totalFilesRemoved: number;
    totalBytesFreed: number;
    averageCleanupTime: number;
    isRunning: boolean;
  } {
    const totalFilesRemoved = this.cleanupHistory.reduce((sum, r) => sum + r.filesRemoved, 0);
    const totalBytesFreed = this.cleanupHistory.reduce((sum, r) => sum + r.bytesFreed, 0);
    const totalTime = this.cleanupHistory.reduce((sum, r) => sum + r.duration, 0);

    return {
      lastCleanup: this.cleanupHistory[this.cleanupHistory.length - 1],
      totalCleanupsRun: this.cleanupHistory.length,
      totalFilesRemoved,
      totalBytesFreed,
      averageCleanupTime: this.cleanupHistory.length > 0 ? totalTime / this.cleanupHistory.length : 0,
      isRunning: this.isCleanupRunning
    };
  }

  /**
   * Force cleanup of specific directory
   */
  async forceCleanupDirectory(directory: string): Promise<CleanupResult> {
    return this.cleanupDirectory(directory, true);
  }

  /**
   * Scan directory for managed files
   */
  async scanDirectory(directory: string): Promise<FileMetadata[]> {
    const files: FileMetadata[] = [];

    try {
      const entries = await readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(directory, entry.name);

        if (entry.isFile()) {
          const metadata = await this.getFileMetadata(fullPath);
          if (metadata) {
            files.push(metadata);
          }
        } else if (entry.isDirectory()) {
          // Recursively scan subdirectories
          const subFiles = await this.scanDirectory(fullPath);
          files.push(...subFiles);
        }
      }
    } catch (error) {
      console.warn(`Failed to scan directory ${directory}:`, error);
    }

    return files;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<TTLConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Restart timer if interval changed
    if (newConfig.checkIntervalMs && this.cleanupTimer) {
      this.stopCleanupTimer();
      this.startCleanupTimer();
    }
  }

  /**
   * Stop cleanup timer and clean up resources
   */
  async destroy(): Promise<void> {
    this.stopCleanupTimer();

    // Wait for any running cleanup to finish
    while (this.isCleanupRunning) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Private helper methods
   */
  private async cleanupDirectory(directory: string, aggressive: boolean): Promise<CleanupResult> {
    const result: CleanupResult = {
      filesRemoved: 0,
      bytesFreed: 0,
      directoriesRemoved: 0,
      errors: [],
      duration: 0,
      timestamp: new Date().toISOString()
    };

    try {
      const files = await this.scanDirectory(directory);
      const now = Date.now();

      // Check if aggressive cleanup is needed
      const stats = await this.getDirectoryStats(directory);
      const usage = (stats.totalSize / this.config.maxDirectorySize) * 100;
      const shouldBeAggressive = aggressive || usage > this.config.aggressiveCleanupThreshold;

      for (const file of files) {
        try {
          // Skip protected files
          if (this.protectedFiles.has(file.path)) {
            continue;
          }

          // Check if file should be removed
          const shouldRemove = this.shouldRemoveFile(file, now, shouldBeAggressive);

          if (shouldRemove) {
            await this.removeFile(file.path);
            result.filesRemoved++;
            result.bytesFreed += file.size;
          }

        } catch (error) {
          result.errors.push(`Failed to remove ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Remove empty directories
      await this.removeEmptyDirectories(directory, result);

    } catch (error) {
      result.errors.push(`Directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
  }

  private shouldRemoveFile(file: FileMetadata, now: number, aggressive: boolean): boolean {
    // Always remove if expired
    if (now > file.expiresAt) {
      return true;
    }

    // In aggressive mode, remove old files even if not expired
    if (aggressive) {
      const age = now - file.createdAt;
      const ageThreshold = this.config.maxFileAge * 0.5; // 50% of max age

      if (age > ageThreshold) {
        return true;
      }
    }

    return false;
  }

  private async removeFile(filePath: string): Promise<void> {
    // Remove metadata file first
    const metadataPath = `${filePath}.meta`;
    await unlink(metadataPath).catch(() => {}); // Ignore if doesn't exist

    // Remove actual file
    await unlink(filePath);

    // Remove from protected set
    this.protectedFiles.delete(filePath);
  }

  private async removeEmptyDirectories(directory: string, result: CleanupResult): Promise<void> {
    try {
      const entries = await readdir(directory);

      // Process subdirectories first
      for (const entry of entries) {
        const fullPath = join(directory, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          await this.removeEmptyDirectories(fullPath, result);

          // Check if directory is empty after recursive cleanup
          const subEntries = await readdir(fullPath);
          if (subEntries.length === 0) {
            await rmdir(fullPath);
            result.directoriesRemoved++;
          }
        }
      }
    } catch (error) {
      result.errors.push(`Failed to remove empty directories in ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getFileMetadata(filePath: string): Promise<FileMetadata | null> {
    try {
      // Try to read existing metadata
      const metadata = await this.readFileMetadata(filePath);
      if (metadata) {
        return metadata;
      }

      // Create metadata for files without it
      const stats = await stat(filePath);
      const ext = extname(filePath).toLowerCase();

      return {
        path: filePath,
        size: stats.size,
        createdAt: stats.birthtime?.getTime() || stats.mtime.getTime(),
        lastAccessed: stats.atime.getTime(),
        ttl: this.getTTLForFileType(ext),
        expiresAt: (stats.birthtime?.getTime() || stats.mtime.getTime()) + this.getTTLForFileType(ext),
        fileType: ext,
        isProtected: this.protectedFiles.has(filePath)
      };

    } catch {
      return null;
    }
  }

  private async readFileMetadata(filePath: string): Promise<FileMetadata | null> {
    try {
      const metadataPath = `${filePath}.meta`;
      const data = await import('fs/promises').then(fs => fs.readFile(metadataPath, 'utf8'));
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async writeFileMetadata(filePath: string, metadata: FileMetadata): Promise<void> {
    const metadataPath = `${filePath}.meta`;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  private getTTLForFileType(extension: string): number {
    return this.config.retentionPolicies[extension.toLowerCase()] || this.config.defaultTtlMs;
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.runCleanup();
      } catch (error) {
        console.error('Scheduled cleanup failed:', error);
      }
    }, this.config.checkIntervalMs);
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

// Export singleton instance
export const tempFileManager = new TempFileManager();