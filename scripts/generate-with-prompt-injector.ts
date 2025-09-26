/**
 * Enhanced Chapter Generation with Prompt-Injector Integration
 *
 * Complete pipeline implementation:
 * 1. Prompt Injector → PromptEnvelope
 * 2. Security validation and sanitization
 * 3. PromptEnvelope → ContentEngine via adapter
 * 4. LLM integration with rate limiting and caching
 * 5. Content generation and validation
 * 6. Asset compilation and assembly
 * 7. Output to renderer-compatible format
 */

import 'dotenv/config';
import path from 'node:path';
import { promises as fs } from 'fs';

// Prompt Injector imports
import { PromptEnvelopeBuilder, DEFAULT_BUILDER_CONFIG } from '../prompt-injector/buildEnvelope.js';
import { InjectorInput, PromptEnvelopeV1 } from '../prompt-injector/contracts/prompt-envelope.v1.js';
import { SecuritySanitizer } from '../prompt-injector/security/sanitizer.js';

// Content Engine imports (using dynamic imports to resolve tsx issues)
// import { ContentPipeline } from '../content-engine/fsm/src/pipeline.ts';
// import PromptEnvelopeAdapter from '../content-engine/adapters/src/prompt-envelope-adapter.ts';

// Operational infrastructure imports (using dynamic imports to resolve tsx issues)
// import { LLMRateLimiter, createRateLimiter } from '../content-engine/utils/rate-limiter.ts';
// import { CacheManager, createCacheManager } from '../content-engine/utils/cache-manager.ts';
// import { LLMClient, createLLMClient } from '../content-engine/utils/llm-client.ts';


/**
 * Enhanced generation configuration
 */
interface GenerationConfig {
  // Input configuration
  enableSecurity: boolean;
  enableLLMGeneration: boolean;
  templatePath?: string;

  // Operational configuration
  enableRateLimiting: boolean;
  enableCaching: boolean;
  enableLogging: boolean;
  enableValidation: boolean;

  // Output configuration
  outputPath: string;
  enableMetrics: boolean;

  // Performance configuration
  maxConcurrentRequests: number;
  cacheTtl: number;
  requestTimeout: number;

  // Rate limiting configuration
  requestsPerMinute: number;
  burstLimit: number;

  // Cache configuration
  cacheSize: number;
}

/**
 * Default generation configuration
 */
const DEFAULT_GENERATION_CONFIG: GenerationConfig = {
  enableSecurity: true,
  enableLLMGeneration: true,
  enableRateLimiting: true,
  enableCaching: true,
  enableLogging: true,
  enableValidation: true,
  outputPath: '.', // CRITICAL: Must be repo root for renderer spec resolution
  enableMetrics: true,
  maxConcurrentRequests: 3,
  cacheTtl: 3600000, // 1 hour in milliseconds
  requestTimeout: 60000,
  requestsPerMinute: 30,
  burstLimit: 5,
  cacheSize: 1000
};

/**
 * Generation metrics
 */
interface GenerationMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  stages: {
    prompt_envelope: number;
    security_validation: number;
    adapter_transformation: number;
    pipeline_execution: number;
    total: number;
  };
  llm_calls: {
    m1_plan: {
      attempted: boolean;
      successful: boolean;
      duration?: number;
      tokens?: number;
    };
    m3_sections: {
      attempted: boolean;
      successful: boolean;
      duration?: number;
      tokens?: number;
    };
  };
  artifacts: {
    chapter_path?: string;
    plot_specs: number;
    diagram_specs: number;
    total_assets: number;
  };
  errors: string[];
  warnings: string[];
}

/**
 * Enhanced chapter generator with full pipeline integration
 */
export class EnhancedChapterGenerator {
  private config: GenerationConfig;
  private logger: (level: string, message: string, data?: any) => void;

  // Infrastructure components
  private initPromise?: Promise<void>;
  private envelopeBuilder: PromptEnvelopeBuilder;
  private sanitizer: SecuritySanitizer;
  private adapter: any; // PromptEnvelopeAdapter;
  private rateLimiter?: any; // LLMRateLimiter;
  private cache?: any; // CacheManager;
  private llmClient?: any; // LLMClient;
  private pipeline: any; // ContentPipeline;

  constructor(config: Partial<GenerationConfig> = {}) {
    this.config = { ...DEFAULT_GENERATION_CONFIG, ...config };
    this.logger = this.createLogger();
    this.initPromise = this.initializeComponents();
  }

