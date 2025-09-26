/**
 * Dynamic Asset Compilation API Endpoint
 * Handles on-demand compilation of plots, diagrams, and chemical structures
 * Implements secure request validation and caching
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { join, resolve, extname } from 'path';
import { writeFile, rename, mkdir, stat, readdir, unlink } from 'fs/promises';
import { createHash } from 'crypto';
import { PATHS } from '../../config/paths.js';
import { sharedCache, cacheKeys } from '../cache/shared-cache.js';
import { pathValidation } from '../../config/paths.js';
import { idempotencyStore } from '../idempotency/store.js';
import { lockManager } from '../concurrency/lock-manager.js';
import { retryHelper } from '../resilience/retry-policies.js';
import { atomicPublisher } from '../publishing/atomic-publisher.js';
import { compilePlotToSVG } from '../pgf/compile.js';
import { smilesToSVG } from '../chem/rdkit.js';
import { compileDiagramToSVG } from '../diagram/compile.js';

/**
 * Request validation schemas
 */
const CompileRequestSchema = z.object({
  type: z.enum(['plot', 'diagram', 'chem']),
  spec: z.object({}).passthrough(), // Flexible spec object
  identifier: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  format: z.enum(['svg', 'png']).default('svg'),
  options: z.object({
    width: z.number().min(100).max(2000).optional(),
    height: z.number().min(100).max(2000).optional(),
    quality: z.number().min(1).max(100).optional(),
    theme: z.enum(['light', 'dark']).optional()
  }).optional()
});

const BatchCompileRequestSchema = z.object({
  requests: z.array(CompileRequestSchema).min(1).max(10)
});

type CompileRequest = z.infer<typeof CompileRequestSchema>;
type BatchCompileRequest = z.infer<typeof BatchCompileRequestSchema>;

interface CompileResponse {
  success: boolean;
  identifier: string;
  path?: string;
  url?: string;
  cached: boolean;
  processingTimeMs: number;
  error?: string;
}

interface BatchCompileResponse {
  success: boolean;
  results: CompileResponse[];
  totalProcessingTimeMs: number;
  cached: number;
  compiled: number;
  errors: number;
}

/**
 * Rate limiting configuration
 */
const compileRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many compilation requests, please try again later',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const batchCompileRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // Limit batch requests more strictly
  message: {
    error: 'Too many batch compilation requests, please try again later',
    retryAfter: '5 minutes'
  }
});

/**
 * Asset compiler implementations
 */
class AssetCompiler {
  /**
   * Compile plot specification to SVG using real PGF/TikZ compiler
   */
  async compilePlot(spec: any, options: any = {}): Promise<string> {
    try {
      // Use the real plot compiler from content-engine
      const svg = await compilePlotToSVG(spec, {
        width: options.width,
        height: options.height,
        theme: options.theme
      });
      return svg;
    } catch (error) {
      console.warn('Plot compilation failed, using fallback:', error);
      // Fallback to placeholder if real compilation fails
      return `
        <svg width="${options.width || 400}" height="${options.height || 300}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="${options.theme === 'dark' ? '#1a1a1a' : '#ffffff'}" stroke="#ff0000" stroke-width="2"/>
          <text x="50%" y="40%" text-anchor="middle" fill="${options.theme === 'dark' ? '#ffffff' : '#000000'}" font-size="14">
            Plot Compilation Error
          </text>
          <text x="50%" y="60%" text-anchor="middle" fill="${options.theme === 'dark' ? '#ffffff' : '#000000'}" font-size="12">
            ${spec.title || 'Untitled Plot'}
          </text>
        </svg>`.trim();
    }
  }

  /**
   * Compile diagram specification to SVG using real diagram compiler
   */
  async compileDiagram(spec: any, options: any = {}): Promise<string> {
    try {
      // Use the real diagram compiler from content-engine
      const svg = await compileDiagramToSVG(spec, {
        width: options.width,
        height: options.height,
        theme: options.theme
      });
      return svg;
    } catch (error) {
      console.warn('Diagram compilation failed, using fallback:', error);
      // Fallback to placeholder if real compilation fails
      return `
        <svg width="${options.width || 400}" height="${options.height || 300}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="${options.theme === 'dark' ? '#1a1a1a' : '#ffffff'}" stroke="#ff0000" stroke-width="2"/>
          <text x="50%" y="40%" text-anchor="middle" fill="${options.theme === 'dark' ? '#ffffff' : '#000000'}" font-size="14">
            Diagram Compilation Error
          </text>
          <text x="50%" y="60%" text-anchor="middle" fill="${options.theme === 'dark' ? '#ffffff' : '#000000'}" font-size="12">
            ${spec.type || 'Unknown Diagram'}
          </text>
        </svg>`.trim();
    }
  }

