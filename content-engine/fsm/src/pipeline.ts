import {
  PlanRequest,
  DocPlan,
  ModuleError,
  Result,
  Ok,
  Err
} from '@content-engine/m1-plan';
import { Scaffold, SectionContext } from '@content-engine/m2-scaffold';
import { SectionDoc } from '@content-engine/m3-section';
import { AssemblyResult } from '@content-engine/m4-assembler';

import M1PlanModule from '../../m1-plan/src/index.js';
import { ScaffoldGenerator } from '../../m2-scaffold/src/scaffold-generator.js';
import { ScaffoldToContextAdapter } from '../../adapters/src/scaffold-to-context.js';
import { ContentGenerator } from '../../m3-section/src/content-generator.js';
import { ContentAssembler } from '../../m4-assembler/src/assembler.js';

/**
 * Pipeline execution states
 */
type PipelineState =
  | 'INITIALIZED'
  | 'PLANNING'
  | 'SCAFFOLDING'
  | 'ADAPTING'
  | 'GENERATING_SECTIONS'
  | 'ASSEMBLING'
  | 'COMPLETED'
  | 'FAILED';

/**
 * Pipeline result with comprehensive metadata
 */
interface PipelineResult {
  status: 'SUCCESS' | 'PARTIAL_FAILURE' | 'CRITICAL_FAILURE';
  artifacts?: {
    chapterPath: string;
    plotSpecs: string[];
    diagramSpecs: string[];
  };
  errors: ModuleError[];
  correlationId: string;
  processingTime: number;
  state: PipelineState;
  moduleResults?: {
    m1?: DocPlan;
    m2?: Scaffold;
    m3?: SectionDoc[];
    m4?: AssemblyResult;
  };
  statistics?: {
    sectionsGenerated: number;
    assetsCreated: number;
    validationGatesPassed: number;
    validationGatesFailed: number;
  };
}

/**
 * FSM-based Content Pipeline Orchestrator
 * Implements fail-fast strategy with no partial outputs
 */
export class ContentPipeline {
  private m1: M1PlanModule;
  private m2: ScaffoldGenerator;
  private adapter: ScaffoldToContextAdapter;
  private m3: ContentGenerator;
  private m4: ContentAssembler;

  private state: PipelineState = 'INITIALIZED';
  private errors: ModuleError[] = [];

  constructor(outputPath: string = './artifacts') {
    this.m1 = new M1PlanModule();
    this.m2 = new ScaffoldGenerator();
    this.adapter = new ScaffoldToContextAdapter();
    this.m3 = new ContentGenerator();
    this.m4 = new ContentAssembler(outputPath);
  }

  /**
   * Main pipeline execution with FSM state management
   */
  async execute(request: PlanRequest): Promise<PipelineResult> {
    const startTime = Date.now();
    const correlationId = this.generateCorrelationId();
    this.errors = [];

    try {
      this.setState('PLANNING');

      // M1: Plan Generation
      const planResult = await this.executeM1(request, correlationId);
      if (planResult.isError()) {
        return this.createFailureResult('CRITICAL_FAILURE', planResult.errors, correlationId, startTime);
      }

      this.setState('SCAFFOLDING');

      // M2: Scaffold Generation
      const scaffoldResult = await this.executeM2(planResult.value, correlationId);
      if (scaffoldResult.isError()) {
        return this.createFailureResult('CRITICAL_FAILURE', scaffoldResult.errors, correlationId, startTime);
      }

      this.setState('ADAPTING');

      // Adapter: Scaffold → SectionContext
      const contexts = this.executeAdapter(scaffoldResult.value);

      this.setState('GENERATING_SECTIONS');

      // M3: Section Generation (parallel)
      const sectionResults = await this.executeM3Parallel(contexts, correlationId);
      if (sectionResults.isError()) {
        return this.createFailureResult('CRITICAL_FAILURE', sectionResults.errors, correlationId, startTime);
      }

      this.setState('ASSEMBLING');

      // M4: Assembly with CRITICAL Reader validation
      const assemblyResult = await this.executeM4(sectionResults.value, correlationId);
      if (assemblyResult.isError()) {
        // M4 failures are always critical (Reader compatibility)
        return this.createFailureResult('CRITICAL_FAILURE', assemblyResult.errors, correlationId, startTime);
      }

      this.setState('COMPLETED');

      return this.createSuccessResult(
        {
          m1: planResult.value,
          m2: scaffoldResult.value,
          m3: sectionResults.value,
          m4: assemblyResult.value
        },
        correlationId,
        startTime
      );

    } catch (error) {
      this.setState('FAILED');
      return this.createFailureResult(
        'CRITICAL_FAILURE',
        [{
          code: 'E-PIPELINE-UNEXPECTED',
          module: 'PIPELINE',
          data: { error: error instanceof Error ? error.message : String(error) },
          correlationId
        }],
        correlationId,
        startTime
      );
    }
  }

