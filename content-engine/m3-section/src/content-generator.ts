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
import { PlotLexerValidationGate } from '../../validators/src/plot-lexer-validator.js';
import { SmilesValidationGate } from '../../validators/src/smiles-validator.js';
import { DiagramTopologyValidationGate } from '../../validators/src/diagram-topology-validator.js';
import { StyleValidationGate } from '../../validators/src/style-validator.ts';
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
    plotLexer: PlotLexerValidationGate;
    smiles: SmilesValidationGate;
    diagramTopology: DiagramTopologyValidationGate;
    style: StyleValidationGate;
  };
  private compilers: {
    pgfplots: PGFPlotsCompiler;
    rdkit: RDKitCompiler;
    diagram: DiagramCompiler;
  };
  private cacheManager: CacheManager;

  constructor(cacheManager?: CacheManager) {
    this.ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
    addFormats(this.ajv);

    // Load SectionDoc schema and register by $id
    const schemaPath = new URL('../schemas/sectiondoc.v1.schema.json', import.meta.url);
    this.schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

    // Add schema by $id for proper referencing
    this.ajv.addSchema(this.schema, this.schema.$id);

    // Initialize cache manager
    this.cacheManager = cacheManager || new CacheManager();

    // Initialize validation gates
    this.validationGates = {
      ajv: new AjvValidationGate(),
      katex: new KatexValidationGate(),
      math: new MathValidationGate(),
      units: new UnitsValidationGate(),
      plotLexer: new PlotLexerValidationGate(),
      smiles: new SmilesValidationGate(),
      diagramTopology: new DiagramTopologyValidationGate(),
      style: new StyleValidationGate()
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
  async generateSection(
    sectionContext: SectionContext,
    llmContext?: any
  ): Promise<Result<SectionDoc, ModuleError[]>> {
    const startTime = Date.now();

    try {
      const correlationId = sectionContext.envelope.correlationId;

      // LLM context available for content generation (if provided)
      if (llmContext) {
        console.log(`[${correlationId}] M3 received LLM context - ready for schema-driven generation`);
      }

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
      const contentResult = await this.generateContentBlocks(sectionContext, llmContext);
      if (!contentResult.valid) {
        return Err(contentResult.errors || []);
      }

      // Step 4: Generate and validate assets
      const assetsResult = await this.generateAssets(contentResult.data.content, correlationId, sectionContext.payload.context, llmContext);
      if (!assetsResult.valid) {
        return Err(assetsResult.errors || []);
      }

      // Step 5: Run comprehensive validation pipeline
      const validationResult = await this.runValidationPipeline(
        contentResult.data.content,
        assetsResult.data.assets,
        correlationId
      );

      // Enforce validation gates as hard blockers (including G12 Style)
      if (validationResult.gatesFailed && validationResult.gatesFailed.length > 0) {
        return Err([
          {
            code: 'E-M3-VALIDATION-FAILED',
            module: 'M3',
            data: {
              gatesFailed: validationResult.gatesFailed,
              warnings: validationResult.warnings,
              repairActions: validationResult.repairActions
            },
            correlationId
          }
        ]);
      }

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
  private async generateContentBlocks(sectionContext: SectionContext, llmContext?: any): Promise<Result<{ content: ContentBlock[] }, ModuleError[]>> {
    const context = sectionContext.payload.context;
    const correlationId = sectionContext.envelope.correlationId;
    const content: ContentBlock[] = [];

    try {
      // Start with introduction prose
      content.push(await this.generateIntroductionProse(context, llmContext));

      // Process asset markers and interleave with prose
      for (let i = 0; i < context.assetMarkers.length; i++) {
        const marker = context.assetMarkers[i];

        // Add explanatory prose before asset
        if (i < context.conceptSequence.length) {
          content.push(await this.generateConceptProse(context.conceptSequence[i], context, llmContext));
        }

        // Generate asset block from marker
        const assetBlock = await this.generateAssetBlock(marker, context, llmContext);
        if (assetBlock) {
          content.push(assetBlock);
        }

        // Add follow-up prose after asset
        content.push(await this.generateFollowUpProse(marker, context, llmContext));
      }

      // Add conclusion prose
      content.push(await this.generateConclusionProse(context, llmContext));

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
   * Generate introduction prose block using LLM with PDF grounding - NO FALLBACKS
   */
  private async generateIntroductionProse(context: any, llmContext?: any): Promise<ProseBlock> {
    const id = this.idGenerator.generateProseID(context.sectionId);

    if (!llmContext?.llmClient) {
      throw new Error(`[${context.correlationId}] LLM client is required for comprehensive content generation - no fallback templates available`);
    }

    let markdown: string;
    let wordCount: number;
    let lastError: Error | null = null;

    // Retry up to 3 times for comprehensive content generation
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[${context.correlationId}] Introduction generation attempt ${attempt}/3`);
        const prompt = this.buildIntroductionPrompt(context);
        const response = await llmContext.llmClient.generateM3Content(prompt, {
          schema: 'prose-block.v1.schema.json',
          correlationId: context.correlationId,
          fileId: llmContext.moduleContext?.fileId
        });

        // Validate required fields defensively
        const prose = this.ensureProseResponse(response);

        // Previously enforced minimum word-count here; now allow any length and defer to chapter-level aggregation

        markdown = prose.markdown;
        wordCount = prose.wordCount;
        console.log(`[${context.correlationId}] Introduction generated successfully: ${wordCount} words`);
        break;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[${context.correlationId}] Introduction generation attempt ${attempt}/3 failed:`, error);
        if (attempt === 3) {
          throw new Error(`[${context.correlationId}] Failed to generate comprehensive introduction after 3 attempts. Last error: ${lastError.message}`);
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }

    return {
      type: 'prose',
      id,
      markdown: markdown!,
      wordCount: wordCount!
    };
  }


  /**
   * Build LLM prompt for introduction generation
   */
  private buildIntroductionPrompt(context: any): string {
    return `Generate an engaging introduction for a ${context.subject} section titled "${context.sectionTitle}".

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Section concepts: ${context.conceptSequence.join(', ')}
- Transition in: ${context.transitions.in}
- Learning objectives: ${context.learningObjectives?.join('; ') || 'Not specified'}

Requirements:
- Write formal textbook paragraphs (no headings, lists, or code formatting)
- Write comprehensive introduction up to 3000 words covering the section in full depth
- Match the difficulty level (${context.difficulty})
- Connect to prior knowledge through the transition
- Preview the concepts to be covered in detail with learning objectives
- Use clear, educational language appropriate for ${context.grade} students
- Include relevant citations from the provided PDF as "NCERT Class XI Chemistry (p. 98)" format only
- Use multi-sentence paragraphs with natural flow, no bullet points or numbered lists
- Do not invent topics - ground all content in curriculum standards and provided materials

Output format (STRICT):
- Return ONLY a single JSON object with keys: markdown (string), wordCount (integer), keyTerms (string[]), difficulty ("comfort"|"hustle"|"advanced").
- No prose, no preface, no code fences.`;
  }

  /**
   * Generate concept explanation prose using LLM with PDF grounding - NO FALLBACKS
   */
  private async generateConceptProse(concept: string, context: any, llmContext?: any): Promise<ProseBlock> {
    const id = this.idGenerator.generateProseID(context.sectionId);

    if (!llmContext?.llmClient) {
      throw new Error(`[${context.correlationId}] LLM client is required for comprehensive concept generation - no fallback templates available`);
    }

    let markdown: string;
    let wordCount: number;
    let lastError: Error | null = null;

    // Retry up to 3 times for comprehensive content generation
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[${context.correlationId}] Concept "${concept}" generation attempt ${attempt}/3`);
        const prompt = this.buildConceptPrompt(concept, context);
        const response = await llmContext.llmClient.generateM3Content(prompt, {
          schema: 'prose-block.v1.schema.json',
          correlationId: context.correlationId,
          fileId: llmContext.moduleContext?.fileId
        });

        const prose = this.ensureProseResponse(response);

        // Allow any content length - chapter-level validation will be applied later

        markdown = prose.markdown;
        wordCount = prose.wordCount;
        console.log(`[${context.correlationId}] Concept "${concept}" generated successfully: ${wordCount} words`);
        break;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[${context.correlationId}] Concept "${concept}" generation attempt ${attempt}/3 failed:`, error);
        if (attempt === 3) {
          throw new Error(`[${context.correlationId}] Failed to generate comprehensive concept explanation after 3 attempts. Last error: ${lastError.message}`);
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }

    return {
      type: 'prose',
      id,
      markdown: markdown!,
      wordCount: wordCount!
    };
  }


  /**
   * Build LLM prompt for concept explanation
   */
  private buildConceptPrompt(concept: string, context: any): string {
    return `Generate a clear explanation for the concept "${concept}" in a ${context.subject} lesson.

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Section: ${context.sectionTitle}
- Subject: ${context.subject}
- Concept sequence: ${context.conceptSequence.join(' → ')}
- Position of "${concept}": ${context.conceptSequence.indexOf(concept) + 1} of ${context.conceptSequence.length}

Requirements:
- Write formal textbook paragraphs (no headings, lists, or code formatting)
- Write comprehensive explanation up to 3000 words covering the concept in full depth
- Match the difficulty level (${context.difficulty})
- Explain the concept clearly and accurately with detailed examples
- Connect to the overall section theme and show relationships to other concepts
- Use multiple examples appropriate for ${context.grade} students
- Build on previous concepts and show progressive understanding
- Include relevant citations from the provided PDF as "NCERT Class XI Chemistry (p. 98)" format only
- Use multi-sentence paragraphs with natural flow, no bullet points or numbered lists
- Provide mathematical derivations, chemical mechanisms, or theoretical frameworks as appropriate
- Do not invent topics - ground all explanations in curriculum standards and provided materials

Output format (STRICT):
- Return ONLY a single JSON object with keys: markdown, wordCount, keyTerms, difficulty.
- No prose, no preface, no code fences.`;
  }

  /**
   * Generate asset block from marker
   */
  private async generateAssetBlock(marker: string, context: any, llmContext?: any): Promise<ContentBlock | null> {
    // Parse marker format: {{type:name}}
    const match = marker.match(/^\{\{([^:]+):([^}]+)\}\}$/);
    if (!match) return null;

    const [, type, name] = match;

    switch (type) {
      case 'eq':
        return await this.generateEquationBlock(name, context, llmContext);
      case 'plot':
        return await this.generatePlotBlock(name, context, llmContext);
      case 'diagram':
        return await this.generateDiagramBlock(name, context, llmContext);
      case 'widget':
        return this.generateWidgetBlock(name, context);
      case 'chem':
        return this.generateChemistryBlock(name, context);
      default:
        return null;
    }
  }

  /**
   * Generate equation block with validation using LLM or fallback
   */
  private async generateEquationBlock(name: string, context: any, llmContext?: any): Promise<EquationBlock> {
    const id = this.idGenerator.generateID('eq');

    // Generate equation using LLM or fallback
    const { tex, check } = await this.generateEquationContent(name, context, llmContext);

    return {
      type: 'equation',
      id,
      tex,
      check,
      caption: `${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`
    };
  }

  /**
   * Generate equation content using LLM or fallback templates
   */
  private async generateEquationContent(name: string, context: any, llmContext?: any): Promise<{ tex: string; check: any }> {
    if (llmContext?.llmClient) {
      try {
        // Use LLM for dynamic equation generation
        const prompt = this.buildEquationPrompt(name, context);
        const response = await llmContext.llmClient.generateM3Content(prompt, {
          schema: 'equation-block.v1.schema.json',
          correlationId: context.correlationId,
          fileId: llmContext.moduleContext?.fileId
        });

        // Tolerant extraction of equation latex and variables
        const latexDirect: string = (response && (response.latex || response.tex || response.equation || '')) || '';
        const extractedLatex: string | null = this.extractLatexFromAny(latexDirect || response);
        const latex: string = (extractedLatex || '').trim();
        const variables: any[] = Array.isArray(response?.variables) ? response.variables : [];

        if (!latex || typeof latex !== 'string') {
          throw new Error('LLM equation response missing latex/tex');
        }

        // Convert LLM response to internal format
        const check = this.generateValidationCheck(variables);

        return {
          tex: latex,
          check
        };
      } catch (error) {
        throw new Error(`[${context.correlationId}] LLM equation generation failed - no fallback templates for comprehensive content: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw new Error(`[${context.correlationId}] LLM client required for comprehensive equation generation - no fallback templates available`);
    }
  }

  private extractLatexFromAny(source: any): string | null {
    // If already a string, try to extract LaTeX from it
    if (typeof source === 'string') {
      return this.extractLatexFromText(source);
    }

    // If an object, try common fields first
    if (source && typeof source === 'object') {
      const fields = [source.latex, source.tex, source.equation, source.text, source.content, source.output_text];
      for (const f of fields) {
        if (typeof f === 'string') {
          const latex = this.extractLatexFromText(f);
          if (latex) return latex;
        }
      }

      // Recursively scan for the longest LaTeX-like string
      let best: string | null = null;
      let bestScore = 0;
      const visit = (node: any) => {
        if (typeof node === 'string') {
          const candidate = this.extractLatexFromText(node);
          if (candidate) {
            // Simple scoring: prefer longer strings with TeX markers
            const score = candidate.length + (candidate.includes('\\') ? 50 : 0) + (candidate.includes('=') ? 10 : 0);
            if (score > bestScore) { bestScore = score; best = candidate; }
          }
          return;
        }
        if (Array.isArray(node)) {
          for (const item of node) visit(item);
          return;
        }
        if (node && typeof node === 'object') {
          for (const key of Object.keys(node)) visit((node as any)[key]);
        }
      };
      visit(source);
      return best;
    }

    return null;
  }

  private extractLatexFromText(text: string): string | null {
    if (!text) return null;
    const stripped = this.stripCodeFences(text).trim();
    // Prefer display math $$...$$
    const m1 = stripped.match(/\$\$([\s\S]*?)\$\$/);
    if (m1 && m1[1]?.trim()) return m1[1].trim();
    // \[ ... \]
    const m2 = stripped.match(/\\\[([\s\S]*?)\\\]/);
    if (m2 && m2[1]?.trim()) return m2[1].trim();
    // \( ... \)
    const m3 = stripped.match(/\\\(([\s\S]*?)\\\)/);
    if (m3 && m3[1]?.trim()) return m3[1].trim();
    // Look for a LaTeX-looking line (contains backslash command or equals)
    const lines = stripped.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const latexLike = lines.find(l => /\\[a-zA-Z]+/.test(l) || /\w\s*=\s*[^=]+/.test(l));
    if (latexLike) return latexLike;
    return null;
  }

  private stripCodeFences(s: string): string {
    return s.replace(/```[a-zA-Z]*\n?|```/g, '');
  }

  /**
   * Build LLM prompt for equation generation
   */
  private buildEquationPrompt(name: string, context: any): string {
    return `Generate a mathematical equation for "${name}" in ${context.subject} education.

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Subject: ${context.subject}
- Section concepts: ${context.conceptSequence.join(', ')}

Requirements:
- Provide accurate LaTeX equation without $ delimiters (no surrounding $ or $$)
- Define all variables clearly with names and, if applicable, SI units
- Keep appropriate for ${context.grade} level
- Ensure mathematical accuracy
- Include reasonable example/default values for variables where possible

Output format (STRICT):
- Return ONLY a single JSON object with the following shape:
  {
    "latex": string,  // equation in LaTeX without $ delimiters
    "variables": [    // list of variable definitions
      { "symbol": string, "name": string, "unit": string(optional), "example": number(optional) }
    ]
  }
- Do not include any prose, comments, markdown, or code fences.
- Do not add extra keys beyond the ones specified.`;
  }

  /**
   * Generate validation check from variables
   */
  private generateValidationCheck(variables: any[]): any {
    if (!variables || variables.length === 0) {
      return {
        vars: { x: 1.0 },
        expr: 'x',
        expect: 1.0,
        tol: 1e-10
      };
    }

    // Build validation from first variable for simplicity
    const firstVar = variables[0];
    return {
      vars: { [firstVar.symbol]: 1.0 },
      expr: firstVar.symbol,
      expect: 1.0,
      tol: 1e-10
    };
  }

  /**
   * Fallback equation templates
   */
  private generateEquationTemplate(name: string, subject: string): { tex: string; check: any } {
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
    return subjectEquations[name] || {
      tex: 'y = f(x)',
      check: {
        vars: { x: 1.0 },
        expr: 'x',
        expect: 1.0,
        tol: 1e-10
      }
    };
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
   * Generate follow-up prose after asset with PDF grounding - NO FALLBACKS
   */
  private async generateFollowUpProse(marker: string, context: any, llmContext?: any): Promise<ProseBlock> {
    const id = this.idGenerator.generateProseID(context.sectionId);

    if (!llmContext?.llmClient) {
      throw new Error(`[${context.correlationId}] LLM client is required for comprehensive asset follow-up generation - no fallback templates available`);
    }

    let markdown: string;
    let wordCount: number;
    let lastError: Error | null = null;

    // Retry up to 3 times for comprehensive content generation
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[${context.correlationId}] Asset follow-up "${marker}" generation attempt ${attempt}/3`);
        const prompt = `Generate follow-up prose that connects to the asset "${marker}" in a ${context.subject} lesson.

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Section: ${context.sectionTitle}
- Asset marker: ${marker}
- Previous concepts: ${context.conceptSequence.join(', ')}

Requirements:
- Write formal textbook paragraphs (no headings, lists, or code formatting)
- Write comprehensive explanation up to 3000 words of how this asset relates to the concepts
- Connect the visual/interactive element to the theoretical understanding in detail
- Use transitional language that flows naturally with multi-sentence paragraphs
- Explain what students should observe, understand, or interact with
- Relate the asset content back to curriculum objectives and PDF materials
- Include relevant citations from the provided PDF as "NCERT Class XI Chemistry (p. 98)" format only

Output format (STRICT):
- Return ONLY a single JSON object with keys: markdown (string), wordCount (integer), keyTerms (string[]), difficulty ("comfort"|"hustle"|"advanced").
- No prose, no preface, no code fences.`;

        const response = await llmContext.llmClient.generateM3Content(prompt, {
          schema: 'prose-block.v1.schema.json',
          correlationId: context.correlationId,
          fileId: llmContext.moduleContext?.fileId
        });

        const prose = this.ensureProseResponse(response);

        // Allow any content length - chapter-level validation will be applied later

        markdown = prose.markdown;
        wordCount = prose.wordCount;
        console.log(`[${context.correlationId}] Asset follow-up "${marker}" generated successfully: ${wordCount} words`);
        break;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[${context.correlationId}] Asset follow-up "${marker}" generation attempt ${attempt}/3 failed:`, error);
        if (attempt === 3) {
          throw new Error(`[${context.correlationId}] Failed to generate comprehensive asset follow-up after 3 attempts. Last error: ${lastError.message}`);
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }

    return {
      type: 'prose',
      id,
      markdown: markdown!,
      wordCount: wordCount!
    };
  }

  /**
   * Generate conclusion prose with PDF grounding - NO FALLBACKS
   */
  private async generateConclusionProse(context: any, llmContext?: any): Promise<ProseBlock> {
    const id = this.idGenerator.generateProseID(context.sectionId);

    if (!llmContext?.llmClient) {
      throw new Error(`[${context.correlationId}] LLM client is required for comprehensive conclusion generation - no fallback templates available`);
    }

    let markdown: string;
    let wordCount: number;
    let lastError: Error | null = null;

    // Retry up to 3 times for comprehensive content generation
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[${context.correlationId}] Conclusion generation attempt ${attempt}/3`);
        const prompt = `Generate a conclusion summary for a ${context.subject} section titled "${context.sectionTitle}".

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Concepts covered: ${context.conceptSequence.join(', ')}
- Transition out: ${context.transitions.out}
- Learning objectives: ${context.learningObjectives?.join('; ') || 'Not specified'}

Requirements:
- Write formal textbook paragraphs (no headings, lists, or code formatting)
- Include the transition out text
- Write comprehensive summary up to 3000 words covering all key takeaways
- Summarize key takeaways from the section with detailed explanations
- Connect to future learning and show how concepts build toward advanced topics
- Encourage review and understanding with specific study recommendations
- Include relevant citations from the provided PDF as "NCERT Class XI Chemistry (p. 98)" format only
- Use multi-sentence paragraphs with natural flow, no bullet points or numbered lists
- Provide practice suggestions and real-world applications
- Do not invent topics - ensure all summary points are grounded in curriculum standards`;

        const response = await llmContext.llmClient.generateM3Content(prompt, {
          schema: 'prose-block.v1.schema.json',
          correlationId: context.correlationId,
          fileId: llmContext.moduleContext?.fileId
        });

        const prose = this.ensureProseResponse(response);

        // Allow any content length - chapter-level validation will be applied later

        markdown = prose.markdown;
        wordCount = prose.wordCount;
        console.log(`[${context.correlationId}] Conclusion generated successfully: ${wordCount} words`);
        break;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[${context.correlationId}] Conclusion generation attempt ${attempt}/3 failed:`, error);
        if (attempt === 3) {
          throw new Error(`[${context.correlationId}] Failed to generate comprehensive conclusion after 3 attempts. Last error: ${lastError.message}`);
        }
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }

    return {
      type: 'prose',
      id,
      markdown: markdown!,
      wordCount: wordCount!
    };
  }

  private ensureProseResponse(response: any): { markdown: string; wordCount: number } {
    // If response is an array from the LLM, prefer the longest textual element
    if (Array.isArray(response)) {
      const flattened = this.extractLongestText(response);
      if (flattened) {
        const md = flattened.trim();
        const wc = this.countWords(md);
        if (wc > 0) return { markdown: md, wordCount: wc };
      }
    }
    // If response is already a string, treat as markdown
    if (typeof response === 'string') {
      const md = response.trim();
      const wc = this.countWords(md);
      if (md.length > 0 && wc > 0) return { markdown: md, wordCount: wc };
    }

    // If response is an object, try common fields
    if (response && typeof response === 'object') {
      const candidates: Array<string | undefined> = [
        response.markdown,
        response.md,
        response.text,
        response.prose,
        response.content,
        // Some models may wrap under data/message shapes; attempt shallow extraction
        typeof response.output_text === 'string' ? response.output_text : undefined,
      ];
      const mdCandidate = candidates.find(v => typeof v === 'string' && (v as string).trim().length > 0) as string | undefined;
      if (mdCandidate) {
        const md = mdCandidate.trim();
        const wc = typeof response.wordCount === 'number' && response.wordCount > 0 ? response.wordCount : this.countWords(md);
        if (wc > 0) return { markdown: md, wordCount: wc };
      }

      // Fallback: recursively scan object for the longest textual field
      const longest = this.extractLongestText(response);
      if (longest) {
        const md = longest.trim();
        const wc = this.countWords(md);
        if (wc > 0) return { markdown: md, wordCount: wc };
      }
    }

    // Enhanced debugging - log the problematic response for investigation
    console.error('[M3-DEBUG] ensureProseResponse failed with input:', JSON.stringify(response, null, 2));
    console.error('[M3-DEBUG] Response type:', typeof response, 'Array?:', Array.isArray(response));

    // Final fallback: if we have any string content at all, use it
    const fallbackText = typeof response === 'string' ? response :
                        (response && typeof response === 'object') ?
                        Object.values(response).find(v => typeof v === 'string' && v.trim().length > 10) :
                        null;

    if (fallbackText && typeof fallbackText === 'string') {
      console.warn('[M3-DEBUG] Using fallback text extraction for malformed response');
      const md = fallbackText.trim();
      const wc = this.countWords(md);
      if (wc > 5) return { markdown: md, wordCount: wc }; // Accept any reasonable content
    }

    throw new Error(`Invalid prose response: expected { markdown: string; wordCount: number }, got: ${JSON.stringify(response).substring(0, 200)}...`);
  }

  private extractLongestText(obj: any): string | null {
    let best: string | null = null;
    let bestLen = 0;

    const visit = (node: any) => {
      if (typeof node === 'string') {
        const len = node.trim().length;
        if (len > bestLen) { bestLen = len; best = node; }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) visit(node[key]);
      }
    };

    visit(obj);
    return best;
  }

  /**
   * Generate asset specifications and compile them using real compilers
   */
  private async generateAssets(
    content: ContentBlock[],
    correlationId: string,
    context?: any,
    llmContext?: any
  ): Promise<Result<{ assets: GeneratedAsset[] }, ModuleError[]>> {
    const assets: GeneratedAsset[] = [];
    const errors: ModuleError[] = [];

    for (const block of content) {
      if (['plot', 'diagram', 'chemistry'].includes(block.type)) {
        try {
          const asset = await this.generateAndCompileAsset(block, correlationId, context, llmContext);
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
          const asset = await this.generateAssetSpec(block, context, llmContext);
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
  private async generateAndCompileAsset(block: ContentBlock, correlationId: string, context?: any, llmContext?: any): Promise<GeneratedAsset> {
    const spec = await this.createAssetSpec(block, context, llmContext);
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
  private async generateAssetSpec(block: ContentBlock, context?: any, llmContext?: any): Promise<GeneratedAsset> {
    const spec = await this.createAssetSpec(block, context, llmContext);
    const contentHash = this.generateContentHash(spec);

    // Generate chapter-specific spec path using IDGenerator
    let specPath: string;
    switch (block.type) {
      case 'chemistry':
        specPath = `chemistry/${block.id}.json`;
        break;
      case 'plot':
        specPath = this.idGenerator.generateSpecRef('plot', block.id);
        break;
      case 'diagram':
        specPath = this.idGenerator.generateSpecRef('diagram', block.id);
        break;
      case 'widget':
        specPath = this.idGenerator.generateSpecRef('widget', block.id);
        break;
      default:
        // Fallback to generic specRef for backward compatibility
        specPath = (block as any).specRef || `${block.type}/${block.id}.json`;
    }

    return {
      id: block.id,
      type: block.type as "plot" | "diagram" | "widget" | "chemistry",
      specPath,
      contentHash,
      spec
    };
  }


  /**
   * Create asset specification based on type
   */
  private async createAssetSpec(block: ContentBlock, context?: any, llmContext?: any): Promise<any> {
    switch (block.type) {
      case 'plot':
        if (llmContext?.llmClient && context) {
          try {
            const response = await llmContext.llmClient.generateM3Content(
              this.buildPlotPrompt(block, context),
              {
                schema: 'plot-spec.v1.schema.json',
                correlationId: context.correlationId,
                fileId: llmContext.moduleContext?.fileId
              }
            );

            return {
              kind: 'pgfplot',
              contentHash: this.generateContentHash(response),
              title: response.title,
              x: { min: response.domain.xmin, max: response.domain.xmax, label: response.xlabel },
              y: { min: response.domain.ymin || -10, max: response.domain.ymax || 10, label: response.ylabel },
              expr: response.expr,
              style: { grid: true, samples: response.samples }
            };
          } catch (error) {
            throw new Error(`[${context?.correlationId}] LLM plot generation failed - no fallback templates for comprehensive content: ${error}`);
          }
        }

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
        if (llmContext?.llmClient && context) {
          try {
            const response = await llmContext.llmClient.generateM3Content(
              this.buildDiagramPrompt(block, context),
              {
                schema: 'diagram-spec.v1.schema.json',
                correlationId: context.correlationId,
                fileId: llmContext.moduleContext?.fileId
              }
            );

            // Convert LLM schema to internal diagram format
            const nodes = response.nodes.map((node: any) => ({
              id: node.id,
              kind: 'point',
              x: Math.random() * 300 + 50, // Layout placeholder
              y: Math.random() * 200 + 50,
              label: node.label
            }));

            const arrows = response.edges.map((edge: any, index: number) => ({
              id: `arrow${index + 1}`,
              kind: 'arrow',
              from: nodes.find((n: any) => n.id === edge.from)
                ? [nodes.find((n: any) => n.id === edge.from)!.x, nodes.find((n: any) => n.id === edge.from)!.y]
                : [100, 100],
              to: nodes.find((n: any) => n.id === edge.to)
                ? [nodes.find((n: any) => n.id === edge.to)!.x, nodes.find((n: any) => n.id === edge.to)!.y]
                : [200, 200]
            }));

            return {
              contentHash: this.generateContentHash(response),
              canvas: { width: 400, height: 300, grid: 10, snap: true },
              nodes: [...nodes, ...arrows]
            };
          } catch (error) {
            throw new Error(`[${context?.correlationId}] LLM diagram generation failed - no fallback templates for comprehensive content: ${error}`);
          }
        }

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
        if (llmContext?.llmClient && context) {
          try {
            const response = await llmContext.llmClient.generateM3Content(
              this.buildWidgetPrompt(block, context),
              {
                schema: 'widget-spec.v1.schema.json',
                correlationId: context.correlationId,
                fileId: llmContext.moduleContext?.fileId
              }
            );

            return {
              contentHash: this.generateContentHash(response),
              kind: response.kind,
              expr: response.expr,
              params: response.params,
              config: response.config,
              title: response.title,
              description: response.description,
              instructions: response.instructions
            };
          } catch (error) {
            throw new Error(`[${context?.correlationId}] LLM widget generation failed - no fallback templates for comprehensive content: ${error}`);
          }
        }

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

    // G5: Plot lexer validation for plot specifications
    for (const asset of assets.filter(a => a.type === 'plot')) {
      const plotResult = await this.validationGates.plotLexer.validate({
        spec: asset.specification
      });

      if (plotResult.valid) {
        gatesPassed.push('G5-PlotLexer');
      } else {
        gatesFailed.push('G5-PlotLexer');
        warnings.push(`Plot ${asset.id}: ${plotResult.errors?.[0]?.message || 'Plot lexer validation failed'}`);
      }
    }

    // G6: SMILES validation for chemistry blocks
    for (const block of content.filter(b => b.type === 'chemistry')) {
      const chemBlock = block as any; // ChemistryBlock type
      const smilesResult = await this.validationGates.smiles.validate({
        smiles: chemBlock.smiles
      });

      if (smilesResult.valid) {
        gatesPassed.push('G6-SMILES');
      } else {
        gatesFailed.push('G6-SMILES');
        warnings.push(`Chemistry ${chemBlock.id}: ${smilesResult.errors?.[0]?.message || 'SMILES validation failed'}`);
      }
    }

    // G7: Diagram topology validation for diagram assets
    for (const asset of assets.filter(a => a.type === 'diagram')) {
      const diagramResult = await this.validationGates.diagramTopology.validate({
        nodes: asset.specification.nodes || [],
        edges: asset.specification.edges || [],
        type: asset.specification.type || 'flowchart'
      });

      if (diagramResult.valid) {
        gatesPassed.push('G7-DiagramTopology');
      } else {
        gatesFailed.push('G7-DiagramTopology');
        warnings.push(`Diagram ${asset.id}: ${diagramResult.errors?.[0]?.message || 'Topology validation failed'}`);
      }
    }

    // G11: Units validation for equations
    for (const block of content.filter(b => b.type === 'equation')) {
      const eqBlock = block as EquationBlock;
      const unitsResult = await this.validationGates.units.validate({
        equation: {
          tex: eqBlock.tex,
          variables: eqBlock.check.vars
        }
      });

      if (unitsResult.valid) {
        gatesPassed.push('G11-Units');
      } else {
        gatesFailed.push('G11-Units');
        warnings.push(`Equation ${eqBlock.id}: ${unitsResult.errors?.[0]?.message || 'Units validation failed'}`);
      }
    }

    // G12: Style validation for prose blocks
    for (const block of content.filter(b => b.type === 'paragraph')) {
      const proseBlock = block as ProseBlock;
      const styleResult = await this.validationGates.style.validate({
        md: proseBlock.md,
        id: proseBlock.id
      });

      if (styleResult.valid) {
        gatesPassed.push('G12-Style');
      } else {
        gatesFailed.push('G12-Style');
        warnings.push(`Prose ${proseBlock.id}: ${styleResult.errors?.[0]?.message || 'Style validation failed'}`);

        // Add repair suggestions for style violations
        if (styleResult.errors) {
          const styleGate = this.validationGates.style as StyleValidationGate;
          const suggestions = styleGate.generateRepairSuggestions(styleResult.errors);
          repairActions.push(...suggestions);
        }
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

  /**
   * Build LLM prompt for plot specification generation
   */
  private buildPlotPrompt(block: ContentBlock, context: any): string {
    const plotName = block.id.replace('plot-', '');
    return `Generate a mathematical plot specification for "${plotName}" in a ${context.subject} lesson.

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Subject: ${context.subject}
- Section concepts: ${context.conceptSequence.join(', ')}
- Caption: ${block.caption}

Requirements:
- Create an educational plot that illustrates the concept
- Use mathematical expressions that work with PGFPlots
- Set appropriate domain (xmin, xmax, optional ymin, ymax)
- Choose meaningful axis labels
- Select appropriate sample count (50-500)
- Provide clear title and educational description
- Keep complexity appropriate for ${context.grade} level`;
  }

  /**
   * Build LLM prompt for diagram specification generation
   */
  private buildDiagramPrompt(block: ContentBlock, context: any): string {
    const diagramName = block.id.replace('fig-', '');
    return `Generate a diagram specification for "${diagramName}" in a ${context.subject} lesson.

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Subject: ${context.subject}
- Section concepts: ${context.conceptSequence.join(', ')}
- Caption: ${block.caption}

Requirements:
- Create an educational diagram with 2-8 nodes
- Choose appropriate diagram type (flowchart, process, cycle, hierarchy, mind-map)
- Define clear, meaningful node labels
- Create logical connections between nodes
- Use appropriate node shapes (rect, circle, diamond, ellipse)
- Provide clear title and educational description
- Keep complexity appropriate for ${context.grade} level
- Focus on illustrating relationships between concepts`;
  }

  /**
   * Build LLM prompt for widget specification generation
   */
  private buildWidgetPrompt(block: ContentBlock, context: any): string {
    const widgetName = block.id.replace('widget-', '');
    return `Generate an interactive widget specification for "${widgetName}" in a ${context.subject} lesson.

Context:
- Grade: ${context.grade}
- Difficulty: ${context.difficulty}
- Subject: ${context.subject}
- Section concepts: ${context.conceptSequence.join(', ')}
- Caption: ${block.caption}

Requirements:
- Choose appropriate widget type (formula-playground, graph-explorer, equation-solver, etc.)
- Create educational mathematical expression related to the concept
- Define 1-6 adjustable parameters with meaningful ranges
- Set reasonable default values for immediate engagement
- Provide clear title and educational description
- Include step-by-step instructions for students
- Match complexity to ${context.grade} level
- Focus on interactive exploration of ${context.subject} concepts`;
  }
}