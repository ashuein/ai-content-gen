/**
 * Pipeline API Endpoints
 * Handles content generation pipeline orchestration and status tracking
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { CompletePipelineOrchestrator } from '../../scripts/generate-complete-chapter.js';
import { idempotencyStore } from '../idempotency/store.js';
import { lockManager } from '../concurrency/lock-manager.js';
import { retryHelper } from '../resilience/retry-policies.js';
import { atomicPublisher } from '../publishing/atomic-publisher.js';

// Request validation schemas
const InjectorBuildSchema = z.object({
  grade: z.string().min(1).max(50),
  subject: z.enum(['Physics', 'Chemistry', 'Mathematics']),
  chapter: z.string().min(1).max(100),
  standard: z.string().min(1).max(50),
  difficulty: z.enum(['comfort', 'hustle', 'advanced']),
  attachments: z.array(z.string()).optional(),
  correlationId: z.string().optional()
});

type InjectorBuildRequest = z.infer<typeof InjectorBuildSchema>;

interface PipelineStatus {
  promptId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage: string;
  progress: number; // 0-100
  createdAt: string;
  updatedAt: string;
  result?: any;
  error?: string;
  artifacts?: {
    chapterPath?: string;
    renderedPath?: string;
    plotSpecs?: string[];
    diagramSpecs?: string[];
  };
}

// In-memory pipeline status tracking (in production, use Redis or database)
const pipelineStatuses = new Map<string, PipelineStatus>();

/**
 * Generate unique prompt ID
 */
