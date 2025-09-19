import { evaluate } from 'mathjs';
import { BaseValidationGate, ValidationResult } from './validation-gate.js';

interface EquationSpec {
  tex: string;
  check: {
    vars: Record<string, number>;
    expr: string;
    expect: number;
    tol: number;
  };
}

interface NumericValidationConfig {
  seedCount: number; // Default: 5
  tolerance: number;
  variableRanges: Record<string, {min: number, max: number}>;
  passRate: number; // Default: 0.8 (80% of trials must pass)
}

interface TrialResult {
  seed: number;
  variables: Record<string, number>;
  actual?: number;
  expected: number;
  passed: boolean;
  error?: string;
}

/**
 * Seeded Random Number Generator for deterministic trials
 */
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }

  next(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed;
  }

  uniform(min: number, max: number): number {
    return min + (this.next() / 2147483647) * (max - min);
  }
}

/**
 * G4: Enhanced Mathematical Expression Validation Gate
 * Validates mathematical expressions with multiple seeded trials
 */
export class MathValidationGate extends BaseValidationGate {
  readonly name = "Mathematical Expression Validator";
  readonly gateNumber = "G4";
  readonly description = "Validates mathematical expressions with seeded numeric trials";

  private readonly defaultConfig: NumericValidationConfig = {
    seedCount: 5,
    tolerance: 1e-10,
    variableRanges: {},
    passRate: 0.8
  };