  /**
   * Initialize the generator asynchronously
   */
  async initialize(): Promise<void> {
    await this.initializeComponents();
  }


  /**
   * Generate chapter using complete pipeline
   */
  async generateChapter(input: InjectorInput): Promise<{
    success: boolean;
    result?: any;
    metrics: GenerationMetrics;
    errors: string[];
  }> {
    if (this.initPromise) await this.initPromise;
    const metrics = this.createMetrics();
    const errors: string[] = [];

    try {
      this.logger('info', 'Starting enhanced chapter generation', {
        chapter: input.chapter,
        subject: input.subject,
        difficulty: input.difficulty
      });

      // Stage 1: Build PromptEnvelope
      const stageStart = Date.now();
      this.logger('info', 'Stage 1: Building PromptEnvelope');

      const envelope = await this.envelopeBuilder.buildPromptEnvelope(input, this.config.templatePath);
      metrics.stages.prompt_envelope = Date.now() - stageStart;

      this.logger('info', 'PromptEnvelope created successfully', {
        correlationId: envelope.envelope.correlationId,
        templateId: envelope.template.template_id,
        idempotencyKey: envelope.idempotency_key
      });

      // Stage 2: Security validation
      const securityStart = Date.now();
      this.logger('info', 'Stage 2: Security validation');

      if (this.config.enableSecurity) {
        const validationResult = this.sanitizer.validatePromptEnvelope(envelope);
        if (!validationResult.valid) {
          throw new Error(`Security validation failed: ${validationResult.errors.join(', ')}`);
        }
        if (validationResult.warnings.length > 0) {
          metrics.warnings.push(...validationResult.warnings);
        }
      }
      metrics.stages.security_validation = Date.now() - securityStart;

      // Stage 3: Adapter transformation
      const adapterStart = Date.now();
      this.logger('info', 'Stage 3: PromptEnvelope → PlanRequest transformation');

      const transformResult = this.adapter.transform(envelope);
      if (!transformResult.success) {
        throw new Error(`Transformation failed: ${transformResult.errors.join(', ')}`);
      }
      metrics.stages.adapter_transformation = Date.now() - adapterStart;

      // Stage 4: Pipeline execution with LLM integration
      const pipelineStart = Date.now();
      this.logger('info', 'Stage 4: Content Engine pipeline execution');

      // Prepare LLM context if enabled
      let llmContext;
      if (this.config.enableLLMGeneration && this.llmClient) {
        llmContext = {
          llmClient: this.llmClient,
          m1Context: transformResult.m1Context,
          m3Context: transformResult.m3Context
        };
        this.logger('info', 'LLM integration enabled for actual content generation');
      } else {
        this.logger('info', 'Using mock content generation (LLM disabled)');
      }

      // Execute pipeline with enhanced context
      const result = await this.executeEnhancedPipeline(
        transformResult.planRequest!,
        llmContext,
        metrics
      );

      metrics.stages.pipeline_execution = Date.now() - pipelineStart;

      // Stage 5: Finalize and collect metrics
      metrics.endTime = Date.now();
      metrics.duration = metrics.endTime - metrics.startTime;
      metrics.stages.total = metrics.duration;

      if (result.status === 'SUCCESS') {
        metrics.artifacts = {
          chapter_path: result.artifacts?.chapterPath,
          plot_specs: result.artifacts?.plotSpecs.length || 0,
          diagram_specs: result.artifacts?.diagramSpecs.length || 0,
          total_assets: (result.artifacts?.plotSpecs.length || 0) + (result.artifacts?.diagramSpecs.length || 0)
        };

        this.logger('info', 'Chapter generation completed successfully', {
          correlationId: envelope.envelope.correlationId,
          duration: metrics.duration,
          artifacts: metrics.artifacts
        });

        // Log metrics if enabled
        if (this.config.enableMetrics) {
          await this.logMetrics(metrics, envelope.envelope.correlationId);
        }

        return {
          success: true,
          result,
          metrics,
          errors
        };
      } else {
        errors.push(...result.errors.map(e => `${e.module}: ${e.code}`));
        throw new Error(`Pipeline execution failed: ${result.errors.length} errors`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      metrics.errors.push(errorMessage);

      this.logger('error', 'Chapter generation failed', {
        error: errorMessage,
        duration: Date.now() - metrics.startTime,
        stage: this.getCurrentStage(metrics)
      });

      return {
        success: false,
        metrics,
        errors
      };
    }
  }

  /**
   * Execute enhanced pipeline with LLM integration
   */
  private async executeEnhancedPipeline(
    planRequest: any,
    llmContext: any,
    metrics: GenerationMetrics
  ): Promise<any> {
    // Create enhanced pipeline with proper outputPath for renderer compatibility
    // CRITICAL: Use '.' for repo root to ensure spec resolution works with renderer
    const { ContentPipeline } = await import('../content-engine/fsm/src/pipeline.ts');
    const enhancedPipeline = new ContentPipeline('.');

    // Set LLM client if available (so pipeline can build composite context)
    if (this.llmClient) {
      enhancedPipeline.setLLMClient(this.llmClient);
    }

    // If LLM context is available, inject it into the pipeline
    if (llmContext && this.config.enableLLMGeneration) {
      // Use the new setLLMContext API we added
      enhancedPipeline.setLLMContext('M1', llmContext.m1Context);
      enhancedPipeline.setLLMContext('M3', llmContext.m3Context);

      // Track LLM call attempts
      metrics.llm_calls.m1_plan.attempted = true;
      metrics.llm_calls.m3_sections.attempted = true;

      this.logger('info', 'LLM contexts set for M1 and M3 modules', {
        m1CorrelationId: llmContext.m1Context?.correlationId,
        m3CorrelationId: llmContext.m3Context?.correlationId
      });
    }

    // Execute the pipeline
    const result = await enhancedPipeline.execute(planRequest);

    // Clear LLM contexts after execution
    enhancedPipeline.clearLLMContexts();

    return result;
  }

  /**
   * Initialize all components
   */
  private async initializeComponents(): Promise<void> {
    // Create logger
    const logger = this.logger;

    // Initialize prompt envelope builder
    this.envelopeBuilder = new PromptEnvelopeBuilder({
      ...DEFAULT_BUILDER_CONFIG,
      enableLogging: this.config.enableLogging
    }, logger);

    // Initialize security sanitizer
    this.sanitizer = new SecuritySanitizer({
      enableLogging: this.config.enableLogging
    }, logger);

    // Initialize adapter using dynamic import (named export)
    const { PromptEnvelopeAdapter } = await import('../content-engine/adapters/src/prompt-envelope-adapter.ts');
    this.adapter = new PromptEnvelopeAdapter({
      enableIdempotency: true,
      validateTransformation: true,
      logTransformations: this.config.enableLogging
    }, logger);

    // Initialize operational infrastructure if enabled using dynamic imports
    if (this.config.enableRateLimiting) {
      const { createRateLimiter } = await import('../content-engine/utils/rate-limiter.ts');
      this.rateLimiter = createRateLimiter({
        maxConcurrentRequests: this.config.maxConcurrentRequests,
        requestsPerMinute: this.config.requestsPerMinute,
        burstLimit: this.config.burstLimit,
        enableLogging: this.config.enableLogging,
        enableMetrics: this.config.enableMetrics
      });
    }

    if (this.config.enableCaching) {
      const { createCacheManager } = await import('../content-engine/utils/cache-manager.ts');
      this.cache = createCacheManager({
        memoryMaxSize: this.config.cacheSize,
        defaultTtl: this.config.cacheTtl,
        enableLogging: this.config.enableLogging,
        enableMetrics: this.config.enableMetrics
      });
    }

    if (this.config.enableLLMGeneration && this.rateLimiter && this.cache) {
      const { createLLMClient } = await import('../content-engine/utils/llm-client.ts');
      this.llmClient = createLLMClient(this.rateLimiter, this.cache, logger);
    }

    // Initialize content pipeline with repo root for consistent spec resolution using dynamic import
    const { ContentPipeline } = await import('../content-engine/fsm/src/pipeline.ts');
    this.pipeline = new ContentPipeline('.');

    this.logger('info', 'Enhanced chapter generator initialized', {
      security: this.config.enableSecurity,
      llm: this.config.enableLLMGeneration,
      rateLimiting: this.config.enableRateLimiting,
      caching: this.config.enableCaching
    });
  }

  /**
   * Create logger function
   */
  private createLogger(): (level: string, message: string, data?: any) => void {
    return (level: string, message: string, data?: any) => {
      if (!this.config.enableLogging) return;

      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        level,
        message,
        ...(data && { data })
      };

      console.log(JSON.stringify(logEntry));
    };
  }

  /**
   * Create metrics tracking object
   */
  private createMetrics(): GenerationMetrics {
    return {
      startTime: Date.now(),
      stages: {
        prompt_envelope: 0,
        security_validation: 0,
        adapter_transformation: 0,
        pipeline_execution: 0,
        total: 0
      },
      llm_calls: {
        m1_plan: {
          attempted: false,
          successful: false
        },
        m3_sections: {
          attempted: false,
          successful: false
        }
      },
      artifacts: {
        plot_specs: 0,
        diagram_specs: 0,
        total_assets: 0
      },
      errors: [],
      warnings: []
    };
  }

  /**
   * Get current stage from metrics
   */
  private getCurrentStage(metrics: GenerationMetrics): string {
    if (metrics.stages.pipeline_execution > 0) return 'pipeline_execution';
    if (metrics.stages.adapter_transformation > 0) return 'adapter_transformation';
    if (metrics.stages.security_validation > 0) return 'security_validation';
    if (metrics.stages.prompt_envelope > 0) return 'prompt_envelope';
    return 'initialization';
  }

  /**
   * Log metrics for monitoring
   */
  private async logMetrics(metrics: GenerationMetrics, correlationId: string): Promise<void> {
    try {
      const metricsData = {
        correlationId,
        timestamp: new Date().toISOString(),
        ...metrics
      };

      // In production, this would send to monitoring service
      this.logger('info', 'Generation metrics', metricsData);

      // Optionally save to file
      const metricsPath = path.join(this.config.outputPath, 'metrics', `${correlationId}.json`);
      await fs.mkdir(path.dirname(metricsPath), { recursive: true });
      await fs.writeFile(metricsPath, JSON.stringify(metricsData, null, 2));

    } catch (error) {
      this.logger('warn', 'Failed to log metrics', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get health status of all components
   */
  async getHealth(): Promise<{
    healthy: boolean;
    components: Record<string, any>;
  }> {
    const components: Record<string, any> = {
      envelope_builder: true,
      security_sanitizer: true,
      adapter: true,
      content_pipeline: true
    };

    if (this.rateLimiter) {
      components.rate_limiter = this.rateLimiter.getHealth();
    }

    if (this.cache) {
      components.cache = this.cache.getHealth();
    }

    if (this.llmClient) {
      components.llm_client = await this.llmClient.getHealth();
    }

    const healthy = Object.values(components).every(status =>
      typeof status === 'boolean' ? status : status.healthy
    );

    return { healthy, components };
  }
}

/**
 * Main CLI function
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const config: Partial<GenerationConfig> = {};
  let input: Partial<InjectorInput> = {
    grade: 'Class XI',
    subject: 'Physics',
    difficulty: 'comfort',
    standard: 'NCERT'
  };

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];

    switch (flag) {
      case '--chapter':
      case '-c':
        input.chapter = value;
        break;
      case '--subject':
      case '-s':
        if (['Physics', 'Chemistry', 'Mathematics'].includes(value)) {
          input.subject = value as any;
        }
        break;
      case '--difficulty':
      case '-d':
        if (['comfort', 'hustle', 'advanced'].includes(value)) {
          input.difficulty = value as any;
        }
        break;
      case '--grade':
      case '-g':
        input.grade = value;
        break;
      case '--standard':
        input.standard = value;
        break;
      case '--pages':
      case '-p':
        input.pages_hint = value;
        break;
      case '--no-llm':
        config.enableLLMGeneration = false;
        break;
      case '--no-cache':
        config.enableCaching = false;
        break;
      case '--no-security':
        config.enableSecurity = false;
        break;
      case '--verbose':
      case '-v':
        config.enableLogging = true;
        break;
      case '--input': {
        const inputPath = path.resolve(value);
        try {
          const raw = await fs.readFile(inputPath, 'utf8');
          const chapterJson = JSON.parse(raw);
          if (chapterJson.meta) {
            if (chapterJson.meta.title) input.chapter = chapterJson.meta.title;
            if (chapterJson.meta.grade) input.grade = chapterJson.meta.grade;
            if (chapterJson.meta.subject) input.subject = chapterJson.meta.subject;
            if (chapterJson.meta.standard) input.standard = chapterJson.meta.standard;
          }
          if (Array.isArray(chapterJson.attachments) && chapterJson.attachments.length > 0) {
            const firstPdf = chapterJson.attachments.find((p: string) => typeof p === 'string' && p.toLowerCase().endsWith('.pdf'))
              || chapterJson.attachments[0];
            (input as any).chapter_pdf_path = firstPdf;
          }
        } catch (e) {
          console.error('Failed to read --input JSON:', e);
          process.exit(1);
        }
        break;
      }
      case '--pdf':
        input.chapter_pdf_path = value;
        break;
    }
  }

  // Set default chapter if not provided
  if (!input.chapter) {
    const defaultChapters = {
      'Physics': 'Laws of Motion',
      'Chemistry': 'Chemical Bonding',
      'Mathematics': 'Limits and Derivatives'
    };
    input.chapter = defaultChapters[input.subject as keyof typeof defaultChapters];
  }

  // Validate required fields
  if (!input.chapter || !input.subject || !input.difficulty || !input.standard || !input.grade) {
    console.error('Missing required fields');
    process.exit(1);
  }

  const generator = new EnhancedChapterGenerator(config);

  // Initialize the generator
  await generator.initialize();

  try {
    console.log(`🚀 Generating chapter: "${input.chapter}" (${input.subject}, ${input.difficulty})`);
    console.log('📋 Using enhanced pipeline with prompt-injector integration...\n');

    const result = await generator.generateChapter(input as InjectorInput);

    if (result.success) {
      console.log('✅ Chapter generation completed successfully!');
      console.log(`⏱️  Total time: ${result.metrics.duration}ms`);
      console.log(`📄 Chapter: ${result.metrics.artifacts.chapter_path}`);
      console.log(`📊 Assets: ${result.metrics.artifacts.total_assets} files`);

      if (result.metrics.warnings.length > 0) {
        console.log(`⚠️  Warnings: ${result.metrics.warnings.length}`);
      }

      console.log('\n🎯 Next steps:');
      console.log('   1. Run: npm run chapter:build');
      console.log('   2. Run: npm run dev');
      console.log('   3. Open: http://localhost:5173');
    } else {
      console.error('❌ Chapter generation failed:');
      result.errors.forEach(error => console.error(`   • ${error}`));
      process.exit(1);
    }

  } catch (error) {
    console.error('💥 Pipeline execution failed:', error);
    process.exit(1);
  }
}

// Help text
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Enhanced Chapter Generator with Prompt-Injector Integration

Usage: tsx scripts/generate-with-prompt-injector.ts [options]

Options:
  -c, --chapter <title>      Chapter title
  -s, --subject <subject>    Subject: Physics, Chemistry, Mathematics
  -d, --difficulty <level>   Difficulty: comfort, hustle, advanced
  -g, --grade <grade>        Grade level (default: Class XI)
  --standard <standard>      Educational standard (default: NCERT)
  -p, --pages <hint>         Page length hint
  --pdf <path>               Manual PDF path override
  --no-llm                   Disable LLM generation (use mocks)
  --no-cache                 Disable caching
  --no-security              Disable security validation
  -v, --verbose              Enable verbose logging
  -h, --help                 Show this help

Examples:
  tsx scripts/generate-with-prompt-injector.ts -c "Laws of Motion" -s Physics -d comfort
  tsx scripts/generate-with-prompt-injector.ts -c "Chemical Kinetics" -s Chemistry -d hustle -v
  tsx scripts/generate-with-prompt-injector.ts -c "Differential Equations" -s Mathematics -d advanced --no-cache

This script uses the complete prompt-injector → content-engine → renderer pipeline
with security validation, rate limiting, caching, and optional LLM integration.
`);
  process.exit(0);
}

// Robust direct-run detection for Windows/ESM
try {
  const arg = process.argv[1];
  const argHref = arg ? new URL('file://' + arg.replace(/\\/g, '/')).href : '';
  const isDirect = !arg || import.meta.url === argHref || import.meta.url.endsWith(arg.replace(/\\/g, '/'));
  if (isDirect) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    main().catch((err) => {
      console.error('💥 Script failed:', err);
      process.exit(1);
    });
  }
} catch {
  // Fallback: attempt to run main()
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main().catch((err) => {
    console.error('💥 Script failed:', err);
    process.exit(1);
  });
}