  /**
   * Compile chemical structure to SVG using real RDKit compiler
   */
  async compileChemistry(spec: any, options: any = {}): Promise<string> {
    try {
      // Use the real chemistry compiler from content-engine
      const svg = await smilesToSVG(spec.smiles || spec.molecule, {
        width: options.width || 300,
        height: options.height || 200,
        theme: options.theme
      });
      return svg;
    } catch (error) {
      console.warn('Chemistry compilation failed, using fallback:', error);
      // Fallback to placeholder if real compilation fails
      return `
        <svg width="${options.width || 300}" height="${options.height || 200}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="${options.theme === 'dark' ? '#1a1a1a' : '#ffffff'}" stroke="#ff0000" stroke-width="2"/>
          <text x="50%" y="40%" text-anchor="middle" fill="${options.theme === 'dark' ? '#ffffff' : '#000000'}" font-size="14">
            Chemistry Compilation Error
          </text>
          <text x="50%" y="60%" text-anchor="middle" fill="${options.theme === 'dark' ? '#ffffff' : '#000000'}" font-size="12">
            ${spec.smiles || spec.molecule || 'Unknown Molecule'}
          </text>
        </svg>`.trim();
    }
  }
}

/**
 * Main compilation service
 */
class CompilationService {
  private compiler = new AssetCompiler();

