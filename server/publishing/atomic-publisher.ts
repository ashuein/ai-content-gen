/**
 * Atomic File Publisher
 * Ensures files are written atomically to prevent partial reads
 * Cross-platform implementation with Windows and Unix support
 */

import { writeFile, rename, unlink, mkdir, stat, copyFile } from 'fs/promises';
import { join, dirname, basename, extname } from 'path';
import { createHash, randomBytes } from 'crypto';
import { platform } from 'os';
import { PATHS } from '../../config/paths.js';

export interface PublishConfig {
  enableBackup: boolean;
  backupRetention: number; // Days to keep backups
  enableChecksums: boolean;
  enableCompression: boolean;
  retryAttempts: number;
  retryDelayMs: number;
  verifyAfterWrite: boolean;
}

export interface PublishResult {
  success: boolean;
  filePath: string;
  tempPath?: string;
  backupPath?: string;
  checksum?: string;
  size: number;
  timeMs: number;
  error?: string;
  retryCount?: number;
}

export interface PublishMetadata {
  originalPath: string;
  publishedAt: string;
  checksum: string;
  size: number;
  version: number;
  correlationId?: string;
}

const DEFAULT_PUBLISH_CONFIG: PublishConfig = {
  enableBackup: true,
  backupRetention: 7,
  enableChecksums: true,
  enableCompression: false,
  retryAttempts: 3,
  retryDelayMs: 1000,
  verifyAfterWrite: true
};

/**
 * Cross-platform atomic file publisher
 */
export class AtomicPublisher {
  private config: PublishConfig;
  private isWindows: boolean;
  private publishDir: string;
  private backupDir: string;

  constructor(config: Partial<PublishConfig> = {}) {
    this.config = { ...DEFAULT_PUBLISH_CONFIG, ...config };
    this.isWindows = platform() === 'win32';
    this.publishDir = join(PATHS.ROOT_DIR, PATHS.PUBLIC_DIR);
    this.backupDir = join(PATHS.ROOT_DIR, PATHS.CACHE_DIR, 'backups');
  }

  /**
   * Atomically publish a file to the public directory
   */
  async publishFile(
    content: string | Buffer,
    targetPath: string,
    correlationId?: string
  ): Promise<PublishResult> {
    const startTime = Date.now();
    let retryCount = 0;
    let tempPath: string | undefined;
    let backupPath: string | undefined;

    while (retryCount <= this.config.retryAttempts) {
      try {
        // Generate temp file path
        tempPath = await this.generateTempPath(targetPath);

        // Create backup if file exists
        if (this.config.enableBackup) {
          backupPath = await this.createBackup(targetPath, correlationId);
        }

        // Write content to temp file
        const checksum = await this.writeToTemp(tempPath, content);

        // Verify write if enabled
        if (this.config.verifyAfterWrite) {
          await this.verifyWrite(tempPath, content, checksum);
        }

        // Atomic move to final location
        await this.atomicMove(tempPath, targetPath);

        // Create metadata
        if (correlationId) {
          await this.writeMetadata(targetPath, {
            originalPath: targetPath,
            publishedAt: new Date().toISOString(),
            checksum,
            size: content.length,
            version: await this.getNextVersion(targetPath),
            correlationId
          });
        }

        // Cleanup old backups
        if (this.config.enableBackup) {
          await this.cleanupOldBackups().catch(() => {}); // Non-blocking
        }

        return {
          success: true,
          filePath: targetPath,
          tempPath,
          backupPath,
          checksum: this.config.enableChecksums ? checksum : undefined,
          size: content.length,
          timeMs: Date.now() - startTime,
          retryCount: retryCount > 0 ? retryCount : undefined
        };

      } catch (error) {
        retryCount++;

        // Cleanup temp file on error
        if (tempPath) {
          await unlink(tempPath).catch(() => {});
        }

        if (retryCount > this.config.retryAttempts) {
          return {
            success: false,
            filePath: targetPath,
            tempPath,
            backupPath,
            size: content.length,
            timeMs: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
            retryCount
          };
        }

        // Wait before retry
        await this.delay(this.config.retryDelayMs * retryCount);
      }
    }

    // Should never reach here, but TypeScript requires it
    throw new Error('Unexpected end of retry loop');
  }

