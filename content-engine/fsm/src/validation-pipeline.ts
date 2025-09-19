import { AjvValidationGate } from '../../validators/src/ajv-validator.js';
import { KatexValidationGate } from '../../validators/src/katex-validator.js';
import { MathValidationGate } from '../../validators/src/math-validator.js';
import { PlotLexerValidationGate } from '../../validators/src/plot-lexer-validator.js';
import { SmilesValidationGate } from '../../validators/src/smiles-validator.js';
import { CrossReferenceValidationGate } from '../../validators/src/cross-reference-validator.js';
import { UnicodeSanitizerGate } from '../../validators/src/unicode-sanitizer.js';
import { UnitsValidationGate } from '../../validators/src/units-validator.js';
import { RepairEngine } from './repair-engine.js';
import type { ModuleError, ValidationResult } from '../../schemas-shared/types.js';

/**
 * Validation Pipeline Orchestrator
 * Coordinates all validation gates with automatic error repair
 */
export class ValidationPipeline {
  private gates: Map<string, any> = new Map();
  private repairEngine: RepairEngine;
  private validationHistory: ValidationRecord[] = [];

  constructor() {
    this.initializeGates();
    this.repairEngine = new RepairEngine();
  }

  /**
   * Initialize all validation gates
   */
  private initializeGates(): void {
    this.gates.set('G1', new AjvValidationGate());
    this.gates.set('G3', new KatexValidationGate());
    this.gates.set('G4', new MathValidationGate());
    this.gates.set('G5', new PlotLexerValidationGate());
    this.gates.set('G6', new SmilesValidationGate());
    this.gates.set('G8', new CrossReferenceValidationGate());
    this.gates.set('G9', new UnicodeSanitizerGate());
    this.gates.set('G11', new UnitsValidationGate());
  }

  /**
   * Run complete validation pipeline with repair capability
   */
  async validateWithRepair(
    content: ValidationContent,
    correlationId: string,
    options: ValidationOptions = {}
  ): Promise<PipelineValidationResult> {
    const startTime = Date.now();
    const { enableRepair = true, maxRepairAttempts = 3, gateSelection } = options;

    let currentContent = content;
    let repairAttempts = 0;
    const allResults: GateResult[] = [];
    let finalErrors: ModuleError[] = [];

    while (repairAttempts <= maxRepairAttempts) {
      const isRepairAttempt = repairAttempts > 0;

      // Run validation gates
      const gateResults = await this.runValidationGates(
        currentContent,
        correlationId,
        gateSelection,
        isRepairAttempt
      );

      allResults.push(...gateResults);

      // Check if all gates passed
      const failedGates = gateResults.filter(result => !result.passed);

      if (failedGates.length === 0) {
        // All validations passed
        const record = this.createValidationRecord(
          correlationId,
          gateResults,
          true,
          Date.now() - startTime,
          repairAttempts
        );

        this.validationHistory.push(record);

        return {
          success: true,
          validatedContent: currentContent,
          gateResults,
          repairAttempts,
          totalTime: Date.now() - startTime,
          correlationId
        };
      }

      // Extract errors from failed gates
      const errors = this.extractErrorsFromFailedGates(failedGates);
      finalErrors = errors;

      // If repair is disabled or max attempts reached, return failure
      if (!enableRepair || repairAttempts >= maxRepairAttempts) {
        const record = this.createValidationRecord(
          correlationId,
          gateResults,
          false,
          Date.now() - startTime,
          repairAttempts,
          errors
        );

        this.validationHistory.push(record);

        return {
          success: false,
          errors,
          gateResults,
          repairAttempts,
          totalTime: Date.now() - startTime,
          correlationId
        };
      }

      // Attempt repair
      const repairResult = await this.repairEngine.attemptRepair(
        'validation-pipeline',
        errors,
        `${correlationId}-repair-${repairAttempts}`
      );

      if (!repairResult.success) {
        // Repair failed, increment attempts and try again or exit
        repairAttempts++;
        continue;
      }

      // Apply repaired content
      currentContent = this.mergeRepairedContent(currentContent, repairResult.repairedContent);
      repairAttempts++;

      // Log repair success
      console.log(`Repair attempt ${repairAttempts} successful for ${correlationId}`);
    }

    // All repair attempts exhausted
    const record = this.createValidationRecord(
      correlationId,
      allResults,
      false,
      Date.now() - startTime,
      repairAttempts,
      finalErrors
    );

    this.validationHistory.push(record);

    return {
      success: false,
      errors: finalErrors,
      gateResults: allResults,
      repairAttempts,
      totalTime: Date.now() - startTime,
      correlationId
    };
  }

