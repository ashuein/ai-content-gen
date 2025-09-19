import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import {
  SectionContext,
  SectionDoc,
  SectionDocPayload,
  ContentBlock,
  ProseBlock,
  EquationBlock,
  PlotBlock,
  DiagramBlock,
  ChemistryBlock,
  WidgetBlock,
  GeneratedAsset,
  ValidationReport,
  ModuleError,
  Result,
  Ok,
  Err,
  ValidationResult
} from './types.js';
import { IDGenerator } from './id-generator.js';
import { AjvValidationGate } from '../../validators/src/ajv-validator.js';
import { KatexValidationGate } from '../../validators/src/katex-validator.js';
import { MathValidationGate } from '../../validators/src/math-validator.js';
import { UnitsValidationGate } from '../../validators/src/units-validator.js';
import { PGFPlotsCompiler } from '../../compilers/pgfplots/src/tectonic-wrapper.js';
import { RDKitCompiler } from '../../compilers/rdkit/src/rdkit-wrapper.js';
import { DiagramCompiler } from '../../compilers/diagram/src/diagram-compiler.js';
import { CacheManager } from '../../cache/src/cache-manager.js';

/**
 * M3-SectionGenerator: Transforms SectionContext into detailed content
 * with comprehensive validation through gates G1-G11
 */
export class ContentGenerator {
  private ajv: Ajv;
  private schema: any;
  private idGenerator: IDGenerator;
  private validationGates: {
    ajv: AjvValidationGate;
    katex: KatexValidationGate;
    math: MathValidationGate;
    units: UnitsValidationGate;
  };
  private compilers: {
    pgfplots: PGFPlotsCompiler;
    rdkit: RDKitCompiler;
    diagram: DiagramCompiler;
  };
  private cacheManager: CacheManager;

  constructor(cacheManager?: CacheManager) {
    this.ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(this.ajv);

    // Load and compile SectionDoc schema
    const schemaPath = new URL('../schemas/sectiondoc.v1.schema.json', import.meta.url);
    this.schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    this.ajv.addSchema(this.schema);

    // Initialize cache manager
    this.cacheManager = cacheManager || new CacheManager();

    // Initialize validation gates
    this.validationGates = {
      ajv: new AjvValidationGate(),
      katex: new KatexValidationGate(),
      math: new MathValidationGate(),
      units: new UnitsValidationGate()
    };

    // Initialize compilers
    this.compilers = {
      pgfplots: new PGFPlotsCompiler(this.cacheManager),
      rdkit: new RDKitCompiler(this.cacheManager),
      diagram: new DiagramCompiler(this.cacheManager)
    };

    // Register schemas with AJV gate
    this.validationGates.ajv.registerSchema('sectiondoc.v1.schema.json', this.schema);

    this.idGenerator = new IDGenerator(''); // Will be set per section
  }

