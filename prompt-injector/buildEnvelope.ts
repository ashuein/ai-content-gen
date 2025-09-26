/**
 * Prompt Envelope Builder v2.0
 *
 * Enhanced implementation using PromptEnvelopeV1 contract with:
 * - Security validation and sanitization
 * - Proper correlation ID generation
 * - Enhanced error handling and logging
 * - Template caching and optimization
 * - Comprehensive metadata tracking
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { createHash } from "crypto";
import { PromptEnvelopeV1, InjectorInput, PROMPT_ENVELOPE_CONSTANTS } from "./contracts/prompt-envelope.v1.ts";
import { SecuritySanitizer, validateInjectorInput } from "./security/sanitizer.ts";
import { CourseDatabaseResolver, CourseMetadata } from "./src/course-database-resolver.ts";

/**
 * Builder configuration
 */
export interface BuilderConfig {
  templateCachingEnabled: boolean;
  securityValidationEnabled: boolean;
  enableLogging: boolean;
  defaultTemplatePath: string;
  correlationIdPrefix: string;
  enableCourseDatabaseIntegration: boolean;
  courseDatabasePath: string;
}

/**
 * Default builder configuration
 */
export const DEFAULT_BUILDER_CONFIG: BuilderConfig = {
  templateCachingEnabled: true,
  securityValidationEnabled: true,
  enableLogging: false,
  defaultTemplatePath: "templates/exams.chapter.v1.yaml",
  correlationIdPrefix: "ch",
  enableCourseDatabaseIntegration: true,
  courseDatabasePath: "./course_database"
};

/**
 * Template cache for performance optimization
 */
const templateCache = new Map<string, { content: any; hash: string; loadedAt: number }>();

/**
 * Enhanced prompt envelope builder
 */
export class PromptEnvelopeBuilder {
  private config: BuilderConfig;
  private sanitizer: SecuritySanitizer;
  private courseDatabaseResolver?: CourseDatabaseResolver;
  private logger?: (level: string, message: string, data?: any) => void;

  constructor(config: Partial<BuilderConfig> = {}, logger?: (level: string, message: string, data?: any) => void) {
    this.config = { ...DEFAULT_BUILDER_CONFIG, ...config };
    this.sanitizer = new SecuritySanitizer({}, logger);
    this.logger = logger;

    // Initialize course database resolver if enabled
    if (this.config.enableCourseDatabaseIntegration) {
      this.courseDatabaseResolver = new CourseDatabaseResolver(this.config.courseDatabasePath, logger);
    }
  }

