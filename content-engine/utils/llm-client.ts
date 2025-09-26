/**
 * LLM Client Integration
 *
 * Centralized OpenAI client with:
 * - Rate limiting integration
 * - Correlation tracking
 * - Structured output handling
 * - Error handling and retries
 * - Metrics collection
 * - PDF attachment support
 */

import OpenAI from 'openai';
import { promises as fs, createReadStream } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';
import { LLMRateLimiter, RequestContext } from './rate-limiter.js';
import { CacheManager, CacheKeyType } from './cache-manager.js';
import { LLMModuleContext } from '../adapters/src/prompt-envelope-adapter.js';

/**
 * LLM request configuration
 */
export interface LLMRequestConfig {
  model?: string;
  maxTokens?: number;
  responseFormat?: 'json' | 'json_schema' | 'text';
  schema?: object;
  timeout?: number;
  enableCaching?: boolean;
  cacheTtl?: number;
}

/**
 * LLM response with metadata
 */
export interface LLMResponse<T = any> {
  content: T;
  metadata: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latency: number;
    cached: boolean;
    correlationId: string;
    requestId: string;
  };
}

/**
 * Default LLM configuration
 */
export const DEFAULT_LLM_CONFIG: Required<LLMRequestConfig> = {
  model: process.env.OPENAI_MODEL || 'gpt-5-mini',
  maxTokens: 50000,
  responseFormat: 'json_schema',
  schema: {},
  timeout: 600000,
  enableCaching: true,
  cacheTtl: 3600
};

/**
 * Enhanced LLM client with operational features
 */
export class LLMClient {
  private openai: OpenAI;
  private rateLimiter: LLMRateLimiter;
  private cache: CacheManager;
  private logger: (level: string, message: string, data?: any) => void;