  /**
   * Main entry point: generate SectionDoc from SectionContext
   */
  async generateSection(sectionContext: SectionContext): Promise<Result<SectionDoc, ModuleError[]>> {
    const startTime = Date.now();

    try {
      const correlationId = sectionContext.envelope.correlationId;

      // Step 1: Validate input SectionContext compatibility
      const compatibilityResult = this.validateInputCompatibility(sectionContext);
      if (!compatibilityResult.valid) {
        return Err([{
          code: 'E-M3-INPUT-INCOMPATIBLE',
          module: 'M3',
          data: compatibilityResult.errors,
          correlationId
        }]);
      }

      // Step 2: Initialize ID generator with chapter
      this.idGenerator = new IDGenerator(sectionContext.payload.context.chapterId);

      // Step 3: Generate content blocks from context
      const contentResult = await this.generateContentBlocks(sectionContext);
      if (!contentResult.valid) {
        return Err(contentResult.errors || []);
      }

      // Step 4: Generate and validate assets
      const assetsResult = await this.generateAssets(contentResult.data.content, correlationId);
      if (!assetsResult.valid) {
        return Err(assetsResult.errors || []);
      }

      // Step 5: Run comprehensive validation pipeline
      const validationResult = await this.runValidationPipeline(
        contentResult.data.content,
        assetsResult.data.assets,
        correlationId
      );

      // Step 6: Update running state
      const updatedState = this.updateRunningState(
        sectionContext.payload.runningState,
        contentResult.data.content,
        assetsResult.data.assets
      );

      // Step 7: Assemble final payload
      const payload: SectionDocPayload = {
        sectionMeta: {
          sectionId: sectionContext.payload.context.sectionId,
          title: sectionContext.payload.context.sectionTitle,
          chapterId: sectionContext.payload.context.chapterId,
          difficulty: sectionContext.payload.context.difficulty,
          subject: sectionContext.payload.context.subject,
          estimatedReadTime: this.estimateReadTime(contentResult.data.content)
        },
        content: contentResult.data.content,
        generatedAssets: assetsResult.data.assets,
        validationReport: {
          ...validationResult,
          processingTime: Date.now() - startTime
        },
        updatedRunningState: updatedState
      };

      // Step 8: Create versioned envelope
      const envelope = this.createEnvelope(payload, correlationId);

      // Step 9: Final schema validation (G1)
      const sectionDoc: SectionDoc = { envelope, payload };
      const schemaValidation = await this.validationGates.ajv.validate({
        data: sectionDoc,
        schemaId: 'sectiondoc.v1.schema.json'
      });

      if (!schemaValidation.valid) {
        return Err([{
          code: 'E-M3-SCHEMA-SECTIONDOC',
          module: 'M3',
          data: schemaValidation.errors,
          correlationId
        }]);
      }

      return Ok(sectionDoc);

    } catch (error) {
      return Err([{
        code: 'E-M3-GENERATION-FAILED',
        module: 'M3',
        data: { error: error instanceof Error ? error.message : String(error) },
        correlationId: sectionContext.envelope.correlationId
      }]);
    }
  }

  /**
   * Validate input SectionContext version compatibility
   */
  private validateInputCompatibility(sectionContext: SectionContext): ValidationResult {
    const producerVersion = sectionContext.envelope.version;
    const supportedVersions = ['1.0.0', '1.1.0']; // M3 can handle these versions

    if (!supportedVersions.some(v => this.isVersionCompatible(producerVersion, v))) {
      return {
        valid: false,
        errors: [`Unsupported SectionContext version: ${producerVersion}. Supported: ${supportedVersions.join(', ')}`]
      };
    }

    return { valid: true };
  }

  /**
   * Simple semantic version compatibility check
   */
  private isVersionCompatible(provided: string, supported: string): boolean {
    const [pMajor, pMinor] = provided.split('.').map(Number);
    const [sMajor, sMinor] = supported.split('.').map(Number);

    return pMajor === sMajor && pMinor <= sMinor;
  }

  /**
   * Generate content blocks from section context
   */
  private async generateContentBlocks(sectionContext: SectionContext): Promise<Result<{ content: ContentBlock[] }, ModuleError[]>> {
    const context = sectionContext.payload.context;
    const correlationId = sectionContext.envelope.correlationId;
    const content: ContentBlock[] = [];

    try {
      // Start with introduction prose
      content.push(this.generateIntroductionProse(context));

      // Process asset markers and interleave with prose
      for (let i = 0; i < context.assetMarkers.length; i++) {
        const marker = context.assetMarkers[i];

        // Add explanatory prose before asset
        if (i < context.conceptSequence.length) {
          content.push(this.generateConceptProse(context.conceptSequence[i], context));
        }

        // Generate asset block from marker
        const assetBlock = await this.generateAssetBlock(marker, context);
        if (assetBlock) {
          content.push(assetBlock);
        }

        // Add follow-up prose after asset
        content.push(this.generateFollowUpProse(marker, context));
      }

      // Add conclusion prose
      content.push(this.generateConclusionProse(context));

      return Ok({ content });

    } catch (error) {
      return Err([{
        code: 'E-M3-CONTENT-GENERATION',
        module: 'M3',
        data: { error: error instanceof Error ? error.message : String(error) },
        correlationId
      }]);
    }
  }

  /**
   * Generate introduction prose block
   */
  private generateIntroductionProse(context: any): ProseBlock {
    const id = this.idGenerator.generateProseID(context.sectionId);

    // Generate introduction based on transitions and concepts
    let markdown = `## ${context.sectionTitle}\n\n`;
    markdown += `${context.transitions.in}\n\n`;

    // Add overview of concepts
    if (context.conceptSequence.length > 0) {
      markdown += `In this section, we will explore ${context.conceptSequence.join(', ')}, `;
      markdown += `building a comprehensive understanding of these interconnected ideas.\n\n`;
    }

    return {
      type: 'prose',
      id,
      markdown,
      wordCount: this.countWords(markdown)
    };
  }