function generatePromptId(): string {
  return `prompt-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Update pipeline status
 */
function updatePipelineStatus(promptId: string, updates: Partial<PipelineStatus>): void {
  const existing = pipelineStatuses.get(promptId);
  if (existing) {
    pipelineStatuses.set(promptId, {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    });
  }
}

/**
 * Build content using prompt injector and full pipeline
 */
export const buildWithInjector = async (req: Request, res: Response): Promise<void> => {
  try {
    // Validate request
    const validatedRequest = InjectorBuildSchema.parse(req.body);
    const correlationId = validatedRequest.correlationId || `build-${Date.now()}`;

    // Generate unique prompt ID for tracking
    const promptId = generatePromptId();

    // Generate idempotency key
    const idempotencyKey = idempotencyStore.generateKey(
      'generate',
      validatedRequest,
      validatedRequest.attachments
    );

    // Check for duplicate request
    const existingRecord = await idempotencyStore.checkDuplicate(idempotencyKey);
    if (existingRecord && existingRecord.status === 'completed') {
      res.json({
        success: true,
        promptId: existingRecord.correlationId || promptId,
        message: 'Request already processed',
        cached: true,
        result: existingRecord.result
      });
      return;
    }

    // Initialize pipeline status
    const initialStatus: PipelineStatus = {
      promptId,
      status: 'queued',
      stage: 'initializing',
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    pipelineStatuses.set(promptId, initialStatus);

    // Register idempotency record
    await idempotencyStore.registerRequest(idempotencyKey, correlationId, {
      userId: req.get('X-User-ID'),
      sessionId: req.get('X-Session-ID'),
      apiVersion: '1.0'
    });

    // Respond immediately with prompt ID for tracking
    res.status(202).json({
      success: true,
      promptId,
      message: 'Pipeline started',
      statusUrl: `/api/status/${promptId}`
    });

    // Execute pipeline asynchronously with proper error handling
    setImmediate(async () => {
      try {
        await executePipelineWithInfrastructure(
          validatedRequest,
          promptId,
          idempotencyKey,
          correlationId
        );
      } catch (error) {
        console.error(`Pipeline execution failed for ${promptId}:`, error);
        updatePipelineStatus(promptId, {
          status: 'failed',
          stage: 'error',
          progress: 0,
          error: error instanceof Error ? error.message : String(error)
        });

        await idempotencyStore.completeRequest(
          idempotencyKey.requestId,
          null,
          error instanceof Error ? error.message : String(error)
        );
      }
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request format',
        details: error.errors
      });
    } else {
      console.error('Build endpoint error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  }
};

/**
 * Get pipeline status
 */
export const getPipelineStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { promptId } = req.params;

    if (!promptId) {
      res.status(400).json({
        success: false,
        error: 'Missing promptId parameter'
      });
      return;
    }

    const status = pipelineStatuses.get(promptId);
    if (!status) {
      res.status(404).json({
        success: false,
        error: 'Pipeline not found'
      });
      return;
    }

    res.json({
      success: true,
      status
    });

  } catch (error) {
    console.error('Status endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};

/**
 * List all pipeline statuses (for monitoring)
 */
export const listPipelineStatuses = async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = 50, status: statusFilter } = req.query;

    let statuses = Array.from(pipelineStatuses.values());

    // Filter by status if provided
    if (statusFilter && typeof statusFilter === 'string') {
      statuses = statuses.filter(s => s.status === statusFilter);
    }

    // Sort by creation time (newest first)
    statuses.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Limit results
    const limitNum = parseInt(String(limit), 10);
    if (limitNum > 0) {
      statuses = statuses.slice(0, limitNum);
    }

    res.json({
      success: true,
      total: pipelineStatuses.size,
      filtered: statuses.length,
      statuses
    });

  } catch (error) {
    console.error('List statuses error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};

/**
 * Execute pipeline with full infrastructure integration
 */
async function executePipelineWithInfrastructure(
  request: InjectorBuildRequest,
  promptId: string,
  idempotencyKey: any,
  correlationId: string
): Promise<void> {
  const resourceId = `${request.subject}-${request.chapter}`;

  // Acquire lock to prevent concurrent processing of same content
  updatePipelineStatus(promptId, {
    status: 'processing',
    stage: 'acquiring_lock',
    progress: 5
  });

  const lockResult = await lockManager.acquireLock(
    'generate',
    resourceId,
    30 * 60 * 1000, // 30 minutes
    { correlationId, promptId }
  );

  if (!lockResult.acquired) {
    throw new Error(`Failed to acquire lock: ${lockResult.error}`);
  }

  try {
    updatePipelineStatus(promptId, {
      stage: 'initializing_pipeline',
      progress: 10
    });

    // Initialize pipeline orchestrator
    const orchestrator = new CompletePipelineOrchestrator({
      enableFileUpload: true,
      enableLLMGeneration: true,
      enableValidation: true,
      enableRepair: true,
      enableCompilation: true,
      enableRendering: true,
      outputPath: './temp/pipeline-output',
      errorMode: 'graceful',
      correlationId
    });

    updatePipelineStatus(promptId, {
      stage: 'content_generation',
      progress: 20
    });

    // Execute pipeline with retry logic
    const pipelineResult = await retryHelper.retryContentGeneration(async () => {
      return orchestrator.executeCompletePipeline(request);
    }, `pipeline-${promptId}`, { promptId, correlationId });

    if (!pipelineResult.success) {
      throw new Error(`Pipeline failed: ${pipelineResult.error?.message}`);
    }

    updatePipelineStatus(promptId, {
      stage: 'publishing',
      progress: 80
    });

    // Publish results atomically
    if (pipelineResult.result?.artifacts?.chapterPath) {
      const publishResult = await retryHelper.retryFileOperation(async () => {
        const chapterContent = await import('fs/promises').then(fs =>
          fs.readFile(pipelineResult.result.artifacts.chapterPath, 'utf8')
        );

        return atomicPublisher.publishFile(
          chapterContent,
          `chapters/${promptId}.json`,
          correlationId
        );
      }, `publish-${promptId}`);

      if (!publishResult.success) {
        throw new Error(`Publishing failed: ${publishResult.error?.message}`);
      }
    }

    updatePipelineStatus(promptId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result: pipelineResult.result,
      artifacts: pipelineResult.result?.artifacts
    });

    // Complete idempotency record
    await idempotencyStore.completeRequest(
      idempotencyKey.requestId,
      pipelineResult.result
    );

    console.log(`Pipeline ${promptId} completed successfully`);

  } finally {
    // Always release the lock
    await lockManager.releaseLock(lockResult.lockInfo?.lockId || '');
  }
}

/**
 * Clean up old pipeline statuses (called periodically)
 */
export function cleanupOldStatuses(): void {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

  for (const [promptId, status] of pipelineStatuses.entries()) {
    const createdTime = new Date(status.createdAt).getTime();
    if (createdTime < oneDayAgo) {
      pipelineStatuses.delete(promptId);
    }
  }

  console.log(`Cleaned up old pipeline statuses. Current count: ${pipelineStatuses.size}`);
}

// Cleanup old statuses every hour
setInterval(cleanupOldStatuses, 60 * 60 * 1000);