  /**
   * Run validation gates without repair (fast path)
   */
  async validateOnly(
    content: ValidationContent,
    correlationId: string,
    gateSelection?: string[]
  ): Promise<ValidationOnlyResult> {
    const startTime = Date.now();

    const gateResults = await this.runValidationGates(content, correlationId, gateSelection);
    const failedGates = gateResults.filter(result => !result.passed);
    const success = failedGates.length === 0;

    const errors = success ? [] : this.extractErrorsFromFailedGates(failedGates);

    const record = this.createValidationRecord(
      correlationId,
      gateResults,
      success,
      Date.now() - startTime,
      0,
      errors
    );

    this.validationHistory.push(record);

    return {
      success,
      errors,
      gateResults,
      totalTime: Date.now() - startTime,
      correlationId
    };
  }

  /**
   * Run individual validation gates
   */
  private async runValidationGates(
    content: ValidationContent,
    correlationId: string,
    gateSelection?: string[],
    isRepairAttempt: boolean = false
  ): Promise<GateResult[]> {
    const results: GateResult[] = [];
    const gatesToRun = gateSelection || Array.from(this.gates.keys());

    // Run gates sequentially to maintain order and dependencies
    for (const gateId of gatesToRun) {
      const gate = this.gates.get(gateId);

      if (!gate) {
        console.warn(`Unknown validation gate: ${gateId}`);
        continue;
      }

      const gateStartTime = Date.now();

      try {
        const validationInput = this.prepareValidationInput(gateId, content, correlationId);

        if (!validationInput) {
          // Skip gate if no relevant content
          continue;
        }

        const result = await gate.validate(validationInput);
        const gateTime = Date.now() - gateStartTime;

        results.push({
          gateId,
          gateName: gate.name || gateId,
          passed: result.valid,
          errors: result.valid ? [] : (result.errors || [{ message: 'Validation failed', code: `E-${gateId}` }]),
          warnings: result.warnings || [],
          data: result.data,
          executionTime: gateTime,
          isRepairAttempt,
          correlationId
        });

        // Log gate execution
        if (isRepairAttempt) {
          console.log(`Gate ${gateId} (repair attempt): ${result.valid ? 'PASSED' : 'FAILED'} in ${gateTime}ms`);
        }

      } catch (error) {
        const gateTime = Date.now() - gateStartTime;

        results.push({
          gateId,
          gateName: gate.name || gateId,
          passed: false,
          errors: [{
            message: error instanceof Error ? error.message : 'Unknown gate error',
            code: `E-${gateId}-EXCEPTION`,
            context: { error: error instanceof Error ? error.toString() : String(error) }
          }],
          warnings: [],
          executionTime: gateTime,
          isRepairAttempt,
          correlationId
        });

        console.error(`Gate ${gateId} threw exception:`, error);
      }
    }

    return results;
  }