  /**
   * Generate concept explanation prose
   */
  private generateConceptProse(concept: string, context: any): ProseBlock {
    const id = this.idGenerator.generateProseID(context.sectionId);

    const conceptTitle = concept.charAt(0).toUpperCase() + concept.slice(1);
    let markdown = `### ${conceptTitle}\n\n`;

    // Generate contextual explanation based on difficulty
    switch (context.difficulty) {
      case 'comfort':
        markdown += `Let's begin with ${concept}. This fundamental concept helps us understand `;
        markdown += `the basic principles at work in ${context.subject.toLowerCase()}. `;
        break;
      case 'hustle':
        markdown += `Now we delve into ${concept}, a key concept that bridges our previous understanding `;
        markdown += `with more sophisticated applications in ${context.subject.toLowerCase()}. `;
        break;
      case 'advanced':
        markdown += `We now examine ${concept} in detail, considering its theoretical foundations `;
        markdown += `and advanced implications in ${context.subject.toLowerCase()}. `;
        break;
    }

    markdown += `This concept is essential for mastering the material that follows.\n\n`;

    return {
      type: 'prose',
      id,
      markdown,
      wordCount: this.countWords(markdown)
    };
  }

  /**
   * Generate asset block from marker
   */
  private async generateAssetBlock(marker: string, context: any): Promise<ContentBlock | null> {
    // Parse marker format: {{type:name}}
    const match = marker.match(/^\{\{([^:]+):([^}]+)\}\}$/);
    if (!match) return null;

    const [, type, name] = match;

