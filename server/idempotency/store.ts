/**
 * Idempotency Store
 * Prevents duplicate processing by tracking request signatures and attachment checksums
 * Handles file attachment validation and deduplication
 */

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { join, extname } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../../config/paths.js';
import { sharedCache, cacheKeys } from '../cache/shared-cache.js';

export interface IdempotencyKey {
  requestId: string;
  operationType: 'compile' | 'generate' | 'render';
  inputHash: string;
  attachmentHashes?: string[];
  timestamp: number;
  ttl: number;
}

export interface IdempotencyRecord {
  key: IdempotencyKey;
  status: 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  startTime: number;
  endTime?: number;
  correlationId?: string;
  metadata?: {
    userId?: string;
    sessionId?: string;
    apiVersion?: string;
  };
}

export interface AttachmentInfo {
  fileId: string;
  filename: string;
  checksum: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  validatedAt?: string;
  isValid?: boolean;
  validationErrors?: string[];
}

export interface IdempotencyConfig {
  defaultTtl: number; // milliseconds
  maxAttachmentSize: number; // bytes
  allowedExtensions: string[];
  storageDir: string;
  enableAttachmentValidation: boolean;
  enableDeduplication: boolean;
  maxConcurrentRequests: number;
}

const DEFAULT_CONFIG: IdempotencyConfig = {
  defaultTtl: 3600000, // 1 hour
  maxAttachmentSize: 10 * 1024 * 1024, // 10MB
  allowedExtensions: ['.json', '.txt', '.md', '.csv', '.yaml', '.yml'],
  storageDir: join(PATHS.CACHE_DIR, 'idempotency'),
  enableAttachmentValidation: true,
  enableDeduplication: true,
  maxConcurrentRequests: 100
};

/**
 * Idempotency store with attachment handling
 */
export class IdempotencyStore {
  private config: IdempotencyConfig;
  private recordsDir: string;
  private attachmentsDir: string;
  private activeRequests: Map<string, Promise<any>> = new Map();

  constructor(config: Partial<IdempotencyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.recordsDir = join(this.config.storageDir, 'records');
    this.attachmentsDir = join(this.config.storageDir, 'attachments');
  }

  /**
   * Initialize storage directories
   */
  async initialize(): Promise<void> {
    await mkdir(this.recordsDir, { recursive: true });
    await mkdir(this.attachmentsDir, { recursive: true });
  }

  /**
   * Generate idempotency key from request
   */
  generateKey(
    operationType: IdempotencyRecord['key']['operationType'],
    inputData: any,
    attachmentIds?: string[],
    customTtl?: number
  ): IdempotencyKey {
    // Create deterministic hash of input data
    const inputHash = this.hashObject(inputData);

    // Hash attachment IDs if provided
    let attachmentHashes: string[] | undefined;
    if (attachmentIds && attachmentIds.length > 0) {
      attachmentHashes = attachmentIds.map(id => this.hashString(id));
    }

    // Generate unique request ID
    const requestId = this.generateRequestId(operationType, inputHash, attachmentHashes);

    return {
      requestId,
      operationType,
      inputHash,
      attachmentHashes,
      timestamp: Date.now(),
      ttl: customTtl || this.config.defaultTtl
    };
  }