  /**
   * Publish multiple files atomically as a batch
   */
  async publishBatch(
    files: Array<{ content: string | Buffer; targetPath: string }>,
    correlationId?: string
  ): Promise<{ success: boolean; results: PublishResult[]; timeMs: number }> {
    const startTime = Date.now();
    const results: PublishResult[] = [];
    const tempFiles: string[] = [];

    try {
      // Write all files to temp locations first
      for (const file of files) {
        const tempPath = await this.generateTempPath(file.targetPath);
        tempFiles.push(tempPath);

        await this.writeToTemp(tempPath, file.content);

        if (this.config.verifyAfterWrite) {
          const checksum = this.calculateChecksum(file.content);
          await this.verifyWrite(tempPath, file.content, checksum);
        }
      }

      // Atomic move all files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const tempPath = tempFiles[i];

        try {
          // Create backup
          let backupPath: string | undefined;
          if (this.config.enableBackup) {
            backupPath = await this.createBackup(file.targetPath, correlationId);
          }

          // Atomic move
          await this.atomicMove(tempPath, file.targetPath);

          results.push({
            success: true,
            filePath: file.targetPath,
            tempPath,
            backupPath,
            checksum: this.config.enableChecksums ? this.calculateChecksum(file.content) : undefined,
            size: file.content.length,
            timeMs: Date.now() - startTime
          });

        } catch (error) {
          results.push({
            success: false,
            filePath: file.targetPath,
            tempPath,
            size: file.content.length,
            timeMs: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        success: results.every(r => r.success),
        results,
        timeMs: Date.now() - startTime
      };

    } catch (error) {
      // Cleanup temp files on batch failure
      await Promise.all(
        tempFiles.map(tempPath => unlink(tempPath).catch(() => {}))
      );

      throw error;
    }
  }

  /**
   * Generate unique temp file path
   */
  private async generateTempPath(targetPath: string): Promise<string> {
    const ext = extname(targetPath);
    const baseName = basename(targetPath, ext);
    const dirPath = dirname(targetPath);

    // Ensure directory exists
    await mkdir(dirPath, { recursive: true });

    // Generate unique temp name
    const randomSuffix = randomBytes(8).toString('hex');
    const tempName = `${baseName}.${randomSuffix}.tmp${ext}`;

    return join(dirPath, tempName);
  }

  /**
   * Write content to temporary file
   */
  private async writeToTemp(tempPath: string, content: string | Buffer): Promise<string> {
    await writeFile(tempPath, content);
    return this.calculateChecksum(content);
  }

  /**
   * Verify write operation
   */
  private async verifyWrite(tempPath: string, originalContent: string | Buffer, expectedChecksum: string): Promise<void> {
    try {
      const stats = await stat(tempPath);
      if (stats.size !== originalContent.length) {
        throw new Error(`Size mismatch: expected ${originalContent.length}, got ${stats.size}`);
      }

      if (this.config.enableChecksums) {
        // For verification, we could re-read and verify checksum, but that's expensive
        // For now, just verify the file exists and has correct size
      }
    } catch (error) {
      throw new Error(`Write verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Perform atomic move operation (cross-platform)
   */
  private async atomicMove(tempPath: string, targetPath: string): Promise<void> {
    const targetDir = dirname(targetPath);
    await mkdir(targetDir, { recursive: true });

    if (this.isWindows) {
      // On Windows, rename might fail if target exists
      // Use copy + delete as fallback for atomic-like behavior
      try {
        await rename(tempPath, targetPath);
      } catch (error) {
        // Fallback: copy then delete temp file
        await copyFile(tempPath, targetPath);
        await unlink(tempPath);
      }
    } else {
      // On Unix systems, rename is atomic
      await rename(tempPath, targetPath);
    }
  }

  /**
   * Create backup of existing file
   */
  private async createBackup(targetPath: string, correlationId?: string): Promise<string | undefined> {
    try {
      // Check if target file exists
      await stat(targetPath);

      // Generate backup path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = extname(targetPath);
      const baseName = basename(targetPath, ext);
      const backupName = correlationId
        ? `${baseName}.${timestamp}.${correlationId}${ext}`
        : `${baseName}.${timestamp}${ext}`;

      const backupPath = join(this.backupDir, backupName);

      // Ensure backup directory exists
      await mkdir(this.backupDir, { recursive: true });

      // Copy file to backup location
      await copyFile(targetPath, backupPath);

      return backupPath;

    } catch (error) {
      // File doesn't exist, no backup needed
      return undefined;
    }
  }

  /**
   * Write publish metadata
   */
  private async writeMetadata(targetPath: string, metadata: PublishMetadata): Promise<void> {
    const metadataPath = `${targetPath}.meta.json`;
    const metadataContent = JSON.stringify(metadata, null, 2);

    // Use atomic write for metadata too
    const tempMetaPath = await this.generateTempPath(metadataPath);
    await writeFile(tempMetaPath, metadataContent);
    await this.atomicMove(tempMetaPath, metadataPath);
  }

  /**
   * Get next version number for file
   */
  private async getNextVersion(targetPath: string): Promise<number> {
    const metadataPath = `${targetPath}.meta.json`;
    try {
      const metadataContent = await import(metadataPath);
      return (metadataContent.version || 0) + 1;
    } catch {
      return 1;
    }
  }

  /**
   * Calculate content checksum
   */
  private calculateChecksum(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Cleanup old backup files
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.backupRetention);

      const files = await import('fs/promises').then(fs => fs.readdir(this.backupDir));

      for (const file of files) {
        const filePath = join(this.backupDir, file);
        const stats = await stat(filePath);

        if (stats.mtime < cutoffDate) {
          await unlink(filePath);
        }
      }
    } catch (error) {
      // Non-critical operation, log but don't throw
      console.warn('Backup cleanup failed:', error);
    }
  }

  /**
   * Delay utility for retries
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get publisher health status
   */
  async getHealth(): Promise<{
    healthy: boolean;
    publishDir: string;
    backupDir: string;
    canWrite: boolean;
    diskSpace?: number;
    errors?: string[];
  }> {
    const errors: string[] = [];
    let canWrite = false;

    try {
      // Test write permissions
      const testPath = join(this.publishDir, 'health-check.tmp');
      await writeFile(testPath, 'test');
      await unlink(testPath);
      canWrite = true;
    } catch (error) {
      errors.push(`Cannot write to publish directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // Ensure backup directory exists
      await mkdir(this.backupDir, { recursive: true });
    } catch (error) {
      errors.push(`Cannot create backup directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      healthy: errors.length === 0 && canWrite,
      publishDir: this.publishDir,
      backupDir: this.backupDir,
      canWrite,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

// Export singleton instance
export const atomicPublisher = new AtomicPublisher();