  /**
   * Prepare validation input for specific gate
   */
  private prepareValidationInput(gateId: string, content: ValidationContent, correlationId: string): any {
    switch (gateId) {
      case 'G1': // AJV Schema
        return {
          data: content.schemaData || content,
          schemaName: content.schemaName || 'default.schema.json',
          context: correlationId
        };

      case 'G3': // KaTeX
        return content.texExpressions?.length > 0 ? {
          tex: content.texExpressions[0],
          context: correlationId
        } : null;

      case 'G4': // Math Expression
        return content.mathExpressions?.length > 0 ? {
          expression: content.mathExpressions[0].expression,
          variables: content.mathExpressions[0].variables,
          expectedForm: content.mathExpressions[0].expectedForm,
          context: correlationId
        } : null;

      case 'G5': // Plot Lexer
        return content.plotExpressions?.length > 0 ? {
          expr: content.plotExpressions[0],
          context: correlationId
        } : null;

      case 'G6': // SMILES
        return content.smilesStrings?.length > 0 ? {
          smiles: content.smilesStrings[0],
          context: correlationId
        } : null;

      case 'G8': // Cross Reference
        return content.crossReferences ? {
          references: content.crossReferences,
          context: correlationId
        } : null;

      case 'G9': // Unicode
        return content.textContent ? {
          text: content.textContent,
          mode: 'strict',
          context: correlationId
        } : null;

      case 'G11': // Units
        return content.unitsExpressions?.length > 0 ? {
          expression: content.unitsExpressions[0].expression,
          variables: content.unitsExpressions[0].variables,
          context: correlationId
        } : null;

      default:
        return content;
    }
  }

  /**
   * Extract errors from failed gates
   */
  private extractErrorsFromFailedGates(failedGates: GateResult[]): ModuleError[] {
    const errors: ModuleError[] = [];

    for (const gate of failedGates) {
      for (const error of gate.errors) {
        errors.push({
          message: error.message,
          code: error.code || `E-${gate.gateId}`,
          context: {
            ...error.context,
            gateId: gate.gateId,
            gateName: gate.gateName,
            correlationId: gate.correlationId
          }
        });
      }
    }

    return errors;
  }

  /**
   * Merge repaired content with original content
   */
  private mergeRepairedContent(original: ValidationContent, repaired: any): ValidationContent {
    // Deep merge repaired content, prioritizing repaired values
    const merged = { ...original };

    if (repaired.tex_expression && merged.texExpressions) {
      merged.texExpressions[0] = repaired.tex_expression;
    }

    if (repaired.math_expression && merged.mathExpressions) {
      merged.mathExpressions[0].expression = repaired.math_expression;
    }

    if (repaired.plot_expression && merged.plotExpressions) {
      merged.plotExpressions[0] = repaired.plot_expression;
    }

    if (repaired.smiles_string && merged.smilesStrings) {
      merged.smilesStrings[0] = repaired.smiles_string;
    }

    if (repaired.text_content && merged.textContent) {
      merged.textContent = repaired.text_content;
    }

    // Merge any additional fields
    for (const [key, value] of Object.entries(repaired)) {
      if (!key.startsWith('_') && !merged.hasOwnProperty(key)) {
        (merged as any)[key] = value;
      }
    }

    return merged;
  }

  /**
   * Create validation record for history
   */
  private createValidationRecord(
    correlationId: string,
    gateResults: GateResult[],
    success: boolean,
    totalTime: number,
    repairAttempts: number,
    errors: ModuleError[] = []
  ): ValidationRecord {
    return {
      timestamp: new Date().toISOString(),
      correlationId,
      success,
      gatesRun: gateResults.length,
      gatesPassed: gateResults.filter(r => r.passed).length,
      gatesFailed: gateResults.filter(r => !r.passed).length,
      totalTime,
      repairAttempts,
      errors: errors.length,
      gateResults: gateResults.map(r => ({
        gateId: r.gateId,
        passed: r.passed,
        executionTime: r.executionTime,
        errorCount: r.errors.length
      }))
    };
  }

