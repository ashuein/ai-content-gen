/**
 * PromptEnvelope v1.0 Contract
 *
 * Frozen interface for Prompt Injector → Content Engine communication.
 * This contract defines the standard message format for educational content generation.
 *
 * Version: 1.0.0
 * Created: 2025-01-21
 *
 * IMPORTANT: This interface is frozen. Any changes require a new version (v1.1, v2.0, etc.)
 */

export interface PromptEnvelopeV1 {
  /** Standard envelope metadata for versioning and tracking */
  envelope: {
    version: "1.0.0";
    correlationId: string;      // Format: ch-{timestamp}-{random}
    timestamp: string;          // ISO 8601 timestamp
    producer: "prompt-injector";
  };

  /** Educational content metadata */
  meta: {
    grade: string;              // e.g., "Class XI", "Grade 10"
    subject: "Physics" | "Chemistry" | "Mathematics";
    chapter: string;            // Chapter title
    difficulty: "comfort" | "hustle" | "advanced";
    standard: string;           // Educational standard (NCERT, CBSE, etc.)
    pages_hint?: string;        // Optional length guidance
  };

  /** LLM configuration and preferences */
  model: {
    provider: "openai";         // Only OpenAI supported in v1
    name: string;               // e.g., "gpt-5-mini", "gpt-4o"
    temperature: number;        // 0.0 to 1.0
    max_tokens: number;         // Maximum output tokens
  };

  /** File attachments (PDFs, reference materials) */
  attachments: Array<{
    kind: "pdf";                // Only PDF supported in v1
    file_id: string;            // OpenAI file ID
    checksum: string;           // SHA256 of file content
  }>;

  /** Output contract specification */
  contract: {
    output: "reader.v1";        // Target output schema
    schemas: ["reader.v1.schema.json"];  // Required validation schemas
  };

  /** Prompt messages for LLM */
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;

  /** Template provenance and caching */
  template: {
    template_id: string;        // e.g., "exams.chapter.v1"
    template_hash: string;      // SHA256 of template content
    vars_hash: string;          // SHA256 of template variables
  };

  /** Idempotency key for deduplication (optional) */
  idempotency_key?: string;     // SHA256(template_hash + vars_hash + file_id + model)
}

/**
 * Input type for building PromptEnvelope
 * This is the simplified interface users provide
 */
export interface InjectorInput {
  grade: string;
  subject: "Physics" | "Chemistry" | "Mathematics";
  chapter: string;
  standard: string;
  difficulty: "comfort" | "hustle" | "advanced";
  pages_hint?: string;
  chapter_pdf_path?: string;    // Local file path (will be uploaded to get file_id)
}

/**
 * Configuration for LLM model preferences
 */
export interface ModelConfig {
  provider: "openai";
  name: string;
  temperature: number;
  max_tokens: number;
}

/**
 * Template metadata for reproducibility
 */
export interface TemplateMetadata {
  template_id: string;
  template_hash: string;
  vars_hash: string;
  computed_at: string;          // ISO timestamp
}

/**
 * Attachment metadata with security info
 */
export interface AttachmentMetadata {
  kind: "pdf";
  file_id: string;
  checksum: string;
  uploaded_at: string;          // ISO timestamp
  file_size: number;            // Bytes
  original_name: string;        // Original filename
}

/**
 * Extended PromptEnvelope with additional metadata
 * Used internally for audit trails and debugging
 */
export interface PromptEnvelopeExtended extends PromptEnvelopeV1 {
  internal?: {
    template_metadata?: TemplateMetadata;
    attachment_metadata?: AttachmentMetadata[];
    processing_hints?: {
      priority: "low" | "normal" | "high";
      cache_ttl?: number;       // Seconds
      retry_policy?: "standard" | "aggressive" | "conservative";
    };
  };
}

/**
 * Validation result for PromptEnvelope
 */
export interface EnvelopeValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  metadata?: {
    validated_at: string;
    validator_version: string;
  };
}

/**
 * Type guards for runtime validation
 */
export function isPromptEnvelopeV1(obj: any): obj is PromptEnvelopeV1 {
  return (
    typeof obj === 'object' &&
    obj.envelope?.version === '1.0.0' &&
    obj.envelope?.producer === 'prompt-injector' &&
    obj.meta?.subject &&
    ['Physics', 'Chemistry', 'Mathematics'].includes(obj.meta.subject) &&
    obj.meta?.difficulty &&
    ['comfort', 'hustle', 'advanced'].includes(obj.meta.difficulty) &&
    obj.model?.provider === 'openai' &&
    obj.contract?.output === 'reader.v1' &&
    Array.isArray(obj.messages) &&
    obj.template?.template_id
  );
}

export function isInjectorInput(obj: any): obj is InjectorInput {
  return (
    typeof obj === 'object' &&
    typeof obj.grade === 'string' &&
    ['Physics', 'Chemistry', 'Mathematics'].includes(obj.subject) &&
    typeof obj.chapter === 'string' &&
    typeof obj.standard === 'string' &&
    ['comfort', 'hustle', 'advanced'].includes(obj.difficulty)
  );
}

/**
 * Constants for validation and defaults
 */
export const PROMPT_ENVELOPE_CONSTANTS = {
  VERSION: '1.0.0' as const,
  PRODUCER: 'prompt-injector' as const,
  SUPPORTED_SUBJECTS: ['Physics', 'Chemistry', 'Mathematics'] as const,
  SUPPORTED_DIFFICULTIES: ['comfort', 'hustle', 'advanced'] as const,
  SUPPORTED_PROVIDERS: ['openai'] as const,
  OUTPUT_CONTRACT: 'reader.v1' as const,

  // Validation limits
  MAX_CHAPTER_LENGTH: 200,
  MAX_GRADE_LENGTH: 50,
  MAX_STANDARD_LENGTH: 100,
  MAX_PAGES_HINT_LENGTH: 500,
  MAX_MESSAGE_CONTENT_LENGTH: 100000,
  MAX_ATTACHMENTS: 5,

  // Default model configuration
  DEFAULT_MODEL: {
    provider: 'openai' as const,
    name: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 16000
  },

  // Correlation ID format
  CORRELATION_ID_PATTERN: /^ch-[a-z0-9]+-[a-z0-9]+$/,

  // Hash format validation
  SHA256_PATTERN: /^[a-f0-9]{64}$/
} as const;