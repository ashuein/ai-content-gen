/**
 * PromptEnvelope → PlanRequest Adapter
 *
 * Bridges the prompt-injector's PromptEnvelope format with the content-engine's
 * existing PlanRequest interface. Enables integration while preserving the
 * modular M1→M2→M3→M4 pipeline architecture.
 *
 * Key Responsibilities:
 * - Transform PromptEnvelope to PlanRequest for pipeline compatibility
 * - Extract LLM context for M1 and M3 modules
 * - Maintain correlation tracking throughout the pipeline
 * - Provide idempotency and caching support
 * - Handle file attachment context
 */

import { createHash } from 'crypto';
import { PlanRequest } from '../../m1-plan/src/types.js';
import { PromptEnvelopeV1 } from '../../../prompt-injector/contracts/prompt-envelope.v1.js';

/**
 * LLM context extracted from PromptEnvelope for specific modules
 */
export interface LLMModuleContext {
  correlationId: string;
  systemPrompt: string;
  userPrompt: string;
  fileId?: string;
  model: {
    name: string;
    provider: string;
    maxTokens: number;
  };
  template: {
    templateId: string;
    templateHash: string;
    varsHash: string;
  };
  meta: {
    subject: string;
    grade: string;
    difficulty: string;
    chapter: string;
  };
}

/**
 * Enhanced PlanRequest with additional context from PromptEnvelope
 */
export interface EnhancedPlanRequest extends PlanRequest {
  _envelope_context?: {
    correlationId: string;
    idempotencyKey?: string;
    templateMetadata: {
      templateId: string;
      templateHash: string;
      varsHash: string;
    };
    attachments: Array<{
      kind: string;
      fileId: string;
      checksum: string;
    }>;
    processingHints?: {
      priority: 'low' | 'normal' | 'high';
      cacheTtl?: number;
      retryPolicy?: 'standard' | 'aggressive' | 'conservative';
    };
  };
}

/**
 * Transformation validation result
 */
export interface TransformationResult {
  success: boolean;
  planRequest?: EnhancedPlanRequest;
  m1Context?: LLMModuleContext;
  m3Context?: LLMModuleContext;
  errors: string[];
  warnings: string[];
  idempotencyKey: string;
}

/**
 * Configuration for the adapter behavior
 */
export interface AdapterConfig {
  preserveTemplateContext: boolean;
  enableIdempotency: boolean;
  validateTransformation: boolean;
  defaultCacheTtl: number;
  logTransformations: boolean;
}

/**
 * Default adapter configuration
 */
export const DEFAULT_ADAPTER_CONFIG: AdapterConfig = {
  preserveTemplateContext: true,
  enableIdempotency: true,
  validateTransformation: true,
  defaultCacheTtl: 3600, // 1 hour
  logTransformations: false
};

/**
 * Main adapter class for PromptEnvelope → PlanRequest transformation
 */
export class PromptEnvelopeAdapter {
  private config: AdapterConfig;
  private logger?: (level: string, message: string, data?: any) => void;

