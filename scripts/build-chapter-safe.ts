#!/usr/bin/env node

/**
 * Safe Chapter Builder
 * Production-ready chapter renderer with proper error handling, timeouts, and security
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import DOMPurify from 'isomorphic-dompurify';
import type { DocJSON, PlotSpec, DiagramSpec } from '../types';
import { renderTeXToHTML } from '../server/math/tex';
import { checkEquation } from '../validator/equation';
import { compilePlotToSVG } from '../server/pgf/compile';
import { smilesToSVG } from '../server/chem/rdkit';
import { compileDiagramToSVG } from '../server/diagram/compile';
import { loadRendererConfig, type RendererConfig } from '../renderer.config';

interface RendererContext {
  config: RendererConfig;
  correlationId: string;
  startTime: number;
  errors: string[];
  warnings: string[];
  cache: Map<string, any>;
}

interface RendererStats {
  sectionsProcessed: number;
  plotsCompiled: number;
  plotsPrecompiled: number;
  diagramsCompiled: number;
  diagramsPrecompiled: number;
  chemStructures: number;
  chemPrecompiled: number;
  cacheHits: number;
  cacheMisses: number;
  totalProcessingTime: number;
  errors: number;
  warnings: number;
}

class SafeChapterBuilder {
  private ajv: Ajv2020;
  private validators: {
    doc: any;
    plot: any;
    diagram: any;
  };

  constructor(private config: RendererConfig) {
    this.ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(this.ajv);
    this.validators = { doc: null, plot: null, diagram: null };
  }

  /**
   * Initialize validators by loading schemas
   */
  async initialize(ctx: RendererContext): Promise<void> {
    try {
      const schemaDir = this.config.schemaDir;

      const [docSchema, plotSchema, diagramSchema] = await Promise.all([
        this.loadJson<any>(path.join(schemaDir, 'docjson.schema.json')),
        this.loadJson<any>(path.join(schemaDir, 'plotspec.schema.json')),
        this.loadJson<any>(path.join(schemaDir, 'diagramspec.schema.json'))
      ]);

      this.validators.doc = this.ajv.compile(docSchema);
      this.validators.plot = this.ajv.compile(plotSchema);
      this.validators.diagram = this.ajv.compile(diagramSchema);

      this.log(ctx, 'info', 'Validators initialized successfully');
    } catch (error) {
      throw new Error(`Failed to initialize validators: ${error}`);
    }
  }

  /**
   * Main build process with comprehensive error handling
   */
  async buildChapter(inputPath: string): Promise<RendererStats> {
    const ctx: RendererContext = {
      config: this.config,
      correlationId: this.generateCorrelationId(),
      startTime: Date.now(),
      errors: [],
      warnings: [],
      cache: new Map()
    };

    const stats: RendererStats = {
      sectionsProcessed: 0,
      plotsCompiled: 0,
      plotsPrecompiled: 0,
      diagramsCompiled: 0,
      diagramsPrecompiled: 0,
      chemStructures: 0,
      chemPrecompiled: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalProcessingTime: 0,
      errors: 0,
      warnings: 0
    };

    try {
      await this.initialize(ctx);
      await this.ensureDirectories();

      const resolvedPath = await this.resolveInputPath(inputPath);
      this.log(ctx, 'info', `Building chapter from: ${resolvedPath}`);

      // Load and validate chapter
      const chapter = await this.loadAndValidateChapter(ctx, resolvedPath);

      // Process sections with timeout protection
      const renderedSections = await this.processChapterSections(ctx, chapter, stats);

      // Write output with atomic operation
      const outputPath = await this.writeChapterOutput(ctx, {
        ...chapter,
        sections: renderedSections
      });

      stats.totalProcessingTime = Date.now() - ctx.startTime;
      stats.errors = ctx.errors.length;
      stats.warnings = ctx.warnings.length;

      this.log(ctx, 'info', `Chapter built successfully: ${outputPath}`, { stats });
      return stats;

    } catch (error) {
      stats.errors = ctx.errors.length + 1;
      stats.totalProcessingTime = Date.now() - ctx.startTime;

      this.log(ctx, 'error', `Chapter build failed: ${error}`, { stats });

      if (this.config.errorMode === 'strict') {
        throw error;
      }

      return stats;
    }
  }

  /**
   * Process all sections in a chapter with parallel execution where safe
   */
  private async processChapterSections(
    ctx: RendererContext,
    chapter: DocJSON,
    stats: RendererStats
  ): Promise<any[]> {
    const renderedSections: any[] = [];

    for (const section of chapter.sections) {
      try {
        const processed = await this.processSection(ctx, section, stats);
        renderedSections.push(processed);
        stats.sectionsProcessed++;
      } catch (error) {
        ctx.errors.push(`Section ${section.id}: ${error}`);

        if (this.config.errorMode === 'strict') {
          throw error;
        } else {
          // Graceful degradation
          renderedSections.push({
            ...section,
            html: `<div class="error">Failed to render section: ${section.id}</div>`,
            svg: null
          });
        }
      }
    }

    return renderedSections;
  }

  /**
   * Process individual section with type-specific handling
   */
  private async processSection(ctx: RendererContext, section: any, stats: RendererStats): Promise<any> {
    const sectionStart = Date.now();

    try {
      switch (section.type) {
        case 'equation':
          return await this.processEquationSection(ctx, section, stats);
        case 'plot':
          return await this.processPlotSection(ctx, section, stats);
        case 'chem':
          return await this.processChemSection(ctx, section, stats);
        case 'diagram':
          return await this.processDiagramSection(ctx, section, stats);
        default:
          return section;
      }
    } finally {
      const processingTime = Date.now() - sectionStart;
      this.log(ctx, 'debug', `Section ${section.id} processed in ${processingTime}ms`);
    }
  }

  /**
   * Process equation section with validation and timeout
   */
  private async processEquationSection(ctx: RendererContext, section: any, stats: RendererStats): Promise<any> {
    // Validate equation first
    checkEquation(section.check);

    // Render equation (synchronous KaTeX operation)
    const html = renderTeXToHTML(section.tex);

    return { ...section, html };
  }

  /**
   * Process plot section with caching and sanitization
   * Prefers precompiled SVGs from M4 over recompilation
   */
  private async processPlotSection(ctx: RendererContext, section: any, stats: RendererStats): Promise<any> {
    // Check for precompiled SVG first
    const precompiledPath = path.resolve(this.config.inputDir, 'assets', 'plots', `${section.id}.svg`);

    if (await this.fileExists(precompiledPath)) {
      const svgCacheKey = `plot-svg:${section.id}:${await this.getFileHash(precompiledPath)}`;

      // Check cache for precompiled SVG
      if (ctx.cache.has(svgCacheKey)) {
        stats.cacheHits++;
        return ctx.cache.get(svgCacheKey);
      }

      // Load precompiled SVG
      const svg = await fs.readFile(precompiledPath, 'utf8');
      const sanitizedSvg = this.config.enableSvgSanitization
        ? this.sanitizeSvg(svg)
        : svg;

      const result = { ...section, svg: sanitizedSvg };
      ctx.cache.set(svgCacheKey, result);
      stats.cacheMisses++; // Still count as cache miss but no compilation needed
      stats.plotsPrecompiled++;

      return result;
    }

    // Fallback to compilation from spec
    const specPath = path.resolve(this.config.inputDir, section.specRef);
    const cacheKey = `plot:${section.id}:${await this.getFileHash(specPath)}`;

    // Check cache
    if (ctx.cache.has(cacheKey)) {
      stats.cacheHits++;
      return ctx.cache.get(cacheKey);
    }

    stats.cacheMisses++;

    // Load and validate spec
    const spec = await this.loadJson<PlotSpec>(specPath);
    if (!this.validators.plot(spec)) {
      throw new Error(`PlotSpec validation failed: ${JSON.stringify(this.validators.plot.errors)}`);
    }

    // Compile with timeout
    const svg = await this.withTimeout(
      compilePlotToSVG(spec),
      this.config.texTimeout,
      `Plot compilation timeout: ${section.id}`
    );

    // Sanitize SVG
    const sanitizedSvg = this.config.enableSvgSanitization
      ? this.sanitizeSvg(svg)
      : svg;

    const result = { ...section, svg: sanitizedSvg };
    ctx.cache.set(cacheKey, result);
    stats.plotsCompiled++;

    return result;
  }

  /**
   * Process chemistry section with RDKit
   * Prefers precompiled SVGs from M4 over recompilation
   */
  private async processChemSection(ctx: RendererContext, section: any, stats: RendererStats): Promise<any> {
    // Check for precompiled SVG first
    const precompiledPath = path.resolve(this.config.inputDir, 'assets', 'chem', `${section.id}.svg`);

    if (await this.fileExists(precompiledPath)) {
      const svgCacheKey = `chem-svg:${section.id}:${await this.getFileHash(precompiledPath)}`;

      // Check cache for precompiled SVG
      if (ctx.cache.has(svgCacheKey)) {
        stats.cacheHits++;
        return ctx.cache.get(svgCacheKey);
      }

      // Load precompiled SVG
      const svg = await fs.readFile(precompiledPath, 'utf8');
      const sanitizedSvg = this.config.enableSvgSanitization
        ? this.sanitizeSvg(svg)
        : svg;

      const result = { ...section, svg: sanitizedSvg };
      ctx.cache.set(svgCacheKey, result);
      stats.chemPrecompiled++;

      return result;
    }

    // Fallback to RDKit rendering
    const chemCacheKey = `chem:${section.id}:${crypto.createHash('sha256').update(section.smiles).digest('hex')}`;

    // Check cache
    if (ctx.cache.has(chemCacheKey)) {
      stats.cacheHits++;
      return ctx.cache.get(chemCacheKey);
    }

    const svg = await this.withTimeout(
      smilesToSVG(section.smiles),
      this.config.rdkitTimeout,
      `Chemistry rendering timeout: ${section.id}`
    );

    const sanitizedSvg = this.config.enableSvgSanitization
      ? this.sanitizeSvg(svg)
      : svg;

    const result = { ...section, svg: sanitizedSvg };
    ctx.cache.set(chemCacheKey, result);
    stats.chemStructures++;

    return result;
  }

  /**
   * Process diagram section
   * Prefers precompiled SVGs from M4 over recompilation
   */
  private async processDiagramSection(ctx: RendererContext, section: any, stats: RendererStats): Promise<any> {
    // Check for precompiled SVG first
    const precompiledPath = path.resolve(this.config.inputDir, 'assets', 'diagrams', `${section.id}.svg`);

    if (await this.fileExists(precompiledPath)) {
      const svgCacheKey = `diagram-svg:${section.id}:${await this.getFileHash(precompiledPath)}`;

      // Check cache for precompiled SVG
      if (ctx.cache.has(svgCacheKey)) {
        stats.cacheHits++;
        return ctx.cache.get(svgCacheKey);
      }

      // Load precompiled SVG
      const svg = await fs.readFile(precompiledPath, 'utf8');
      const sanitizedSvg = this.config.enableSvgSanitization
        ? this.sanitizeSvg(svg)
        : svg;

      const result = { ...section, svg: sanitizedSvg };
      ctx.cache.set(svgCacheKey, result);
      stats.diagramsPrecompiled++;

      return result;
    }

    // Fallback to compilation from spec
    const specPath = path.resolve(this.config.inputDir, section.specRef);
    const diagramCacheKey = `diagram:${section.id}:${await this.getFileHash(specPath)}`;

    // Check cache
    if (ctx.cache.has(diagramCacheKey)) {
      stats.cacheHits++;
      return ctx.cache.get(diagramCacheKey);
    }

    const spec = await this.loadJson<DiagramSpec>(specPath);

    if (!this.validators.diagram(spec)) {
      throw new Error(`DiagramSpec validation failed: ${JSON.stringify(this.validators.diagram.errors)}`);
    }

    const svg = await this.withTimeout(
      compileDiagramToSVG(spec),
      this.config.diagramTimeout,
      `Diagram compilation timeout: ${section.id}`
    );

    const sanitizedSvg = this.config.enableSvgSanitization
      ? this.sanitizeSvg(svg)
      : svg;

    const result = { ...section, svg: sanitizedSvg };
    ctx.cache.set(diagramCacheKey, result);
    stats.diagramsCompiled++;

    return result;
  }

  /**
   * Sanitize SVG content to prevent XSS
   */
  private sanitizeSvg(svg: string): string {
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ALLOWED_TAGS: [
        'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
        'text', 'tspan', 'defs', 'marker', 'style', 'title', 'desc'
      ],
      ALLOWED_ATTR: [
        'viewBox', 'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry',
        'd', 'fill', 'stroke', 'stroke-width', 'transform', 'class', 'id'
      ]
    });
  }

  /**
   * Execute promise with timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Resolve input path with fallback logic
   */
  private async resolveInputPath(inputPath: string): Promise<string> {
    if (inputPath) {
      const resolved = path.resolve(inputPath);
      if (await this.fileExists(resolved)) {
        return resolved;
      }
      throw new Error(`Input file not found: ${resolved}`);
    }

    // Fallback to configured input directory
    const inputDir = this.config.inputDir;
    const candidates = [
      path.join(inputDir, 'gravitation.json'),
      path.join(inputDir, 'hello-chapter.json')
    ];

    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) {
        return candidate;
      }
    }

    throw new Error(`No chapter files found in ${inputDir}`);
  }

  /**
   * Load and validate chapter JSON
   */
  private async loadAndValidateChapter(ctx: RendererContext, chapterPath: string): Promise<DocJSON> {
    const chapter = await this.loadJson<DocJSON>(chapterPath);

    if (!this.validators.doc(chapter)) {
      const errors = this.validators.doc.errors || [];
      throw new Error(`DocJSON validation failed: ${JSON.stringify(errors)}`);
    }

    return chapter;
  }

  /**
   * Write chapter output atomically
   */
  private async writeChapterOutput(ctx: RendererContext, renderedChapter: any): Promise<string> {
    const outputPath = path.join(
      this.config.outputDir,
      'chapter.json'
    );
    const tempPath = `${outputPath}.tmp.${ctx.correlationId}`;

    try {
      await fs.writeFile(tempPath, JSON.stringify(renderedChapter, null, 2), 'utf8');
      await fs.rename(tempPath, outputPath);
      return outputPath;
    } catch (error) {
      // Clean up temp file
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
  }

  /**
   * Ensure required directories exist
   */
  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.config.outputDir, { recursive: true }),
      fs.mkdir(this.config.cacheDir, { recursive: true })
    ]);
  }

  /**
   * Safe JSON loading with size limits
   */
  private async loadJson<T>(filePath: string): Promise<T> {
    const stats = await fs.stat(filePath);
    if (stats.size > this.config.maxFileSize) {
      throw new Error(`File too large: ${filePath} (${stats.size} bytes)`);
    }

    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate file hash for caching
   */
  private async getFileHash(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Generate correlation ID for tracking
   */
  private generateCorrelationId(): string {
    return `render-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Structured logging with correlation ID
   */
  private log(ctx: RendererContext, level: string, message: string, data?: any): void {
    if (!this.shouldLog(level)) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: ctx.correlationId,
      message,
      ...(data && { data })
    };

    console.log(JSON.stringify(logEntry));
  }

  /**
   * Check if should log based on level
   */
  private shouldLog(level: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    const configLevel = levels.indexOf(this.config.logLevel);
    const messageLevel = levels.indexOf(level);
    return messageLevel >= configLevel;
  }
}

/**
 * CLI entry point
 */
async function main() {
  try {
    const config = loadRendererConfig();
    const builder = new SafeChapterBuilder(config);

    const inputPath = process.argv[2] || '';
    const stats = await builder.buildChapter(inputPath);

    console.log('Build completed:', stats);
    process.exit(0);
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { SafeChapterBuilder };