  /**
   * Compile single asset with caching, locks, and retry logic
   */
  async compileAsset(request: CompileRequest): Promise<CompileResponse> {
    const startTime = Date.now();

    // Generate idempotency key
    const idempotencyKey = idempotencyStore.generateKey(
      'compile',
      request,
      undefined,
      3600000 // 1 hour TTL for compilation results
    );

    // Check for duplicate request
    const existingRecord = await idempotencyStore.checkDuplicate(idempotencyKey);
    if (existingRecord && existingRecord.status === 'completed') {
      return {
        success: true,
        identifier: request.identifier,
        path: existingRecord.result?.path,
        url: this.getAssetUrl(request.identifier, request.format),
        cached: true,
        processingTimeMs: Date.now() - startTime
      };
    }

    // Register request to prevent duplicates
    await idempotencyStore.registerRequest(idempotencyKey);

    try {
      // Generate cache key based on request content
      const requestHash = this.generateRequestHash(request);
      const cacheKey = cacheKeys.compile(request.type, requestHash);

      // Check cache first
      const cached = await sharedCache.get<string>(cacheKey);
      if (cached) {
        const outputPath = await this.getCachedAssetPath(request.identifier, request.format);

        // Complete idempotency record
        await idempotencyStore.completeRequest(idempotencyKey.requestId, { path: outputPath });

        return {
          success: true,
          identifier: request.identifier,
          path: outputPath,
          url: this.getAssetUrl(request.identifier, request.format),
          cached: true,
          processingTimeMs: Date.now() - startTime
        };
      }

      // Acquire lock to prevent concurrent compilation of same asset
      const lockResult = await lockManager.acquireLock(
        'compile',
        `${request.type}:${requestHash}`,
        300000 // 5 minutes
      );

      if (!lockResult.acquired) {
        throw new Error(`Failed to acquire compilation lock: ${lockResult.error}`);
      }

      try {
        // Compile asset with retry logic
        const compiledContent = await retryHelper.retryAssetCompilation(async () => {
          switch (request.type) {
            case 'plot':
              return await this.compiler.compilePlot(request.spec, request.options);
            case 'diagram':
              return await this.compiler.compileDiagram(request.spec, request.options);
            case 'chem':
              return await this.compiler.compileChemistry(request.spec, request.options);
            default:
              throw new Error(`Unsupported asset type: ${request.type}`);
          }
        }, `${request.type}-${request.identifier}`);

        if (!compiledContent.success) {
          throw new Error(`Compilation failed: ${compiledContent.error?.message}`);
        }

        // Save to disk using atomic publisher
        const publishResult = await retryHelper.retryFileOperation(async () => {
          return atomicPublisher.publishFile(
            compiledContent.result || '',
            `assets/${request.identifier}.${request.format}`,
            idempotencyKey.requestId
          );
        }, `publish-${request.identifier}`);

        if (!publishResult.success) {
          throw new Error(`Publishing failed: ${publishResult.error?.message}`);
        }

        // Cache the result
        await sharedCache.set(cacheKey, compiledContent.result, 3600000); // 1 hour TTL

        // Complete idempotency record
        await idempotencyStore.completeRequest(idempotencyKey.requestId, {
          path: publishResult.result?.filePath,
          url: this.getAssetUrl(request.identifier, request.format)
        });

        return {
          success: true,
          identifier: request.identifier,
          path: publishResult.result?.filePath,
          url: this.getAssetUrl(request.identifier, request.format),
          cached: false,
          processingTimeMs: Date.now() - startTime
        };

      } finally {
        // Always release the lock
        if (lockResult.lockInfo?.lockId) {
          await lockManager.releaseLock(lockResult.lockInfo.lockId);
        }
      }

    } catch (error) {
      // Complete idempotency record with error
      await idempotencyStore.completeRequest(
        idempotencyKey.requestId,
        null,
        error instanceof Error ? error.message : String(error)
      );

      return {
        success: false,
        identifier: request.identifier,
        cached: false,
        processingTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Batch compile multiple assets
   */
  async batchCompile(requests: CompileRequest[]): Promise<BatchCompileResponse> {
    const startTime = Date.now();

    // Process all requests in parallel
    const results = await Promise.all(
      requests.map(request => this.compileAsset(request))
    );

    // Aggregate statistics
    const cached = results.filter(r => r.cached).length;
    const compiled = results.filter(r => r.success && !r.cached).length;
    const errors = results.filter(r => !r.success).length;

    return {
      success: errors === 0,
      results,
      totalProcessingTimeMs: Date.now() - startTime,
      cached,
      compiled,
      errors
    };
  }

  /**
   * Generate deterministic hash for request
   */
  private generateRequestHash(request: CompileRequest): string {
    const hashInput = JSON.stringify({
      type: request.type,
      spec: request.spec,
      options: request.options
    });

    return createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
  }

  /**
   * Save compiled asset to appropriate directory
   */
  private async saveAsset(identifier: string, format: string, content: string): Promise<string> {
    // Validate identifier for security
    if (!pathValidation.sanitizeFilename(identifier) || pathValidation.hasPathTraversal(identifier)) {
      throw new Error('Invalid identifier');
    }

    const filename = `${identifier}.${format}`;
    const outputDir = resolve(PATHS.ROOT_DIR, PATHS.ASSETS_DIR);
    const outputPath = join(outputDir, filename);

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Write file atomically
    const tempPath = `${outputPath}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, outputPath);

    return outputPath;
  }

  /**
   * Get cached asset path
   */
  private async getCachedAssetPath(identifier: string, format: string): Promise<string> {
    const filename = `${identifier}.${format}`;
    const outputDir = resolve(PATHS.ROOT_DIR, PATHS.ASSETS_DIR);
    return join(outputDir, filename);
  }

  /**
   * Generate public URL for asset
   */
  private getAssetUrl(identifier: string, format: string): string {
    return `/assets/${identifier}.${format}`;
  }
}

/**
 * Express route handlers
 */
const compilationService = new CompilationService();

/**
 * Single asset compilation endpoint
 */
export const compileAsset = [
  compileRateLimit,
  async (req: Request, res: Response) => {
    try {
      // Validate request body
      const validatedRequest = CompileRequestSchema.parse(req.body);

      // Compile asset
      const result = await compilationService.compileAsset(validatedRequest);

      // Set appropriate status code
      const statusCode = result.success ? 200 : 400;

      res.status(statusCode).json(result);

    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: 'Invalid request format',
          details: error.errors
        });
      } else {
        console.error('Compilation error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  }
];

/**
 * Batch compilation endpoint
 */
export const batchCompileAssets = [
  batchCompileRateLimit,
  async (req: Request, res: Response) => {
    try {
      // Validate request body
      const validatedRequest = BatchCompileRequestSchema.parse(req.body);

      // Batch compile assets
      const result = await compilationService.batchCompile(validatedRequest.requests);

      // Set status based on overall success
      const statusCode = result.success ? 200 : 207; // 207 Multi-Status for partial success

      res.status(statusCode).json(result);

    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: 'Invalid batch request format',
          details: error.errors
        });
      } else {
        console.error('Batch compilation error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error'
        });
      }
    }
  }
];

/**
 * Asset info endpoint (check if asset exists)
 */
export const getAssetInfo = async (req: Request, res: Response) => {
  try {
    const { identifier, format = 'svg' } = req.params;

    // Validate parameters
    if (!identifier || !pathValidation.sanitizeFilename(identifier)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid identifier'
      });
    }

    const filename = `${identifier}.${format}`;
    const assetPath = join(resolve(PATHS.ROOT_DIR, PATHS.ASSETS_DIR), filename);

    try {
      const stats = await stat(assetPath);
      res.json({
        success: true,
        identifier,
        format,
        exists: true,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
        url: `/assets/${filename}`
      });
    } catch (error) {
      res.json({
        success: true,
        identifier,
        format,
        exists: false
      });
    }

  } catch (error) {
    console.error('Asset info error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};

export { CompilationService };