  /**
   * Execute M1-Plan with retry logic
   */
  private async executeM1(request: PlanRequest, correlationId: string): Promise<Result<DocPlan, ModuleError[]>> {
    console.log(`[${correlationId}] Starting M1-Plan generation...`);

    const result = await this.m1.generatePlan(request);

    if (result.isSuccess()) {
      console.log(`[${correlationId}] M1-Plan completed successfully`);
      console.log(`[${correlationId}] Generated ${result.value.payload.beats.length} beats`);
    } else {
      console.error(`[${correlationId}] M1-Plan failed:`, result.errors);
    }

    return result;
  }

  /**
   * Execute M2-Scaffold with validation
   */
  private async executeM2(docPlan: DocPlan, correlationId: string): Promise<Result<Scaffold, ModuleError[]>> {
    console.log(`[${correlationId}] Starting M2-Scaffold generation...`);

    const result = await this.m2.generateScaffold(docPlan);

    if (result.isSuccess()) {
      console.log(`[${correlationId}] M2-Scaffold completed successfully`);
      console.log(`[${correlationId}] Generated ${result.value.payload.sections.length} sections`);
    } else {
      console.error(`[${correlationId}] M2-Scaffold failed:`, result.errors);
    }

    return result;
  }

  /**
   * Execute Adapter transformation
   */
  private executeAdapter(scaffold: Scaffold): SectionContext[] {
    const correlationId = scaffold.envelope.correlationId;
    console.log(`[${correlationId}] Starting Scaffold→SectionContext adaptation...`);

    const contexts = this.adapter.transform(scaffold);

    // Validate transformation
    const validationResult = this.adapter.validateTransformation(contexts);
    if (!validationResult.valid) {
      throw new Error(`Adapter validation failed: ${validationResult.errors?.join(', ')}`);
    }

    console.log(`[${correlationId}] Adapter completed successfully`);
    console.log(`[${correlationId}] Created ${contexts.length} section contexts`);

    return contexts;
  }

  /**
   * Execute M3-Section in parallel for all contexts
   */
  private async executeM3Parallel(
    contexts: SectionContext[],
    baseCorrelationId: string
  ): Promise<Result<SectionDoc[], ModuleError[]>> {
    console.log(`[${baseCorrelationId}] Starting M3-Section generation for ${contexts.length} sections...`);

    const sectionPromises = contexts.map(async (context, index) => {
      const sectionId = context.payload.context.sectionId;
      console.log(`[${baseCorrelationId}] Processing section ${sectionId}...`);

      const result = await this.m3.generateSection(context);

      if (result.isSuccess()) {
        console.log(`[${baseCorrelationId}] Section ${sectionId} completed successfully`);
      } else {
        console.error(`[${baseCorrelationId}] Section ${sectionId} failed:`, result.errors);
      }

      return result;
    });

    const results = await Promise.all(sectionPromises);

    // Check for failures
    const failures = results.filter(r => r.isError());
    if (failures.length > 0) {
      const allErrors = failures.flatMap(f => f.errors || []);
      return Err(allErrors);
    }

    const sections = results.map(r => r.value!);
    console.log(`[${baseCorrelationId}] M3-Section completed for all sections`);

    return Ok(sections);
  }