  constructor(
    rateLimiter: LLMRateLimiter,
    cache: CacheManager,
    logger?: (level: string, message: string, data?: any) => void
  ) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      timeout: 600000
    });
    this.rateLimiter = rateLimiter;
    this.cache = cache;
    this.logger = logger || (() => {});
  }

  /**
   * Generate content with LLM
   */
  async generate<T>(
    context: LLMModuleContext,
    config: Partial<LLMRequestConfig> = {}
  ): Promise<LLMResponse<T>> {
    const actualConfig = { ...DEFAULT_LLM_CONFIG, ...config };
    const requestId = this.generateRequestId();

    // Create request context for rate limiting
    const requestContext: RequestContext = {
      correlationId: context.correlationId,
      operation: 'llm_generate',
      timestamp: Date.now(),
      attempt: 0,
      metadata: {
        model: actualConfig.model,
        module: this.inferModuleFromContext(context),
        subject: context.meta.subject
      }
    };

    try {
      // Check cache first
      if (actualConfig.enableCaching) {
        const cacheKey = this.buildCacheKey(context, actualConfig);
        const cached = await this.cache.get<LLMResponse<T>>(CacheKeyType.LLM_RESPONSE, cacheKey);
        if (cached) {
          this.logger?.('debug', 'LLM response served from cache', {
            correlationId: context.correlationId,
            requestId,
            cacheKey
          });
          return {
            ...cached,
            metadata: { ...cached.metadata, cached: true }
          };
        }
      }

      // Execute with rate limiting
      const response = await this.rateLimiter.execute(requestContext, async () => {
        return await this.executeOpenAIRequest<T>(context, actualConfig, requestId);
      });

      // Cache the response
      if (actualConfig.enableCaching) {
        const cacheKey = this.buildCacheKey(context, actualConfig);
        await this.cache.set(
          CacheKeyType.LLM_RESPONSE,
          cacheKey,
          response,
          actualConfig.cacheTtl,
          { correlationId: context.correlationId, model: actualConfig.model }
        );
      }

      return response;

    } catch (error) {
      this.logger?.('error', 'LLM generation failed', {
        correlationId: context.correlationId,
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Generate M3 content using structured prompt and schema validation with PDF attachment support
   */
  async generateM3Content(
    prompt: string,
    options: {
      schema?: string;
      correlationId: string;
      fileId?: string; // PDF file ID for grounding
    }
  ): Promise<any> {
    // Create a context for M3 generation with PDF support
    const context: LLMModuleContext = {
      systemPrompt: 'You are an expert educational content generator. Generate high-quality, accurate content following the exact schema provided. When a PDF is attached, use it as reference material to ensure accuracy and curriculum alignment.',
      userPrompt: prompt,
      correlationId: options.correlationId,
      fileId: options.fileId || '',
      template: {
        templateId: 'm3-content-generation',
        templateHash: this.hashString('m3-content-generation@v1'),
        varsHash: this.hashString(prompt + '|' + (options.fileId || ''))
      },
      meta: {
        subject: 'Unknown',
        grade: 'Unknown',
        difficulty: 'comfort',
        chapter: 'Unknown'
      },
      model: {
        name: process.env.OPENAI_MODEL || 'gpt-5-mini',
        provider: 'openai',
        maxTokens: 50000
      }
    };

    // Configure schema-based generation with higher token limit
    const config: Partial<LLMRequestConfig> = {
      enableSchemaValidation: !!options.schema as any,
      targetSchema: options.schema as any,
      maxTokens: 50000,
      enableCaching: false
    } as any;

    const response = await this.generate<any>(context, config);
    return response.content;
  }

  /**
   * Execute OpenAI API request
   */
  private async executeOpenAIRequest<T>(
    context: LLMModuleContext,
    config: Required<LLMRequestConfig>,
    requestId: string
  ): Promise<LLMResponse<T>> {
    const startTime = Date.now();

    try {
      // Build messages (used for Chat Completions path only)
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: context.systemPrompt },
        { role: 'user', content: context.userPrompt }
      ];

      // Build request parameters
      const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: config.model,
        messages,
        max_completion_tokens: config.maxTokens
      };

      // Do not use API-level response_format; enforce via prompt and tolerant parsing only

      // Handle file attachments if present
      let openaiFileId: string | null = null;
      if (context.fileId) {
        try {
          const uploaded = await this.uploadIfLocalPdf(context.fileId);
          if (uploaded) {
            openaiFileId = uploaded.openaiFileId;
          } else {
            throw new Error('PDF upload returned no file id');
          }
        } catch (error) {
          this.logger?.('warn', 'Failed to load file attachment', {
            correlationId: context.correlationId,
            fileId: context.fileId,
            error: error instanceof Error ? error.message : String(error)
          });
          // Enforce PDF grounding: do not fall back silently
          throw error instanceof Error ? error : new Error(String(error));
        }
      }

      this.logger?.('debug', 'Executing OpenAI request', {
        correlationId: context.correlationId,
        requestId,
        model: config.model,
        promptLength: context.systemPrompt.length + context.userPrompt.length
      });

      // Execute request using appropriate API
      let responseContent: string;
      let latency: number;
      let completion: any = null;

      const isGpt5Mini = String(config.model || '').toLowerCase() === 'gpt-5-mini';
      if (openaiFileId || isGpt5Mini) {
        // Use Responses API for PDF attachments or gpt-5-mini generally
        this.logger?.('debug', 'Using Responses API with PDF attachment', {
          correlationId: context.correlationId,
          openaiFileId,
          model: config.model
        });

        // Include schema in prompt for JSON schema requests
        let promptText = `${context.systemPrompt}\n\n${context.userPrompt}`;
        if (config.responseFormat === 'json_schema' && config.schema) {
          const schemaInstructions = this.generateSchemaInstructions('', config.schema);
          promptText += `\n\n## JSON Schema Requirements\nYour response MUST be a valid JSON object that matches this exact schema:\n\`\`\`json\n${JSON.stringify(config.schema, null, 2)}\n\`\`\`\n\n${schemaInstructions}\n\nIMPORTANT: Return ONLY the JSON object, no additional text, explanations, or code fences. Validate ALL string lengths and formats before generating the response.`;
        }

        const contentParts: any[] = [
          { type: 'input_text', text: promptText }
        ];
        if (openaiFileId) {
          contentParts.push({ type: 'input_file', file_id: openaiFileId });
        }
        const responsesPayload: any = {
          model: config.model,
          input: [
            {
              role: 'user',
              content: contentParts
            }
          ]
        };

        // HTTP fallback for models with SDK hanging issues (e.g., gpt-5-mini)
        const useHttpFallback = isGpt5Mini || process.env.OPENAI_HTTP_FALLBACK === '1';
        if (useHttpFallback) {
          this.logger?.('debug', 'Responses HTTP payload', { payload: responsesPayload });
          const httpResp = await this.responsesHttpRequest(responsesPayload);
          latency = Date.now() - startTime;
          const getOutputText = (r: any): string => {
            if (!r) return '';
            if (typeof r.output_text === 'string' && r.output_text.length > 0) return r.output_text;
            if (Array.isArray(r.output)) {
              const parts: string[] = [];
              for (const it of r.output) {
                if (it?.type === 'message' && Array.isArray(it?.content)) {
                  for (const c of it.content) {
                    if (typeof c?.text === 'string') parts.push(c.text);
                  }
                }
              }
              if (parts.length > 0) return parts.join('\n');
            }
            return '';
          };
          responseContent = getOutputText(httpResp);
        } else {
          const response = await this.openai.responses.create(responsesPayload);
          latency = Date.now() - startTime;
          // @ts-ignore
          responseContent = (response as any).output_text || (response as any).choices?.[0]?.message?.content || '';
        }

        this.logger?.('info', 'Responses API call successful with PDF attachment', {
          correlationId: context.correlationId,
          openaiFileId,
          latency
        });

      } else {
        // Use Chat Completions API for non-gpt-5-mini requests without attachments
        completion = await this.openai.chat.completions.create(requestParams);
        latency = Date.now() - startTime;
        responseContent = completion.choices[0].message.content as string;
      }

      if (!responseContent) {
        throw new Error('Empty response from OpenAI');
      }

      // Parse content; if JSON parsing fails, attempt tolerant extraction once, then one repair round
      let parsedContent: T;
      const tryParse = (text: string): T => JSON.parse(text) as T;
      const extractJson = (text: string): string | null => {
        // Prefer fenced code block with json
        const fence = text.match(/```json[\s\S]*?```/i) || text.match(/```[\s\S]*?```/);
        const candidate = fence ? fence[0].replace(/```json|```/gi, '').trim() : text;
        // Balanced braces extraction
        let depth = 0, start = -1;
        for (let i = 0; i < candidate.length; i++) {
          const c = candidate[i];
          if (c === '{') { if (depth === 0) start = i; depth++; }
          else if (c === '}') {
            depth--; if (depth === 0 && start !== -1) { return candidate.slice(start, i + 1); }
          }
        }
        return null;
      };

      if (config.responseFormat === 'json' || config.responseFormat === 'json_schema') {
        try {
          parsedContent = tryParse(responseContent);
        } catch {
          const extracted = extractJson(responseContent);
          if (!extracted) {
            // Repair round: ask model to output only JSON
            const repaired = await this.coerceJsonOnlyViaResponses(context, responseContent, config);
            const extracted2: string = (repaired ? (extractJson(repaired) || repaired) : '') as string;
            if (!extracted2) {
              throw new Error('Failed to parse JSON response: no JSON object found');
            }
            try {
              parsedContent = tryParse(extracted2);
            } catch (parseError) {
              throw new Error(`Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
            }
            // Build response metadata continues after
          }
          try {
            parsedContent = tryParse(extracted!);
          } catch (parseError) {
            // Repair round as above
            const repaired = await this.coerceJsonOnlyViaResponses(context, responseContent, config);
            const extracted2: string = (repaired ? (extractJson(repaired) || repaired) : '') as string;
            if (!extracted2) {
              throw new Error(`Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
            }
            parsedContent = tryParse(extracted2);
          }
        }
      } else {
        parsedContent = responseContent as unknown as T;
      }

      // Build response metadata (usage may differ per API)
      const usage: any = completion?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      const modelName = (openaiFileId || isGpt5Mini) ? (config.model as string) : (completion?.model || (config.model as string));
      const response: LLMResponse<T> = {
        content: parsedContent,
        metadata: {
          model: modelName,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0,
          latency,
          cached: false,
          correlationId: context.correlationId,
          requestId
        }
      };

      this.logger?.('info', 'OpenAI request successful', {
        correlationId: context.correlationId,
        requestId,
        model: modelName,
        promptTokens: response.metadata.promptTokens,
        completionTokens: response.metadata.completionTokens,
        latency
      });

      return response;

    } catch (error) {
      const latency = Date.now() - startTime;

      this.logger?.('error', 'OpenAI request failed', {
        correlationId: context.correlationId,
        requestId,
        model: config.model,
        latency,
        error: error instanceof Error ? error.message : String(error)
      });

      // Enhance error with context
      const wrapped = new Error(`OpenAI request failed [${requestId}]: ${error instanceof Error ? error.message : String(error)}`);
      throw wrapped;
    }
  }

  private async responsesHttpRequest(payload: any): Promise<any> {
    const controller = new AbortController();
    const timeoutMs = 600000;
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch((this as any).openai.baseURL ? `${(this as any).openai.baseURL}/responses` : 'https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      } as any);
      const json = await resp.json();
      if (!resp.ok) {
        const j: any = json as any;
        const msg = (j && (j.error?.message || JSON.stringify(j))) || `HTTP ${resp.status}`;
        throw new Error(`Responses HTTP failed: ${msg}`);
      }
      return json;
    } finally {
      clearTimeout(to);
    }
  }

  private async coerceJsonOnlyViaResponses(
    context: LLMModuleContext,
    previousText: string,
    config: Required<LLMRequestConfig>
  ): Promise<string | null> {
    try {
      const sys = 'You are a formatter. Output ONLY a valid JSON object matching the required schema. Do not include any prose, preface, or code fences. If content outside JSON exists, ignore it.';
      const user = `Convert the following content into a single strict JSON object only. If schema fields are missing, infer reasonable defaults and keep to the schema keys.\n\nCONTENT:\n${previousText}`;
      const resp = await this.openai.responses.create({
        model: config.model,
        input: [
          { type: 'message', role: 'system', content: [{ type: 'input_text', text: sys }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }
        ]
      } as any);
      // @ts-ignore
      const coerced: string = (resp as any).output_text || (resp as any).choices?.[0]?.message?.content || '';
      return coerced || null;
    } catch (e) {
      this.logger?.('warn', 'JSON coercion via Responses failed', { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /**
   * Generate content with schema validation
   */
  async generateWithSchema<T>(
    context: LLMModuleContext,
    schema: object,
    config: Partial<LLMRequestConfig> = {}
  ): Promise<LLMResponse<T>> {
    return this.generate<T>(context, {
      ...config,
      responseFormat: 'json_schema',
      schema
    });
  }

  /**
   * Generate content for M1-Plan module
   */
  async generateDocPlan(
    context: LLMModuleContext,
    schema: object
  ): Promise<LLMResponse<any>> {
    return this.generateWithSchema(context, schema, {
      model: context.model.name,
      maxTokens: context.model.maxTokens,
      cacheTtl: 7200 // 2 hours for planning
    });
  }

  /**
   * Generate content for M3-Section module
   */
  async generateSectionContent(
    context: LLMModuleContext,
    schema: object
  ): Promise<LLMResponse<any>> {
    return this.generateWithSchema(context, schema, {
      model: context.model.name,
      maxTokens: context.model.maxTokens,
      cacheTtl: 3600 // 1 hour for sections
    });
  }

  /**
   * Build cache key for request
   */
  private buildCacheKey(context: LLMModuleContext, config: Required<LLMRequestConfig>): string {
    const keyComponents = {
      templateHash: context.template.templateHash,
      varsHash: context.template.varsHash,
      model: config.model,
      systemPrompt: this.hashString(context.systemPrompt),
      userPrompt: this.hashString(context.userPrompt),
      schema: config.schema ? this.hashString(JSON.stringify(config.schema)) : '',
      fileId: context.fileId || ''
    };

    return this.hashString(JSON.stringify(keyComponents));
  }

  /**
   * Hash string for consistent caching
   */
  private hashString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Generate schema-specific instructions based on the schema type
   */
  private generateSchemaInstructions(schemaName: string, schema: any): string {
    // For equation-block schema (M3 equation generation)
    if (schemaName.includes('equation-block') || (schema && schema.properties && schema.properties.latex && schema.properties.variables)) {
      return `## CRITICAL FORMAT REQUIREMENTS FOR EQUATION CONTENT:
- latex: LaTeX equation WITHOUT surrounding $ delimiters (e.g., "v = u + at" not "$v = u + at$")
- description: Plain text explanation of what the equation represents
- variables: Array of objects with symbol, description, and units for each variable
- derivationHint: Optional hint about how the equation is derived

## CRITICAL LENGTH CONSTRAINTS:
- latex: MINIMUM 3 characters, MAXIMUM 500 characters, no $ delimiters
- description: MINIMUM 10 characters, MAXIMUM 300 characters
- variable symbols: MINIMUM 1 character, MAXIMUM 10 characters each
- variable descriptions: MINIMUM 3 characters, MAXIMUM 100 characters each
- variable units: MINIMUM 1 character, MAXIMUM 20 characters each (use SI units)
- derivationHint: MAXIMUM 200 characters`;
    }

    // For prose-block schema (M3 content generation)
    if (schemaName.includes('prose-block') || (schema && schema.properties && schema.properties.markdown && schema.properties.wordCount)) {
      return `## CRITICAL FORMAT REQUIREMENTS FOR PROSE CONTENT:
- markdown: Write formal textbook paragraphs (no headings, lists, or code formatting)
- wordCount: Accurate count of words in the markdown content
- keyTerms: Array of key terms introduced or explained (2-50 characters each, max 8 items)
- difficulty: Must be exactly "comfort", "hustle", or "advanced"

## CRITICAL LENGTH CONSTRAINTS:
- markdown: MINIMUM 50 characters, MAXIMUM 2000 characters
- keyTerms items: MINIMUM 2 characters, MAXIMUM 50 characters each`;
    }

    // For docplan schema (M1 plan generation)
    if (schemaName.includes('docplan') || (schema && schema.properties && schema.properties.beats)) {
      return `## CRITICAL FORMAT REQUIREMENTS:
- beat IDs: Must be "beat-" followed by lowercase letters, numbers, and hyphens only (e.g., "beat-intro", "beat-velocity-1", "beat-kinematics")
- beat prereqs: Must reference existing beat IDs using the same format
- All IDs: Use ONLY lowercase letters, numbers, and single hyphens (no underscores or capital letters)

## CRITICAL LENGTH CONSTRAINTS:
- assessment_outline items: MAXIMUM 100 characters each (strictly enforced)
- learning_objectives: MAXIMUM 150 characters each
- beat headlines: MAXIMUM 100 characters each
- beat outcomes: MAXIMUM 200 characters each
- misconceptions: MAXIMUM 200 characters each
- glossary_seed terms: MAXIMUM 50 characters each`;
    }

    // Default/fallback instructions
    return `## CRITICAL FORMAT REQUIREMENTS:
- Follow the exact schema structure provided
- Ensure all required fields are present
- Use appropriate data types for each field`;
  }

  /**
   * Load file content for attachment support
   */
  private async loadFileContent(fileId: string): Promise<{ filename: string; content: string } | null> {
    try {
      // Try loading from temporary upload directory first
      const tempFilePath = path.join(process.cwd(), 'temp', 'uploads', `${fileId}.json`);

      if (await fs.access(tempFilePath).then(() => true).catch(() => false)) {
        const fileData = JSON.parse(await fs.readFile(tempFilePath, 'utf8'));
        return {
          filename: fileData.originalName || fileId,
          content: fileData.content || fileData.text || ''
        };
      }

      // Fallback: try direct file path if fileId is a path
      if (fileId.includes('.') || fileId.includes('/') || fileId.includes('\\')) {
        const resolvedPath = path.resolve(process.cwd(), fileId);
        if (await fs.access(resolvedPath).then(() => true).catch(() => false)) {
          const filename = path.basename(resolvedPath);

          // Handle PDF files by uploading to OpenAI
          if (filename.toLowerCase().endsWith('.pdf')) {
            try {
              this.logger?.('info', 'Uploading PDF file to OpenAI', { resolvedPath, filename });

              // Read the PDF file as buffer
              const fileBuffer = await fs.readFile(resolvedPath);

              // Upload file to OpenAI
              const file = await this.openai.files.create({
                file: new File([fileBuffer], filename, { type: 'application/pdf' }),
                purpose: 'assistants'
              });

              this.logger?.('info', 'PDF uploaded to OpenAI successfully', {
                filename,
                fileId: file.id,
                sizeBytes: file.bytes
              });

              // Return the OpenAI file ID for use in Responses API
              return {
                filename,
                content: file.id // Return OpenAI file ID instead of content
              };

            } catch (uploadError) {
              this.logger?.('error', 'PDF upload to OpenAI failed', {
                filename,
                error: uploadError instanceof Error ? uploadError.message : String(uploadError)
              });

              // Fallback: return error message
              return {
                filename,
                content: `[PDF Upload Failed: ${filename}]\n\nError uploading to OpenAI: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`
              };
            }
          }

          // For unsupported non-PDF files, do not inline content
          return {
            filename,
            content: ''
          };
        }
      }

      this.logger?.('warn', 'File not found for attachment', { fileId });
      return null;

    } catch (error) {
      this.logger?.('error', 'Error loading file content', {
        fileId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 11);
    return `req-${timestamp}-${random}`;
  }

  /**
   * Infer module from context
   */
  private inferModuleFromContext(context: LLMModuleContext): string {
    // Simple heuristic based on prompt content
    if (context.systemPrompt.includes('planning') || context.systemPrompt.includes('beats')) {
      return 'M1-Plan';
    } else if (context.systemPrompt.includes('section') || context.systemPrompt.includes('content')) {
      return 'M3-Section';
    }
    return 'Unknown';
  }

  /**
   * Get client health status
   */
  async getHealth(): Promise<{
    healthy: boolean;
    openai_api: boolean;
    rate_limiter: any;
    cache: any;
    last_request?: number;
  }> {
    const rateLimiterHealth = this.rateLimiter.getHealth();
    const cacheHealth = this.cache.getHealth();

    return {
      healthy: rateLimiterHealth.healthy && cacheHealth.healthy,
      openai_api: !!process.env.OPENAI_API_KEY,
      rate_limiter: rateLimiterHealth,
      cache: cacheHealth
    };
  }

  /**
   * Get client metrics
   */
  getMetrics(): {
    rate_limiter: any;
    cache: any;
  } {
    return {
      rate_limiter: this.rateLimiter.getMetrics(),
      cache: this.cache.getMetrics()
    };
  }

  /**
   * Upload local PDF file to OpenAI and return file ID
   */
  private async uploadIfLocalPdf(fileId: string): Promise<{ openaiFileId: string } | null> {
    try {
      // Check if fileId is a local path
      if (!fileId.includes('.pdf')) {
        return null;
      }

      // Resolve the path relative to project root
      const resolvedPath = path.resolve(fileId);

      // Check if file exists
      try {
        await fs.access(resolvedPath);
      } catch {
        this.logger?.('warn', 'PDF file not found for upload', { path: resolvedPath });
        return null;
      }

      const filename = path.basename(resolvedPath);
      const stat = await fs.stat(resolvedPath);
      const maxBytes = Number(process.env.OPENAI_FILES_MAX_BYTES || 15 * 1024 * 1024); // default 15MB

      // First: try Python pypdf compression (lossless + dedup), output to tmp-tex
      const tmpDir = path.resolve(process.cwd(), 'tmp-tex');
      await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
      const pyOut = path.join(tmpDir, `pypdf-${this.hashString(resolvedPath)}.pdf`);
      const pyOk = await this.compressPdfWithPyPdf(resolvedPath, pyOut);

      let candidatePath = pyOk ? pyOut : resolvedPath;

      // If still above max size, iteratively reduce image quality
      let candStat = await fs.stat(candidatePath);
      if (candStat.size > maxBytes) {
        const qualities = [85, 70, 60, 50, 40, 30];
        for (const q of qualities) {
          const qOut = path.join(tmpDir, `pypdf-q${q}-${this.hashString(resolvedPath)}.pdf`);
          const ok = await this.compressPdfWithPyPdf(resolvedPath, qOut, q);
          if (ok) {
            const qStat = await fs.stat(qOut);
            this.logger?.('info', 'pypdf lossy compression attempt', { quality: q, bytes: qStat.size });
            if (qStat.size < candStat.size) {
              candidatePath = qOut;
              candStat = qStat;
            }
            if (qStat.size <= maxBytes) {
              break;
            }
          }
        }
      }

      // Do not use Ghostscript; pypdf-only compression policy

      try {
        const upload = await this.openai.files.create({
          file: createReadStream(candidatePath),
          purpose: 'user_data'
        });

        this.logger?.('info', 'PDF uploaded to OpenAI successfully', {
          originalPath: fileId,
          filename: path.basename(candidatePath),
          openaiFileId: upload.id,
          sizeBytes: upload.bytes
        });

        return { openaiFileId: upload.id };
      } catch (firstErr) {
        const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const is413 = message.includes('413') || message.toLowerCase().includes('exceeds the capacity limit');

        if (is413) {
          this.logger?.('warn', 'Upload failed due to size; attempting stronger compression', {
            filename,
            error: message
          });
          // Nothing else to do here; pre-upload compression already iterated qualities.
          return null;
        }

        // Non-413 or compression not possible
        this.logger?.('error', 'PDF upload to OpenAI failed', {
          filename,
          error: message
        });
        return null;
      }

    } catch (error) {
      this.logger?.('error', 'Failed to upload PDF to OpenAI', {
        fileId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  // Ghostscript compression removed per policy: pypdf-only

  private async compressPdfWithPyPdf(inputPath: string, outputPath: string, imageQuality?: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const py = process.platform.startsWith('win') ? 'python' : 'python3';
      const args = [
        path.resolve('python/rdkit_service/pdf_compress.py'),
        inputPath,
        outputPath
      ];
      if (typeof imageQuality === 'number') {
        args.push(String(imageQuality));
      }
      const proc = spawn(py, args, { windowsHide: true });
      proc.on('error', () => resolve(false));
      proc.on('close', async (code) => {
        if (code === 0) {
          try {
            const [inStat, outStat] = await Promise.all([fs.stat(inputPath), fs.stat(outputPath)]);
            if (outStat.size > 0 && outStat.size <= inStat.size) {
              this.logger?.('info', 'pypdf compression succeeded', { savedBytes: inStat.size - outStat.size });
              resolve(true);
              return;
            }
          } catch {}
        }
        resolve(false);
      });
    });
  }

  /**
   * Attempt to upload the first N pages of a PDF, backing off N until upload succeeds.
   */
  private async tryUploadFirstPages(inputPath: string): Promise<{ openaiFileId: string } | null> {
    const pageCandidates = [30, 20, 15, 10, 8, 6, 4];
    for (const pages of pageCandidates) {
      const sliced = await this.slicePdfWithGhostscript(inputPath, 1, pages);
      if (!sliced) {
        continue;
      }
      // Also attempt compression on the slice
      const compressed = sliced; // Ghostscript compression removed; use sliced directly
      try {
        const upload = await this.openai.files.create({ file: createReadStream(compressed), purpose: 'user_data' });
        this.logger?.('info', 'Uploaded sliced PDF segment successfully', { pages, fileId: upload.id });
        return { openaiFileId: upload.id };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!(message.includes('413') || message.toLowerCase().includes('exceeds the capacity limit'))) {
          // Non-size error → abort
          this.logger?.('error', 'Upload of sliced PDF failed with non-size error', { pages, error: message });
          return null;
        }
        // else continue to smaller page count
        this.logger?.('warn', 'Sliced PDF still too large, reducing pages', { pages, error: message });
      }
    }
    this.logger?.('error', 'All sliced PDF upload attempts failed');
    return null;
  }

  /**
   * Slice a PDF to [firstPage, lastPage] inclusive using Ghostscript.
   */
  private async slicePdfWithGhostscript(inputPath: string, firstPage: number, lastPage: number): Promise<string | null> {
    try {
      const gsPath = path.resolve(process.cwd(), 'ghostpdl-10.06.0', 'bin', 'gswin64c.exe');
      try {
        await fs.access(gsPath);
      } catch {
        this.logger?.('warn', 'Ghostscript not found; cannot slice PDF', { gsPath });
        return null;
      }
      const outDir = path.resolve(process.cwd(), 'tmp-tex');
      await fs.mkdir(outDir, { recursive: true }).catch(() => {});
      const outPath = path.join(outDir, `slice-${firstPage}-${lastPage}-${this.hashString(inputPath)}.pdf`);
      try {
        await fs.access(outPath);
        return outPath;
      } catch {}

      const args = [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.6',
        `-dFirstPage=${firstPage}`,
        `-dLastPage=${lastPage}`,
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        `-sOutputFile=${outPath}`,
        inputPath
      ];
      const exitCode: number = await new Promise((resolve) => {
        const proc = spawn(gsPath, args, { windowsHide: true });
        proc.on('error', () => resolve(1));
        proc.on('close', (code) => resolve(code ?? 1));
      });
      if (exitCode === 0) {
        return outPath;
      }
      this.logger?.('error', 'Ghostscript page slicing failed', { inputPath, firstPage, lastPage, exitCode });
      return null;
    } catch (err) {
      this.logger?.('error', 'PDF slicing threw', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

/**
 * Convenience function to create LLM client
 */
export function createLLMClient(
  rateLimiter: LLMRateLimiter,
  cache: CacheManager,
  logger?: (level: string, message: string, data?: any) => void
): LLMClient {
  return new LLMClient(rateLimiter, cache, logger);
}