  constructor(config: Partial<AdapterConfig> = {}, logger?: (level: string, message: string, data?: any) => void) {
    this.config = { ...DEFAULT_ADAPTER_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Main transformation method
   * Converts PromptEnvelope to PlanRequest and extracts LLM contexts
   */
  transform(envelope: PromptEnvelopeV1): TransformationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Generate idempotency key
      const idempotencyKey = this.generateIdempotencyKey(envelope);

      // Basic validation
      if (this.config.validateTransformation) {
        const validationErrors = this.validateEnvelope(envelope);
        if (validationErrors.length > 0) {
          return {
            success: false,
            errors: validationErrors,
            warnings,
            idempotencyKey
          };
        }
      }

      // Transform to PlanRequest
      const planRequest = this.transformToPlanRequest(envelope);

      // Extract LLM contexts for M1 and M3
      const m1Context = this.extractM1Context(envelope);
      const m3Context = this.extractM3Context(envelope);

      // Log transformation if enabled
      if (this.config.logTransformations) {
        this.logger?.('info', 'PromptEnvelope transformation successful', {
          correlationId: envelope.envelope.correlationId,
          idempotencyKey,
          subject: envelope.meta.subject,
          chapter: envelope.meta.chapter,
          difficulty: envelope.meta.difficulty
        });
      }

      return {
        success: true,
        planRequest,
        m1Context,
        m3Context,
        errors,
        warnings,
        idempotencyKey
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.('error', 'PromptEnvelope transformation failed', {
        error: errorMessage,
        correlationId: envelope.envelope?.correlationId
      });

      return {
        success: false,
        errors: [`Transformation failed: ${errorMessage}`],
        warnings,
        idempotencyKey: this.generateIdempotencyKey(envelope)
      };
    }
  }

  /**
   * Transform PromptEnvelope to basic PlanRequest
   */
  private transformToPlanRequest(envelope: PromptEnvelopeV1): EnhancedPlanRequest {
    const planRequest: EnhancedPlanRequest = {
      title: envelope.meta.chapter,
      subject: envelope.meta.subject,
      grade: envelope.meta.grade,
      difficulty: envelope.meta.difficulty,
      chapter_pdf_url: undefined, // We'll use file_id through LLM context
      reference_materials: []
    };

    // Add envelope context if preservation is enabled
    if (this.config.preserveTemplateContext) {
      planRequest._envelope_context = {
        correlationId: envelope.envelope.correlationId,
        idempotencyKey: this.config.enableIdempotency ? this.generateIdempotencyKey(envelope) : undefined,
        templateMetadata: {
          templateId: envelope.template.template_id,
          templateHash: envelope.template.template_hash,
          varsHash: envelope.template.vars_hash
        },
        attachments: envelope.attachments.map(att => ({
          kind: att.kind,
          fileId: att.file_id,
          checksum: att.checksum
        })),
        processingHints: {
          priority: 'normal',
          cacheTtl: this.config.defaultCacheTtl,
          retryPolicy: 'standard'
        }
      };
    }

    return planRequest;
  }

  /**
   * Extract LLM context for M1-Plan module
   */
  private extractM1Context(envelope: PromptEnvelopeV1): LLMModuleContext {
    const systemMessage = envelope.messages.find(m => m.role === 'system');
    const userMessage = envelope.messages.find(m => m.role === 'user');

    return {
      correlationId: envelope.envelope.correlationId,
      systemPrompt: systemMessage?.content || '',
      userPrompt: userMessage?.content || '',
      fileId: envelope.attachments[0]?.file_id, // First attachment for context
      model: {
        name: envelope.model.name,
        provider: envelope.model.provider,
        maxTokens: envelope.model.max_tokens
      },
      template: {
        templateId: envelope.template.template_id,
        templateHash: envelope.template.template_hash,
        varsHash: envelope.template.vars_hash
      },
      meta: {
        subject: envelope.meta.subject,
        grade: envelope.meta.grade,
        difficulty: envelope.meta.difficulty,
        chapter: envelope.meta.chapter
      }
    };
  }

  /**
   * Extract LLM context for M3-Section module
   * Similar to M1 but potentially with different prompt focus
   */
  private extractM3Context(envelope: PromptEnvelopeV1): LLMModuleContext {
    // For M3, we might want to modify the prompts to focus on section-level content
    const m1Context = this.extractM1Context(envelope);

    // M3 gets the same context but might be used differently
    // Future enhancement: could modify prompts specifically for section generation
    return {
      ...m1Context,
      // Potentially modify systemPrompt for section-specific generation
      systemPrompt: this.adaptPromptForM3(m1Context.systemPrompt, envelope),
      userPrompt: this.adaptPromptForM3User(m1Context.userPrompt, envelope)
    };
  }

  /**
   * Adapt system prompt for M3 section generation
   */
  private adaptPromptForM3(originalPrompt: string, envelope: PromptEnvelopeV1): string {
    // Add M3-specific instructions while preserving original context
    const m3Instructions = `
You are generating detailed section content based on the overall chapter plan.
Focus on creating specific content blocks (prose, equations, plots, diagrams) for individual sections.

Original Context:
${originalPrompt}

Section-Specific Instructions:
- Generate specific content blocks rather than overall chapter structure
- Include mathematical equations with proper LaTeX formatting
- Specify plot/diagram requirements with detailed specifications
- Create interactive widget configurations where appropriate
- Maintain consistency with the overall chapter difficulty level (${envelope.meta.difficulty})
`;

    return m3Instructions;
  }

  /**
   * Adapt user prompt for M3 section generation
   */
  private adaptPromptForM3User(originalPrompt: string, envelope: PromptEnvelopeV1): string {
    // The M3 user prompt will be dynamically generated based on the specific section context
    // This is a placeholder that can be overridden when M3 is called with specific section data
    return `Generate detailed content for a section of the chapter "${envelope.meta.chapter}".
Use the following overall chapter requirements as context:

${originalPrompt}

When generating section content, focus on creating specific, implementable content blocks
rather than high-level planning or structure.`;
  }

  /**
   * Generate idempotency key for caching and deduplication
   */
  private generateIdempotencyKey(envelope: PromptEnvelopeV1): string {
    const components = [
      envelope.template.template_hash,
      envelope.template.vars_hash,
      envelope.attachments[0]?.file_id || 'no-attachment',
      envelope.model.name,
      envelope.meta.difficulty,
      envelope.meta.subject,
      envelope.meta.grade
    ];

    return createHash('sha256')
      .update(components.join('|'))
      .digest('hex');
  }

  /**
   * Validate PromptEnvelope before transformation
   */
  private validateEnvelope(envelope: PromptEnvelopeV1): string[] {
    const errors: string[] = [];

    // Check required fields
    if (!envelope.envelope?.correlationId) {
      errors.push('Missing correlation ID');
    }

    if (!envelope.envelope?.version || envelope.envelope.version !== '1.0.0') {
      errors.push('Invalid or missing envelope version');
    }

    if (!envelope.meta?.subject || !['Physics', 'Chemistry', 'Mathematics'].includes(envelope.meta.subject)) {
      errors.push('Invalid subject');
    }

    if (!envelope.meta?.difficulty || !['comfort', 'hustle', 'advanced'].includes(envelope.meta.difficulty)) {
      errors.push('Invalid difficulty level');
    }

    if (!envelope.model?.name || !envelope.model?.provider) {
      errors.push('Missing model configuration');
    }

    if (!envelope.template?.template_id || !envelope.template?.template_hash) {
      errors.push('Missing template metadata');
    }

    if (!envelope.messages || envelope.messages.length === 0) {
      errors.push('No messages provided');
    }

    // Validate message structure
    const systemMessage = envelope.messages?.find(m => m.role === 'system');
    const userMessage = envelope.messages?.find(m => m.role === 'user');

    if (!systemMessage || !systemMessage.content) {
      errors.push('Missing system message');
    }

    if (!userMessage || !userMessage.content) {
      errors.push('Missing user message');
    }

    // Validate contract
    if (envelope.contract?.output !== 'reader.v1') {
      errors.push('Invalid output contract - must be reader.v1');
    }

    return errors;
  }

  /**
   * Create reverse transformation: PlanRequest → PromptEnvelope
   * Useful for debugging and testing
   */
  reverseTransform(planRequest: EnhancedPlanRequest): Partial<PromptEnvelopeV1> {
    if (!planRequest._envelope_context) {
      throw new Error('Cannot reverse transform PlanRequest without envelope context');
    }

    const context = planRequest._envelope_context;

    return {
      envelope: {
        version: '1.0.0',
        correlationId: context.correlationId,
        timestamp: new Date().toISOString(),
        producer: 'prompt-injector'
      },
      meta: {
        grade: planRequest.grade,
        subject: planRequest.subject,
        chapter: planRequest.title,
        difficulty: planRequest.difficulty,
        standard: 'Unknown', // Not preserved in basic PlanRequest
      },
      template: {
        template_id: context.templateMetadata.templateId,
        template_hash: context.templateMetadata.templateHash,
        vars_hash: context.templateMetadata.varsHash
      },
      attachments: context.attachments.map(att => ({
        kind: att.kind as 'pdf',
        file_id: att.fileId,
        checksum: att.checksum
      })),
      idempotency_key: context.idempotencyKey
    };
  }

  /**
   * Utility method to check if a PlanRequest was created from PromptEnvelope
   */
  hasEnvelopeContext(planRequest: PlanRequest): planRequest is EnhancedPlanRequest {
    return '_envelope_context' in planRequest && planRequest._envelope_context !== undefined;
  }

  /**
   * Extract correlation ID from either format
   */
  getCorrelationId(input: PromptEnvelopeV1 | EnhancedPlanRequest): string | undefined {
    if ('envelope' in input) {
      return input.envelope.correlationId;
    } else if (this.hasEnvelopeContext(input)) {
      return input._envelope_context.correlationId;
    }
    return undefined;
  }

  /**
   * Get processing statistics for monitoring
   */
  getTransformationStats(): {
    transformations_total: number;
    errors_total: number;
    cache_hits: number;
    avg_processing_time_ms: number;
  } {
    // Placeholder for metrics collection
    // In production, this would track actual statistics
    return {
      transformations_total: 0,
      errors_total: 0,
      cache_hits: 0,
      avg_processing_time_ms: 0
    };
  }
}

/**
 * Convenience function for quick transformation
 */
export function transformPromptEnvelope(
  envelope: PromptEnvelopeV1,
  config?: Partial<AdapterConfig>
): TransformationResult {
  const adapter = new PromptEnvelopeAdapter(config);
  return adapter.transform(envelope);
}

/**
 * Type guard for EnhancedPlanRequest
 */
export function isEnhancedPlanRequest(obj: any): obj is EnhancedPlanRequest {
  return (
    typeof obj === 'object' &&
    'title' in obj &&
    'subject' in obj &&
    'grade' in obj &&
    'difficulty' in obj &&
    '_envelope_context' in obj
  );
}

export default PromptEnvelopeAdapter;