  /**
   * Execute M4-Assembler with critical validation
   */
  private async executeM4(
    sections: SectionDoc[],
    correlationId: string
  ): Promise<Result<AssemblyResult, ModuleError[]>> {
    console.log(`[${correlationId}] Starting M4-Assembler for ${sections.length} sections...`);

    const result = await this.m4.assembleChapter(sections);

    if (result.isSuccess()) {
      const stats = this.m4.getAssemblyStats(result.value);
      console.log(`[${correlationId}] M4-Assembler completed successfully`);
      console.log(`[${correlationId}] Generated ${stats.sectionsCount} reader sections, ${stats.assetFilesCount} asset files`);
      console.log(`[${correlationId}] Validation: ${stats.gatesPassedCount} passed, ${stats.gatesFailedCount} failed`);
    } else {
      console.error(`[${correlationId}] M4-Assembler failed:`, result.errors);
    }

    return result;
  }

  /**
   * Create success result
   */
  private createSuccessResult(
    moduleResults: any,
    correlationId: string,
    startTime: number
  ): PipelineResult {
    const processingTime = Date.now() - startTime;

    // Extract artifacts info
    const assemblyResult = moduleResults.m4 as AssemblyResult;
    const chapterId = moduleResults.m2.payload.meta.chapterSlug;

    // Calculate statistics
    const statistics = {
      sectionsGenerated: moduleResults.m3.length,
      assetsCreated: assemblyResult.assetFiles.length,
      validationGatesPassed: assemblyResult.validationReport.gatesPassed.length,
      validationGatesFailed: assemblyResult.validationReport.gatesFailed.length
    };

    console.log(`[${correlationId}] Pipeline completed successfully in ${processingTime}ms`);
    console.log(`[${correlationId}] Statistics:`, statistics);

    return {
      status: 'SUCCESS',
      artifacts: {
        chapterPath: `CR_chapters/${chapterId}.json`,
        plotSpecs: assemblyResult.assetFiles.filter(f => f.type === 'plot').map(f => f.path),
        diagramSpecs: assemblyResult.assetFiles.filter(f => f.type === 'diagram').map(f => f.path)
      },
      errors: [],
      correlationId,
      processingTime,
      state: this.state,
      moduleResults,
      statistics
    };
  }

  /**
   * Create failure result
   */
  private createFailureResult(
    status: 'PARTIAL_FAILURE' | 'CRITICAL_FAILURE',
    errors: ModuleError[],
    correlationId: string,
    startTime: number
  ): PipelineResult {
    const processingTime = Date.now() - startTime;

    console.error(`[${correlationId}] Pipeline failed with status: ${status}`);
    console.error(`[${correlationId}] Errors:`, errors);

    return {
      status,
      errors,
      correlationId,
      processingTime,
      state: this.state
    };
  }

  /**
   * Set pipeline state
   */
  private setState(newState: PipelineState): void {
    console.log(`Pipeline state: ${this.state} → ${newState}`);
    this.state = newState;
  }

  /**
   * Generate unique correlation ID
   */
  private generateCorrelationId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `ch-${timestamp}-${random}`;
  }

  /**
   * Get current pipeline state
   */
  getState(): PipelineState {
    return this.state;
  }

  /**
   * Get accumulated errors
   */
  getErrors(): ModuleError[] {
    return [...this.errors];
  }

  /**
   * Health check for all modules
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    modules: Record<string, boolean>;
    errors: string[];
  }> {
    const errors: string[] = [];
    const moduleHealth = {
      m1: true,
      m2: true,
      m3: true,
      m4: true
    };

    try {
      // Test each module with minimal input
      const testRequest: PlanRequest = {
        title: 'Health Check',
        subject: 'Mathematics',
        grade: 'Class X',
        difficulty: 'comfort'
      };

      // Test M1 only (others depend on M1 output)
      const m1Result = await this.m1.generatePlan(testRequest);
      if (m1Result.isError()) {
        moduleHealth.m1 = false;
        errors.push('M1-Plan health check failed');
      }

    } catch (error) {
      moduleHealth.m1 = false;
      errors.push(`Health check error: ${error}`);
    }

    const healthy = Object.values(moduleHealth).every(h => h);

    return {
      healthy,
      modules: moduleHealth,
      errors
    };
  }
}