  /**
   * Build PromptEnvelope from InjectorInput with automatic PDF resolution
   */
  async buildPromptEnvelope(input: InjectorInput, templatePath?: string): Promise<PromptEnvelopeV1> {
    try {
      // Security validation
      if (this.config.securityValidationEnabled) {
        const validationResult = this.sanitizer.validateInjectorInput(input);
        if (!validationResult.valid) {
          throw new Error(`Security validation failed: ${validationResult.errors.join(', ')}`);
        }
        // Use sanitized input
        input = validationResult.sanitized!;
      }

      // Load template with caching
      const actualTemplatePath = templatePath || this.config.defaultTemplatePath;
      const template = this.loadTemplate(actualTemplatePath);

      // Generate correlation ID
      const correlationId = this.generateCorrelationId();

      // Extract difficulty policy
      const difficultyPolicy = template.content.difficulty_policies[input.difficulty];
      if (!difficultyPolicy) {
        throw new Error(`Unknown difficulty level: ${input.difficulty}. Available: ${Object.keys(template.content.difficulty_policies).join(', ')}`);
      }

      // Build template variables
      const templateVars = this.buildTemplateVars(input, difficultyPolicy);

      // Render prompts
      const systemPrompt = this.renderTemplate(template.content.system_prompt, templateVars);
      const userPrompt = this.renderTemplate(template.content.user_prompt, templateVars);

      // Generate hashes
      const templateHash = this.generateHash(JSON.stringify(template.content));
      const varsHash = this.generateHash(JSON.stringify(templateVars));

      // Build envelope
      const envelope: PromptEnvelopeV1 = {
        envelope: {
          version: "1.0.0",
          correlationId,
          timestamp: new Date().toISOString(),
          producer: "prompt-injector"
        },
        meta: {
          grade: input.grade,
          subject: input.subject,
          chapter: input.chapter,
          difficulty: input.difficulty,
          standard: input.standard,
          pages_hint: input.pages_hint
        },
        model: {
          provider: "openai",
          name: process.env.OPENAI_MODEL || PROMPT_ENVELOPE_CONSTANTS.DEFAULT_MODEL.name,
          temperature: template.content.llm_directives?.temperature || PROMPT_ENVELOPE_CONSTANTS.DEFAULT_MODEL.temperature,
          max_tokens: template.content.llm_directives?.max_output_tokens || PROMPT_ENVELOPE_CONSTANTS.DEFAULT_MODEL.max_tokens
        },
        attachments: [], // Will be populated when PDF is attached
        contract: {
          output: "reader.v1",
          schemas: ["reader.v1.schema.json"]
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        template: {
          template_id: `${template.content.prompt_profile}@${template.content.template_version}`,
          template_hash: templateHash,
          vars_hash: varsHash
        }
      };

      // Automatically resolve and attach PDF if course database integration is enabled
      if (this.courseDatabaseResolver && !input.chapter_pdf_path) {
        await this.autoResolvePdf(envelope, input);
      }

      // Add idempotency key
      envelope.idempotency_key = this.generateIdempotencyKey(envelope);

      if (this.config.enableLogging) {
        this.logger?.('info', 'PromptEnvelope built successfully', {
          correlationId,
          templateId: envelope.template.template_id,
          subject: input.subject,
          difficulty: input.difficulty
        });
      }

      return envelope;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.('error', 'Failed to build PromptEnvelope', {
        error: errorMessage,
        input: {
          subject: input.subject,
          chapter: input.chapter?.substring(0, 50),
          difficulty: input.difficulty
        }
      });
      throw new Error(`PromptEnvelope build failed: ${errorMessage}`);
    }
  }

  /**
   * Load template with caching
   */
  private loadTemplate(templatePath: string): { content: any; hash: string } {
    const resolvedPath = path.resolve(templatePath);

    // Check cache first
    if (this.config.templateCachingEnabled) {
      const cached = templateCache.get(resolvedPath);
      if (cached && Date.now() - cached.loadedAt < 300000) { // 5 minute cache
        return cached;
      }
    }

    try {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      const content = yaml.load(raw) as any;
      const hash = this.generateHash(raw);

      const templateData = { content, hash, loadedAt: Date.now() };

      // Cache the template
      if (this.config.templateCachingEnabled) {
        templateCache.set(resolvedPath, templateData);
      }

      return templateData;

    } catch (error) {
      throw new Error(`Failed to load template from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Build template variables from input and difficulty policy
   */
  private buildTemplateVars(input: InjectorInput, difficultyPolicy: any): Record<string, string> {
    return {
      grade: input.grade,
      subject: input.subject,
      chapter: input.chapter,
      standard: input.standard,
      difficulty: input.difficulty,
      pages_hint: input.pages_hint || "",

      // Difficulty policy variables
      difficulty_summary: difficultyPolicy.summary || "",
      difficulty_exposition: difficultyPolicy.exposition || "",
      difficulty_practice: difficultyPolicy.practice || "",
      difficulty_extras: difficultyPolicy.extras || "",
      difficulty_examples_per_concept: String(difficultyPolicy.examples_per_concept || 1),

      // Item mix variables
      difficulty_item_mcq: difficultyPolicy.item_mix?.mcq || "",
      difficulty_item_numerical: difficultyPolicy.item_mix?.numerical || "",
      difficulty_item_ar: difficultyPolicy.item_mix?.ar || "",

      // Cognitive variables
      difficulty_blooms: difficultyPolicy.blooms || "",
      difficulty_cognitive_load: difficultyPolicy.cognitive_load || "",
      difficulty_scaffolding: difficultyPolicy.scaffolding || "",

      // Subject-specific variables (conditionally populated)
      if_physics: input.subject === 'Physics' ? 'true' : '',
      if_chemistry: input.subject === 'Chemistry' ? 'true' : '',
      if_mathematics: input.subject === 'Mathematics' ? 'true' : '',

      physics_misconceptions: "vector addition, energy conservation, wave-particle duality",
      chemistry_misconceptions: "ionic vs covalent bonding, reaction rates vs equilibrium",
      math_misconceptions: "function vs equation, correlation vs causation"
    };
  }

  /**
   * Render template string with variables
   */
  private renderTemplate(template: string, vars: Record<string, string>): string {
    let rendered = template;

    // Handle simple variable substitution {{variable}}
    rendered = rendered.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
      return vars[key] || '';
    });

    // Handle conditional blocks {{#if_condition}}...{{/if_condition}}
    rendered = rendered.replace(/\{\{#([a-zA-Z_][a-zA-Z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, condition, content) => {
      return vars[condition] ? content : '';
    });

    return rendered.trim();
  }

  /**
   * Generate unique correlation ID
   */
  private generateCorrelationId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 11);
    return `${this.config.correlationIdPrefix}-${timestamp}-${random}`;
  }

  /**
   * Generate SHA256 hash
   */
  private generateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Generate idempotency key for deduplication
   */
  private generateIdempotencyKey(envelope: PromptEnvelopeV1): string {
    const components = [
      envelope.template.template_hash,
      envelope.template.vars_hash,
      envelope.model.name,
      envelope.model.temperature.toString(),
      envelope.meta.difficulty,
      envelope.meta.subject
    ];
    return this.generateHash(components.join('|'));
  }

  /**
   * Automatically resolve PDF from course database and attach it
   */
  private async autoResolvePdf(envelope: PromptEnvelopeV1, input: InjectorInput): Promise<void> {
    try {
      if (!this.courseDatabaseResolver) {
        this.logger?.('warn', 'Course database resolver not available');
        return;
      }

      const courseMetadata: CourseMetadata = {
        grade: input.grade,
        subject: input.subject,
        chapter: input.chapter,
        standard: input.standard
      };

      this.logger?.('info', 'Resolving PDF from course database', courseMetadata);

      const resolution = await this.courseDatabaseResolver.resolvePdfPath(courseMetadata);

      if (resolution.success && resolution.pdfPath && resolution.checksum) {
        this.logger?.('info', 'PDF resolved successfully', {
          pdfPath: resolution.pdfPath,
          confidence: resolution.confidence,
          method: resolution.method
        });

        // Add the PDF attachment
        envelope.attachments = [
          {
            kind: "pdf",
            file_id: resolution.pdfPath, // Use path as file_id for LLM client to resolve
            checksum: resolution.checksum
          }
        ];

        // Add metadata about the resolution
        if (!envelope.meta.pdf_resolution) {
          (envelope.meta as any).pdf_resolution = {
            confidence: resolution.confidence,
            method: resolution.method,
            resolved_at: new Date().toISOString()
          };
        }

        this.logger?.('info', 'PDF attachment added to envelope', {
          correlationId: envelope.envelope.correlationId,
          attachmentCount: envelope.attachments.length
        });
      } else {
        this.logger?.('warn', 'Failed to resolve PDF from course database', {
          error: resolution.error,
          confidence: resolution.confidence,
          method: resolution.method
        });

        // Add a warning to the envelope metadata
        if (!envelope.meta.warnings) {
          (envelope.meta as any).warnings = [];
        }
        (envelope.meta as any).warnings.push(`PDF resolution failed: ${resolution.error}`);
      }

    } catch (error) {
      this.logger?.('error', 'Error during PDF resolution', {
        error: error instanceof Error ? error.message : String(error),
        courseMetadata: { grade: input.grade, subject: input.subject, chapter: input.chapter }
      });

      // Add error to envelope metadata
      if (!envelope.meta.warnings) {
        (envelope.meta as any).warnings = [];
      }
      (envelope.meta as any).warnings.push(`PDF resolution error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Add PDF attachment to envelope
   */
  addPdfAttachment(envelope: PromptEnvelopeV1, fileId: string, checksum: string): PromptEnvelopeV1 {
    const updatedEnvelope = { ...envelope };
    updatedEnvelope.attachments = [
      {
        kind: "pdf",
        file_id: fileId,
        checksum
      }
    ];

    // Regenerate idempotency key with attachment
    updatedEnvelope.idempotency_key = this.generateIdempotencyKey(updatedEnvelope);

    return updatedEnvelope;
  }

  /**
   * Validate envelope against contract
   */
  validateEnvelope(envelope: PromptEnvelopeV1): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate structure
    if (!envelope.envelope?.correlationId?.match(PROMPT_ENVELOPE_CONSTANTS.CORRELATION_ID_PATTERN)) {
      errors.push('Invalid correlation ID format');
    }

    if (!envelope.template?.template_hash?.match(PROMPT_ENVELOPE_CONSTANTS.SHA256_PATTERN)) {
      errors.push('Invalid template hash format');
    }

    if (!envelope.template?.vars_hash?.match(PROMPT_ENVELOPE_CONSTANTS.SHA256_PATTERN)) {
      errors.push('Invalid vars hash format');
    }

    if (!PROMPT_ENVELOPE_CONSTANTS.SUPPORTED_SUBJECTS.includes(envelope.meta.subject as any)) {
      errors.push('Invalid subject');
    }

    if (!PROMPT_ENVELOPE_CONSTANTS.SUPPORTED_DIFFICULTIES.includes(envelope.meta.difficulty as any)) {
      errors.push('Invalid difficulty');
    }

    if (envelope.messages.length < 2) {
      errors.push('Missing required messages (system and user)');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Automatically resolve and attach PDF from course database, optionally compressing it
   */
  private async autoResolvePdf(
    envelope: PromptEnvelopeV1,
    input: InjectorInput
  ): Promise<void> {
    if (!this.courseDatabaseResolver) return;
    const metadata: CourseMetadata = {
      grade: input.grade,
      subject: input.subject,
      chapter: input.chapter,
      standard: input.standard,
    };
    const result = await this.courseDatabaseResolver.resolvePdfPath(metadata);
    if (!result.success || !result.pdfPath) {
      throw new Error(
        `PDF resolution failed (${result.method}): ${result.error || 'no match'}`
      );
    }
    // Handle case where pdfPath might already include the course_database prefix
    const absolutePath = result.pdfPath.startsWith('course_database')
      ? path.resolve(result.pdfPath)
      : path.resolve(this.config.courseDatabasePath, result.pdfPath);
    const compressedPath = absolutePath.replace(/\.pdf$/i, '.compressed.pdf');
    try {
      await this.compressPdf(absolutePath, compressedPath);
    } catch (err) {
      this.logger?.('warn', 'PDF compression failed, using original PDF', {
        path: absolutePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const finalPath = fs.existsSync(compressedPath) ? compressedPath : absolutePath;
    const data = fs.readFileSync(finalPath);
    const pdfChecksum =
      result.checksum ||
      createHash('sha256').update(data).digest('hex');
    // TODO: upload to OpenAI to retrieve file_id; using checksum as placeholder
    // TEMPORARILY DISABLED: PDF attachments causing OpenAI upload failures
    // envelope.attachments.push({
    //   kind: 'pdf',
    //   file_id: pdfChecksum,
    //   checksum: pdfChecksum,
    // });
  }

  /**
   * Compress PDF by invoking the Python compression script
   */
  private async compressPdf(inputPath: string, outputPath: string): Promise<void> {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const script = path.resolve(__dirname, '../scripts/compress_pdf.py');
      const proc = spawn('python', [script, inputPath, outputPath], { stdio: 'inherit' });
      proc.on('exit', (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`compress_pdf.py exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  }
}

/**
 * Convenience function using default builder
 */
export async function buildPromptEnvelope(input: InjectorInput, templatePath?: string): Promise<PromptEnvelopeV1> {
  const builder = new PromptEnvelopeBuilder();
  return await builder.buildPromptEnvelope(input, templatePath);
}