  /**
   * Validate equation with enhanced seeded trials
   */
  async validate(input: {
    equation: EquationSpec;
    config?: Partial<NumericValidationConfig>;
  }): Promise<ValidationResult> {
    const { equation, config = {} } = input;
    const validationConfig = { ...this.defaultConfig, ...config };

    try {
      // Step 1: Validate expression syntax
      const syntaxResult = this.validateExpressionSyntax(equation.check.expr);
      if (!syntaxResult.valid) {
        return syntaxResult;
      }

      // Step 2: Validate variable names
      const variableResult = this.validateVariableNames(equation.check.vars, equation.check.expr);
      if (!variableResult.valid) {
        return variableResult;
      }

      // Step 3: Run seeded trials
      const trialsResult = await this.runSeededTrials(equation, validationConfig);
      if (!trialsResult.valid) {
        return trialsResult;
      }

      return this.createSuccess({
        equation: equation.tex,
        expression: equation.check.expr,
        trials: trialsResult.data.trials,
        passRate: trialsResult.data.passRate,
        config: validationConfig
      });

    } catch (error) {
      return this.createError(
        'E-G4-MATH-VALIDATION-ERROR',
        'Unexpected error during mathematical validation',
        {
          equation: equation.tex,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  /**
   * Validate expression syntax using mathjs
   */
  private validateExpressionSyntax(expr: string): ValidationResult {
    try {
      // Parse the expression to check syntax
      const node = evaluate.parse(expr);

      // Check for forbidden functions
      const forbiddenFunctions = ['eval', 'import', 'createUnit', 'simplify'];
      const exprLower = expr.toLowerCase();

      for (const forbidden of forbiddenFunctions) {
        if (exprLower.includes(forbidden)) {
          return this.createError(
            'E-G4-FORBIDDEN-FUNCTION',
            `Expression contains forbidden function: ${forbidden}`,
            { expr, forbidden }
          );
        }
      }

      // Validate allowed characters only
      const allowedPattern = /^[a-zA-Z0-9_\s+\-*/^().]*$/;
      if (!allowedPattern.test(expr)) {
        const invalidChars = expr.match(/[^a-zA-Z0-9_\s+\-*/^().]/g) || [];
        return this.createError(
          'E-G4-INVALID-CHARACTERS',
          'Expression contains invalid characters',
          { expr, invalidChars: [...new Set(invalidChars)] }
        );
      }

      return this.createSuccess({ parsedNode: node });

    } catch (error) {
      return this.createError(
        'E-G4-SYNTAX-ERROR',
        'Invalid mathematical expression syntax',
        {
          expr,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  /**
   * Validate that all variables in expression are defined
   */
  private validateVariableNames(vars: Record<string, number>, expr: string): ValidationResult {
    try {
      // Extract variable names from expression
      const node = evaluate.parse(expr);
      const exprVars = new Set<string>();

      // Simple variable extraction (in production, use proper AST traversal)
      const varMatches = expr.match(/[a-zA-Z][a-zA-Z0-9_]*/g) || [];
      for (const match of varMatches) {
        if (!['sin', 'cos', 'tan', 'log', 'exp', 'sqrt', 'abs', 'pi', 'e'].includes(match)) {
          exprVars.add(match);
        }
      }

      // Check that all expression variables are defined
      const definedVars = new Set(Object.keys(vars));
      const missingVars = [...exprVars].filter(v => !definedVars.has(v));
      const extraVars = [...definedVars].filter(v => !exprVars.has(v));

      if (missingVars.length > 0) {
        return this.createError(
          'E-G4-MISSING-VARIABLES',
          'Expression contains undefined variables',
          { expr, missingVars, definedVars: [...definedVars] }
        );
      }

      return this.createSuccess({
        exprVars: [...exprVars],
        definedVars: [...definedVars],
        extraVars
      });

    } catch (error) {
      return this.createError(
        'E-G4-VARIABLE-ANALYSIS-ERROR',
        'Error analyzing expression variables',
        {
          expr,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  /**
   * Run multiple seeded trials with random variable values
   */
  private async runSeededTrials(
    equation: EquationSpec,
    config: NumericValidationConfig
  ): Promise<ValidationResult> {
    const results: TrialResult[] = [];

    for (let seed = 0; seed < config.seedCount; seed++) {
      const trial = await this.runSingleTrial(equation, config, seed);
      results.push(trial);
    }

    // Calculate pass rate
    const passedCount = results.filter(r => r.passed).length;
    const passRate = passedCount / config.seedCount;

    if (passRate < config.passRate) {
      return this.createError(
        'E-G4-SEEDED-FAILURE',
        `Mathematical validation failed: only ${passedCount}/${config.seedCount} trials passed (${(passRate * 100).toFixed(1)}%)`,
        {
          passRate,
          requiredRate: config.passRate,
          trials: results,
          equation: equation.tex
        }
      );
    }

    return this.createSuccess({
      trials: results,
      passRate,
      passedCount,
      totalTrials: config.seedCount
    });
  }

  /**
   * Run a single trial with seeded random variables
   */
  private async runSingleTrial(
    equation: EquationSpec,
    config: NumericValidationConfig,
    seed: number
  ): Promise<TrialResult> {
    try {
      // Generate seeded variable values
      const testVars = this.generateSeededVariables(
        equation.check.vars,
        config.variableRanges,
        seed
      );

      // Evaluate expression with test variables
      const actual = evaluate(equation.check.expr, testVars);
      const expected = equation.check.expect;

      // Check if result is a number
      if (typeof actual !== 'number' || !isFinite(actual)) {
        return {
          seed,
          variables: testVars,
          expected,
          passed: false,
          error: `Expression evaluated to non-finite number: ${actual}`
        };
      }

      // Check tolerance
      const withinTolerance = Math.abs(actual - expected) <= config.tolerance;

      return {
        seed,
        variables: testVars,
        actual,
        expected,
        passed: withinTolerance,
        error: withinTolerance ? undefined : `Expected ${expected}, got ${actual} (diff: ${Math.abs(actual - expected)})`
      };

    } catch (error) {
      const testVars = this.generateSeededVariables(
        equation.check.vars,
        config.variableRanges,
        seed
      );

      return {
        seed,
        variables: testVars,
        expected: equation.check.expect,
        passed: false,
        error: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Generate seeded variable values for testing
   */
  private generateSeededVariables(
    baseVars: Record<string, number>,
    ranges: Record<string, {min: number, max: number}>,
    seed: number
  ): Record<string, number> {
    const rng = new SeededRandom(seed);
    const testVars: Record<string, number> = {};

    for (const [name, baseValue] of Object.entries(baseVars)) {
      const range = ranges[name];

      if (range) {
        // Use specified range
        testVars[name] = rng.uniform(range.min, range.max);
      } else {
        // Use variation around base value (±20%)
        const variation = Math.abs(baseValue) * 0.2;
        const min = baseValue - variation;
        const max = baseValue + variation;
        testVars[name] = rng.uniform(min, max);
      }

      // Ensure no division by zero for denominators
      if (Math.abs(testVars[name]) < 1e-12) {
        testVars[name] = baseValue || 1.0;
      }
    }

    return testVars;
  }

  /**
   * Validate expression with automatic tolerance adjustment
   */
  async validateWithAdaptiveTolerance(
    equation: EquationSpec,
    config?: Partial<NumericValidationConfig>
  ): Promise<ValidationResult> {
    const baseConfig = { ...this.defaultConfig, ...config };

    // Try with original tolerance
    let result = await this.validate({ equation, config: baseConfig });

    if (result.valid) {
      return result;
    }

    // If failed, try with relaxed tolerance (for numerical precision issues)
    const relaxedConfig = {
      ...baseConfig,
      tolerance: baseConfig.tolerance * 100 // Increase tolerance by 100x
    };

    const relaxedResult = await this.validate({ equation, config: relaxedConfig });

    if (relaxedResult.valid) {
      // Add warning about tolerance adjustment
      return this.createSuccess({
        ...relaxedResult.data,
        warning: 'Validation passed with relaxed tolerance',
        originalTolerance: baseConfig.tolerance,
        adjustedTolerance: relaxedConfig.tolerance
      });
    }

    return result; // Return original result if even relaxed tolerance fails
  }

  /**
   * Batch validate multiple equations
   */
  async validateBatch(
    equations: Array<{ equation: EquationSpec; id?: string; config?: Partial<NumericValidationConfig> }>
  ): Promise<{
    allValid: boolean;
    results: Array<{ id?: string; valid: boolean; errors?: any[]; data?: any }>;
  }> {
    const results = [];
    let allValid = true;

    for (const item of equations) {
      const result = await this.validate(item);
      results.push({
        id: item.id,
        valid: result.valid,
        errors: result.errors,
        data: result.data
      });

      if (!result.valid) {
        allValid = false;
      }
    }

    return { allValid, results };
  }
}