  /**
   * Get validation statistics
   */
  getValidationStatistics(): ValidationStatistics {
    const total = this.validationHistory.length;
    const successful = this.validationHistory.filter(r => r.success).length;

    const gateStats = new Map<string, { runs: number; passes: number; failures: number; avgTime: number }>();

    this.validationHistory.forEach(record => {
      record.gateResults.forEach(gate => {
        if (!gateStats.has(gate.gateId)) {
          gateStats.set(gate.gateId, { runs: 0, passes: 0, failures: 0, avgTime: 0 });
        }

        const stats = gateStats.get(gate.gateId)!;
        stats.runs++;
        stats.avgTime = (stats.avgTime * (stats.runs - 1) + gate.executionTime) / stats.runs;

        if (gate.passed) {
          stats.passes++;
        } else {
          stats.failures++;
        }
      });
    });

    return {
      totalValidations: total,
      successfulValidations: successful,
      successRate: total > 0 ? successful / total : 0,
      averageValidationTime: total > 0
        ? this.validationHistory.reduce((sum, r) => sum + r.totalTime, 0) / total
        : 0,
      averageRepairAttempts: total > 0
        ? this.validationHistory.reduce((sum, r) => sum + r.repairAttempts, 0) / total
        : 0,
      gateStatistics: Object.fromEntries(
        Array.from(gateStats.entries()).map(([gateId, stats]) => [
          gateId,
          {
            ...stats,
            successRate: stats.runs > 0 ? stats.passes / stats.runs : 0
          }
        ])
      )
    };
  }

  /**
   * Get validation history
   */
  getValidationHistory(): ValidationRecord[] {
    return [...this.validationHistory];
  }

  /**
   * Clear validation history
   */
  clearHistory(): void {
    this.validationHistory = [];
    this.repairEngine.clearHistory();
  }

  /**
   * Get available gates
   */
  getAvailableGates(): Array<{ id: string; name: string; description: string }> {
    const gateInfo = [
      { id: 'G1', name: 'AJV Schema Validation', description: 'JSON Schema validation with AJV' },
      { id: 'G3', name: 'KaTeX Validation', description: 'LaTeX expression validation' },
      { id: 'G4', name: 'Math Expression Validation', description: 'Mathematical expression testing' },
      { id: 'G5', name: 'Plot Lexer Validation', description: 'Plot expression safety validation' },
      { id: 'G6', name: 'SMILES Validation', description: 'Chemical structure validation' },
      { id: 'G8', name: 'Cross Reference Validation', description: 'ID uniqueness and reference integrity' },
      { id: 'G9', name: 'Unicode Sanitization', description: 'Unicode security validation' },
      { id: 'G11', name: 'Units Validation', description: 'Dimensional analysis validation' }
    ];

    return gateInfo.filter(info => this.gates.has(info.id));
  }
}

// Type definitions
export interface ValidationContent {
  schemaData?: any;
  schemaName?: string;
  texExpressions?: string[];
  mathExpressions?: Array<{
    expression: string;
    variables: Record<string, any>;
    expectedForm?: string;
  }>;
  plotExpressions?: string[];
  smilesStrings?: string[];
  crossReferences?: any[];
  textContent?: string;
  unitsExpressions?: Array<{
    expression: string;
    variables: Record<string, any>;
  }>;
}

export interface ValidationOptions {
  enableRepair?: boolean;
  maxRepairAttempts?: number;
  gateSelection?: string[];
}

export interface PipelineValidationResult {
  success: boolean;
  validatedContent?: ValidationContent;
  errors?: ModuleError[];
  gateResults: GateResult[];
  repairAttempts: number;
  totalTime: number;
  correlationId: string;
}

export interface ValidationOnlyResult {
  success: boolean;
  errors: ModuleError[];
  gateResults: GateResult[];
  totalTime: number;
  correlationId: string;
}

export interface GateResult {
  gateId: string;
  gateName: string;
  passed: boolean;
  errors: Array<{ message: string; code?: string; context?: any }>;
  warnings: Array<{ message: string; context?: any }>;
  data?: any;
  executionTime: number;
  isRepairAttempt?: boolean;
  correlationId: string;
}

export interface ValidationRecord {
  timestamp: string;
  correlationId: string;
  success: boolean;
  gatesRun: number;
  gatesPassed: number;
  gatesFailed: number;
  totalTime: number;
  repairAttempts: number;
  errors: number;
  gateResults: Array<{
    gateId: string;
    passed: boolean;
    executionTime: number;
    errorCount: number;
  }>;
}

export interface ValidationStatistics {
  totalValidations: number;
  successfulValidations: number;
  successRate: number;
  averageValidationTime: number;
  averageRepairAttempts: number;
  gateStatistics: Record<string, {
    runs: number;
    passes: number;
    failures: number;
    avgTime: number;
    successRate: number;
  }>;
}