    switch (type) {
      case 'eq':
        return this.generateEquationBlock(name, context);
      case 'plot':
        return this.generatePlotBlock(name, context);
      case 'diagram':
        return this.generateDiagramBlock(name, context);
      case 'widget':
        return this.generateWidgetBlock(name, context);
      case 'chem':
        return this.generateChemistryBlock(name, context);
      default:
        return null;
    }
  }

  /**
   * Generate equation block with validation
   */
  private generateEquationBlock(name: string, context: any): EquationBlock {
    const id = this.idGenerator.generateID('eq');

    // Generate sample equation based on subject and name
    const { tex, check } = this.generateEquationContent(name, context.subject);

    return {
      type: 'equation',
      id,
      tex,
      check,
      caption: `${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`
    };
  }

  /**
   * Generate equation content based on subject and name
   */
  private generateEquationContent(name: string, subject: string): { tex: string; check: any } {
    // This would typically call an LLM - using templates for now
    const equations: Record<string, any> = {
      'Physics': {
        'force-equation': {
          tex: 'F = ma',
          check: {
            vars: { m: 2.0, a: 9.8 },
            expr: 'm * a',
            expect: 19.6,
            tol: 1e-10
          }
        },
        'kinetic-energy': {
          tex: 'KE = \\frac{1}{2}mv^2',
          check: {
            vars: { m: 2.0, v: 10.0 },
            expr: '0.5 * m * v^2',
            expect: 100.0,
            tol: 1e-10
          }
        }
      },
      'Chemistry': {
        'ideal-gas': {
          tex: 'PV = nRT',
          check: {
            vars: { P: 1.0, V: 22.4, n: 1.0, R: 0.0821 },
            expr: 'P * V / (n * R)',
            expect: 273.0,
            tol: 1e-1
          }
        }
      },
      'Mathematics': {
        'quadratic-formula': {
          tex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
          check: {
            vars: { a: 1.0, b: -5.0, c: 6.0 },
            expr: '(-b + sqrt(b^2 - 4*a*c)) / (2*a)',
            expect: 3.0,
            tol: 1e-10
          }
        }
      }
    };

    const subjectEquations = equations[subject] || {};
    const equation = subjectEquations[name] || {
      tex: 'y = f(x)',
      check: {
        vars: { x: 1.0 },
        expr: 'x',
        expect: 1.0,
        tol: 1e-10
      }
    };

    return equation;
  }

  /**
   * Generate plot block
   */
  private generatePlotBlock(name: string, context: any): PlotBlock {
    const id = this.idGenerator.generateID('plot');
    const specRef = this.idGenerator.generateSpecRef('plot', id);

    return {
      type: 'plot',
      id,
      specRef,
      caption: `${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} Plot`
    };
  }

  /**
   * Generate diagram block
   */
  private generateDiagramBlock(name: string, context: any): DiagramBlock {
    const id = this.idGenerator.generateID('fig');
    const specRef = this.idGenerator.generateSpecRef('diagram', id);

    return {
      type: 'diagram',
      id,
      specRef,
      caption: `${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} Diagram`
    };
  }

  /**
   * Generate widget block
   */
  private generateWidgetBlock(name: string, context: any): WidgetBlock {
    const id = this.idGenerator.generateID('wid');
    const specRef = this.idGenerator.generateSpecRef('widget', id);

    return {
      type: 'widget',
      id,
      specRef,
      caption: `Interactive ${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`
    };
  }

  /**
   * Generate chemistry block
   */
  private generateChemistryBlock(name: string, context: any): ChemistryBlock {
    const id = this.idGenerator.generateID('chem');

    // Sample SMILES strings for common molecules
    const molecules: Record<string, string> = {
      'water': 'O',
      'methane': 'C',
      'ethanol': 'CCO',
      'benzene': 'c1ccccc1',
      'glucose': 'C([C@@H]1[C@H]([C@@H]([C@H]([C@H](O1)O)O)O)O)O'
    };

    const smiles = molecules[name] || 'C'; // Default to methane

    return {
      type: 'chemistry',
      id,
      smiles,
      caption: `${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} Structure`
    };
  }

  /**
   * Generate follow-up prose after asset
   */
  private generateFollowUpProse(marker: string, context: any): ProseBlock {
    const id = this.idGenerator.generateProseID(context.sectionId);

    let markdown = `This representation helps illustrate the key relationships and provides `;
    markdown += `a visual foundation for understanding the concepts we've discussed. `;
    markdown += `Notice how the theoretical framework translates into practical applications.\n\n`;

    return {
      type: 'prose',
      id,
      markdown,
      wordCount: this.countWords(markdown)
    };
  }

  /**
   * Generate conclusion prose
   */
  private generateConclusionProse(context: any): ProseBlock {
    const id = this.idGenerator.generateProseID(context.sectionId);

    let markdown = `### Summary\n\n`;
    markdown += `${context.transitions.out}\n\n`;
    markdown += `The concepts covered in this section form a crucial foundation for the material ahead. `;
    markdown += `Take time to review and ensure you understand each component before proceeding.\n\n`;

    return {
      type: 'prose',
      id,
      markdown,
      wordCount: this.countWords(markdown)
    };
  }

  /**
   * Generate asset specifications and compile them using real compilers
   */
  private async generateAssets(
    content: ContentBlock[],
    correlationId: string
  ): Promise<Result<{ assets: GeneratedAsset[] }, ModuleError[]>> {
    const assets: GeneratedAsset[] = [];
    const errors: ModuleError[] = [];

    for (const block of content) {
      if (['plot', 'diagram', 'chemistry'].includes(block.type)) {
        try {
          const asset = await this.generateAndCompileAsset(block, correlationId);
          assets.push(asset);
        } catch (error) {
          errors.push({
            code: 'E-M3-ASSET-GENERATION',
            module: 'M3',
            data: {
              blockId: block.id,
              blockType: block.type,
              error: error instanceof Error ? error.message : String(error)
            },
            correlationId
          });
        }
      } else if (block.type === 'widget') {
        // Widgets are spec-only, no compilation needed
        try {
          const asset = await this.generateAssetSpec(block);
          assets.push(asset);
        } catch (error) {
          errors.push({
            code: 'E-M3-WIDGET-GENERATION',
            module: 'M3',
            data: {
              blockId: block.id,
              error: error instanceof Error ? error.message : String(error)
            },
            correlationId
          });
        }
      }
    }

    if (errors.length > 0) {
      return Err(errors);
    }

    return Ok({ assets });
  }

  /**
   * Generate and compile asset using appropriate compiler
   */
  private async generateAndCompileAsset(block: ContentBlock, correlationId: string): Promise<GeneratedAsset> {
    const spec = this.createAssetSpec(block);
    let compiledSvg: string | undefined;

    // Compile asset using appropriate compiler
    switch (block.type) {
      case 'plot':
        const plotResult = await this.compilers.pgfplots.compile(spec, correlationId);
        if (!plotResult.success) {
          throw new Error(`Plot compilation failed: ${plotResult.error?.message}`);
        }
        compiledSvg = plotResult.svg;
        break;

      case 'chemistry':
        const chemBlock = block as ChemistryBlock;
        const chemResult = await this.compilers.rdkit.compile({
          smiles: chemBlock.smiles,
          label: chemBlock.caption
        }, correlationId);
        if (!chemResult.success) {
          throw new Error(`Chemistry compilation failed: ${chemResult.error?.message}`);
        }
        compiledSvg = chemResult.svg;
        break;

      case 'diagram':
        const diagramResult = await this.compilers.diagram.compile({
          type: 'mermaid',
          source: this.generateMermaidSource(spec),
          title: block.caption
        }, correlationId);
        if (!diagramResult.success) {
          throw new Error(`Diagram compilation failed: ${diagramResult.error?.message}`);
        }
        compiledSvg = diagramResult.svg;
        break;
    }

    const contentHash = this.generateContentHash({ spec, compiledSvg });

    return {
      id: block.id,
      type: block.type as "plot" | "diagram" | "widget" | "chemistry",
      specPath: block.type === 'chemistry' ? `chemistry/${block.id}.json` : (block as any).specRef,
      contentHash,
      spec,
      compiledSvg
    };
  }

  /**
   * Generate asset specification (for widgets and as base for compilable assets)
   */
  private async generateAssetSpec(block: ContentBlock): Promise<GeneratedAsset> {
    const spec = this.createAssetSpec(block);
    const contentHash = this.generateContentHash(spec);

    return {
      id: block.id,
      type: block.type as "plot" | "diagram" | "widget" | "chemistry",
      specPath: block.type === 'chemistry' ? `chemistry/${block.id}.json` : (block as any).specRef,
      contentHash,
      spec
    };
  }


  /**
   * Create asset specification based on type
   */
  private createAssetSpec(block: ContentBlock): any {
    switch (block.type) {
      case 'plot':
        return {
          kind: 'pgfplot',
          contentHash: 'placeholder',
          title: block.caption || 'Sample Plot',
          x: { min: -10, max: 10, label: 'x' },
          y: { min: -10, max: 10, label: 'y' },
          expr: 'sin(x)',
          style: { grid: true, samples: 100 }
        };

      case 'diagram':
        return {
          contentHash: 'placeholder',
          canvas: { width: 400, height: 300, grid: 10, snap: true },
          nodes: [
            { id: 'point1', kind: 'point', x: 100, y: 100, label: 'A' },
            { id: 'point2', kind: 'point', x: 300, y: 200, label: 'B' },
            { id: 'arrow1', kind: 'arrow', from: [100, 100], to: [300, 200] }
          ]
        };

      case 'widget':
        return {
          contentHash: 'placeholder',
          kind: 'formula-playground',
          expr: 'a * x + b',
          params: [
            { name: 'a', min: -5, max: 5, step: 0.1, default: 1 },
            { name: 'b', min: -10, max: 10, step: 0.5, default: 0 }
          ]
        };

      default:
        return {};
    }
  }

  /**
   * Generate Mermaid source from diagram spec
   */
  private generateMermaidSource(spec: any): string {
    // Convert internal diagram spec to Mermaid syntax
    if (spec.nodes) {
      let mermaid = 'graph TD\n';

      // Add nodes
      const points = spec.nodes.filter((n: any) => n.kind === 'point');
      const arrows = spec.nodes.filter((n: any) => n.kind === 'arrow');

      // Simple node connections
      for (const arrow of arrows) {
        const fromPoint = points.find((p: any) => p.x === arrow.from[0] && p.y === arrow.from[1]);
        const toPoint = points.find((p: any) => p.x === arrow.to[0] && p.y === arrow.to[1]);

        if (fromPoint && toPoint) {
          mermaid += `    ${fromPoint.label}[${fromPoint.label}] --> ${toPoint.label}[${toPoint.label}]\n`;
        }
      }

      return mermaid;
    }

    // Default simple diagram
    return 'graph TD\n    A[Start] --> B[End]';
  }

  /**
   * Run comprehensive validation pipeline (G1-G11)
   */
  private async runValidationPipeline(
    content: ContentBlock[],
    assets: GeneratedAsset[],
    correlationId: string
  ): Promise<ValidationReport> {
    const gatesPassed: string[] = [];
    const gatesFailed: string[] = [];
    const warnings: string[] = [];
    const repairActions: string[] = [];

    // G3: KaTeX validation for equations
    for (const block of content.filter(b => b.type === 'equation')) {
      const eqBlock = block as EquationBlock;
      const katexResult = await this.validationGates.katex.validate({ tex: eqBlock.tex });

      if (katexResult.valid) {
        gatesPassed.push('G3-KaTeX');
      } else {
        gatesFailed.push('G3-KaTeX');
        warnings.push(`Equation ${eqBlock.id}: ${katexResult.errors?.[0]?.message || 'KaTeX validation failed'}`);
      }
    }

    // G4: Mathematical expression validation with seeded trials
    for (const block of content.filter(b => b.type === 'equation')) {
      const eqBlock = block as EquationBlock;
      const mathResult = await this.validationGates.math.validate({
        equation: {
          tex: eqBlock.tex,
          check: eqBlock.check
        }
      });

      if (mathResult.valid) {
        gatesPassed.push('G4-Math');
      } else {
        gatesFailed.push('G4-Math');
        warnings.push(`Equation ${eqBlock.id}: Mathematical validation failed`);
      }
    }

    // G8: ID collision check
    const allIds = content.map(c => c.id);
    const collisionResult = this.idGenerator.checkCollisions(allIds);

    if (collisionResult.valid) {
      gatesPassed.push('G8-IDCollision');
    } else {
      gatesFailed.push('G8-IDCollision');
      warnings.push('ID collisions detected');
    }

    return {
      gatesPassed,
      gatesFailed,
      warnings,
      repairActions
    };
  }

  /**
   * Update running state with new section content
   */
  private updateRunningState(previousState: any, content: ContentBlock[], assets: GeneratedAsset[]): any {
    // Extract new terms from content
    const newTerms: string[] = [];
    for (const block of content) {
      if (block.type === 'prose') {
        const prose = block as ProseBlock;
        const words = prose.markdown.match(/\b[A-Z][a-z]+\b/g) || [];
        newTerms.push(...words.filter(w => w.length > 3));
      }
    }

    // Extract used assets
    const usedAssets = assets.map(asset => ({
      id: asset.id,
      type: asset.type === "chemistry" ? "chem" as const : asset.type as "eq" | "plot" | "diagram" | "widget",
      contentHash: asset.contentHash
    }));

    return {
      ...previousState,
      introduced_terms: [
        ...(previousState.introduced_terms || []),
        ...newTerms
      ].slice(0, 50),
      used_assets: [
        ...(previousState.used_assets || []),
        ...usedAssets
      ].slice(0, 20)
    };
  }

  /**
   * Estimate reading time based on content
   */
  private estimateReadTime(content: ContentBlock[]): number {
    const wordsPerMinute = 200;
    let totalWords = 0;

    for (const block of content) {
      if (block.type === 'prose') {
        totalWords += (block as ProseBlock).wordCount || 0;
      } else {
        totalWords += 50; // Estimated time for processing visual content
      }
    }

    return Math.max(1, Math.ceil(totalWords / wordsPerMinute));
  }

  /**
   * Count words in text
   */
  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  /**
   * Create versioned envelope with content hash
   */
  private createEnvelope(payload: SectionDocPayload, correlationId: string) {
    const contentHash = this.generateContentHash(payload);

    return {
      version: "1.0.0",
      producer: "M3-SectionGenerator",
      timestamp: new Date().toISOString(),
      correlationId,
      contentHash,
      compatible: ["1.0.0"]
    };
  }

  /**
   * Generate SHA256 content hash for deterministic caching
   */
  private generateContentHash(payload: any): string {
    const normalized = this.normalizeObject(payload);
    const content = JSON.stringify(normalized);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Normalize object for consistent hashing
   */
  private normalizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return obj.normalize('NFC').replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.normalizeObject(item));
    }
    if (obj && typeof obj === 'object') {
      const sorted: Record<string, any> = {};
      Object.keys(obj).sort().forEach(key => {
        sorted[key] = this.normalizeObject(obj[key]);
      });
      return sorted;
    }
    return obj;
  }
}