  /**
   * Check if request is duplicate and return existing result
   */
  async checkDuplicate(key: IdempotencyKey): Promise<IdempotencyRecord | null> {
    if (!this.config.enableDeduplication) {
      return null;
    }

    // Check in-memory cache first
    const cacheKey = cacheKeys.compile('idempotency', key.requestId);
    const cached = await sharedCache.get<IdempotencyRecord>(cacheKey);
    if (cached && this.isRecordValid(cached)) {
      return cached;
    }

    // Check persistent storage
    const recordPath = this.getRecordPath(key.requestId);
    try {
      const recordData = await readFile(recordPath, 'utf8');
      const record: IdempotencyRecord = JSON.parse(recordData);

      if (this.isRecordValid(record)) {
        // Cache the valid record
        await sharedCache.set(cacheKey, record, record.key.ttl);
        return record;
      } else {
        // Remove expired record
        await unlink(recordPath).catch(() => {});
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Register new request to prevent duplicates
   */
  async registerRequest(
    key: IdempotencyKey,
    correlationId?: string,
    metadata?: IdempotencyRecord['metadata']
  ): Promise<IdempotencyRecord> {
    // Check if we're at capacity
    if (this.activeRequests.size >= this.config.maxConcurrentRequests) {
      throw new Error('Maximum concurrent requests exceeded');
    }

    const record: IdempotencyRecord = {
      key,
      status: 'processing',
      startTime: Date.now(),
      correlationId,
      metadata
    };

    // Store record
    await this.storeRecord(record);

    // Cache record
    const cacheKey = cacheKeys.compile('idempotency', key.requestId);
    await sharedCache.set(cacheKey, record, key.ttl);

    return record;
  }

  /**
   * Update request with result
   */
  async completeRequest(
    requestId: string,
    result: any,
    error?: string
  ): Promise<void> {
    const recordPath = this.getRecordPath(requestId);

    try {
      const recordData = await readFile(recordPath, 'utf8');
      const record: IdempotencyRecord = JSON.parse(recordData);

      record.status = error ? 'failed' : 'completed';
      record.endTime = Date.now();
      record.result = result;
      record.error = error;

      // Update storage
      await this.storeRecord(record);

      // Update cache
      const cacheKey = cacheKeys.compile('idempotency', requestId);
      await sharedCache.set(cacheKey, record, record.key.ttl);

      // Remove from active requests
      this.activeRequests.delete(requestId);

    } catch (error) {
      console.error('Failed to complete request:', error);
    }
  }

  /**
   * Store file attachment with validation
   */
  async storeAttachment(
    fileId: string,
    filename: string,
    content: Buffer,
    contentType: string,
    metadata?: any
  ): Promise<AttachmentInfo> {
    // Validate file extension
    const ext = extname(filename).toLowerCase();
    if (!this.config.allowedExtensions.includes(ext)) {
      throw new Error(`File type not allowed: ${ext}`);
    }

    // Validate file size
    if (content.length > this.config.maxAttachmentSize) {
      throw new Error(`File too large: ${content.length} bytes (max: ${this.config.maxAttachmentSize})`);
    }

    // Calculate checksum
    const checksum = this.hashBuffer(content);

    // Check for duplicate content
    if (this.config.enableDeduplication) {
      const existing = await this.findAttachmentByChecksum(checksum);
      if (existing) {
        return existing;
      }
    }

    // Store file
    const attachmentPath = join(this.attachmentsDir, `${fileId}.data`);
    await writeFile(attachmentPath, content);

    // Create attachment info
    const attachmentInfo: AttachmentInfo = {
      fileId,
      filename,
      checksum,
      size: content.length,
      contentType,
      uploadedAt: new Date().toISOString()
    };

    // Validate content if enabled
    if (this.config.enableAttachmentValidation) {
      const validation = await this.validateAttachmentContent(content, contentType, filename);
      attachmentInfo.validatedAt = new Date().toISOString();
      attachmentInfo.isValid = validation.isValid;
      attachmentInfo.validationErrors = validation.errors;
    }

    // Store metadata
    const metadataPath = join(this.attachmentsDir, `${fileId}.meta.json`);
    await writeFile(metadataPath, JSON.stringify(attachmentInfo, null, 2));

    return attachmentInfo;
  }

  /**
   * Retrieve attachment by file ID
   */
  async getAttachment(fileId: string): Promise<{ info: AttachmentInfo; content: Buffer } | null> {
    try {
      const metadataPath = join(this.attachmentsDir, `${fileId}.meta.json`);
      const attachmentPath = join(this.attachmentsDir, `${fileId}.data`);

      const metadataData = await readFile(metadataPath, 'utf8');
      const info: AttachmentInfo = JSON.parse(metadataData);

      const content = await readFile(attachmentPath);

      // Verify checksum
      const currentChecksum = this.hashBuffer(content);
      if (currentChecksum !== info.checksum) {
        throw new Error('Attachment checksum mismatch - file corrupted');
      }

      return { info, content };
    } catch {
      return null;
    }
  }

  /**
   * Find attachment by content checksum
   */
  async findAttachmentByChecksum(checksum: string): Promise<AttachmentInfo | null> {
    try {
      const files = await readdir(this.attachmentsDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));

      for (const metaFile of metaFiles) {
        const metadataPath = join(this.attachmentsDir, metaFile);
        const metadataData = await readFile(metadataPath, 'utf8');
        const info: AttachmentInfo = JSON.parse(metadataData);

        if (info.checksum === checksum) {
          return info;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Validate attachment content
   */
  private async validateAttachmentContent(
    content: Buffer,
    contentType: string,
    filename: string
  ): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      // Basic validation based on content type
      if (contentType.includes('json')) {
        JSON.parse(content.toString('utf8'));
      } else if (contentType.includes('yaml') || filename.endsWith('.yml') || filename.endsWith('.yaml')) {
        // Basic YAML validation - would need yaml parser for full validation
        const text = content.toString('utf8');
        if (text.includes('\t')) {
          errors.push('YAML should use spaces, not tabs for indentation');
        }
      }

      // Check for null bytes (potential security issue)
      if (content.includes(0)) {
        errors.push('File contains null bytes');
      }

      // Check encoding (ensure it's valid UTF-8 for text files)
      if (contentType.startsWith('text/')) {
        try {
          content.toString('utf8');
        } catch {
          errors.push('File is not valid UTF-8');
        }
      }

    } catch (error) {
      errors.push(`Content validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Cleanup expired records and attachments
   */
  async cleanup(): Promise<{ recordsRemoved: number; attachmentsRemoved: number }> {
    let recordsRemoved = 0;
    let attachmentsRemoved = 0;

    try {
      // Cleanup expired records
      const recordFiles = await readdir(this.recordsDir);
      for (const file of recordFiles) {
        const recordPath = join(this.recordsDir, file);
        try {
          const recordData = await readFile(recordPath, 'utf8');
          const record: IdempotencyRecord = JSON.parse(recordData);

          if (!this.isRecordValid(record)) {
            await unlink(recordPath);
            recordsRemoved++;
          }
        } catch {
          // Remove corrupted records
          await unlink(recordPath);
          recordsRemoved++;
        }
      }

      // Cleanup orphaned attachments (not referenced by any valid record)
      const attachmentFiles = await readdir(this.attachmentsDir);
      const dataFiles = attachmentFiles.filter(f => f.endsWith('.data'));

      for (const dataFile of dataFiles) {
        const fileId = dataFile.replace('.data', '');
        const isReferenced = await this.isAttachmentReferenced(fileId);

        if (!isReferenced) {
          await unlink(join(this.attachmentsDir, dataFile));
          await unlink(join(this.attachmentsDir, `${fileId}.meta.json`)).catch(() => {});
          attachmentsRemoved++;
        }
      }

    } catch (error) {
      console.error('Cleanup failed:', error);
    }

    return { recordsRemoved, attachmentsRemoved };
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    activeRecords: number;
    totalAttachments: number;
    storageSize: number;
    oldestRecord?: string;
  }> {
    let activeRecords = 0;
    let totalAttachments = 0;
    let storageSize = 0;
    let oldestTimestamp = Date.now();

    try {
      // Count records
      const recordFiles = await readdir(this.recordsDir);
      for (const file of recordFiles) {
        const recordPath = join(this.recordsDir, file);
        try {
          const stats = await stat(recordPath);
          storageSize += stats.size;

          const recordData = await readFile(recordPath, 'utf8');
          const record: IdempotencyRecord = JSON.parse(recordData);

          if (this.isRecordValid(record)) {
            activeRecords++;
            if (record.key.timestamp < oldestTimestamp) {
              oldestTimestamp = record.key.timestamp;
            }
          }
        } catch {
          // Ignore corrupted files
        }
      }

      // Count attachments
      const attachmentFiles = await readdir(this.attachmentsDir);
      const dataFiles = attachmentFiles.filter(f => f.endsWith('.data'));
      totalAttachments = dataFiles.length;

      for (const file of attachmentFiles) {
        const stats = await stat(join(this.attachmentsDir, file));
        storageSize += stats.size;
      }

    } catch (error) {
      console.error('Stats calculation failed:', error);
    }

    return {
      activeRecords,
      totalAttachments,
      storageSize,
      oldestRecord: oldestTimestamp < Date.now() ? new Date(oldestTimestamp).toISOString() : undefined
    };
  }

  /**
   * Helper methods
   */
  private generateRequestId(
    operationType: string,
    inputHash: string,
    attachmentHashes?: string[]
  ): string {
    const combined = [operationType, inputHash, ...(attachmentHashes || [])].join(':');
    return this.hashString(combined);
  }

  private hashObject(obj: any): string {
    return this.hashString(JSON.stringify(obj, Object.keys(obj).sort()));
  }

  private hashString(str: string): string {
    return createHash('sha256').update(str).digest('hex');
  }

  private hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private getRecordPath(requestId: string): string {
    return join(this.recordsDir, `${requestId}.json`);
  }

  private async storeRecord(record: IdempotencyRecord): Promise<void> {
    const recordPath = this.getRecordPath(record.key.requestId);
    await writeFile(recordPath, JSON.stringify(record, null, 2));
  }

  private isRecordValid(record: IdempotencyRecord): boolean {
    const now = Date.now();
    const expiry = record.key.timestamp + record.key.ttl;
    return now < expiry;
  }

  private async isAttachmentReferenced(fileId: string): Promise<boolean> {
    try {
      const recordFiles = await readdir(this.recordsDir);
      for (const file of recordFiles) {
        const recordPath = join(this.recordsDir, file);
        try {
          const recordData = await readFile(recordPath, 'utf8');
          const record: IdempotencyRecord = JSON.parse(recordData);

          if (this.isRecordValid(record) && record.key.attachmentHashes) {
            // This is a simplified check - in reality, you'd need to map fileIds to hashes
            // For now, assume attachment is referenced if record has attachments and is valid
            return true;
          }
        } catch {
          // Ignore corrupted records
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const idempotencyStore = new IdempotencyStore();