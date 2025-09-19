import { BaseValidationGate, ValidationResult } from './validation-gate.js';

interface UnitDimensions {
  length: number;    // L
  mass: number;      // M
  time: number;      // T
  current: number;   // I
  temperature: number; // Θ
  amount: number;    // N
  luminosity: number; // J
}

interface EquationSpec {
  tex: string;
  check: {
    vars: Record<string, number>;
    expr: string;
    expect: number;
    tol: number;
  };
}

/**
 * G11: Dimensional Analysis Validation Gate
 * Validates physical unit consistency in mathematical equations
 */
export class UnitsValidationGate extends BaseValidationGate {
  readonly name = "Dimensional Analysis Validator";
  readonly gateNumber = "G11";
  readonly description = "Validates dimensional consistency of physical equations";

  private static readonly baseUnits: Record<string, UnitDimensions> = {
    // SI Base Units
    'm': { length: 1, mass: 0, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    'kg': { length: 0, mass: 1, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    's': { length: 0, mass: 0, time: 1, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    'A': { length: 0, mass: 0, time: 0, current: 1, temperature: 0, amount: 0, luminosity: 0 },
    'K': { length: 0, mass: 0, time: 0, current: 0, temperature: 1, amount: 0, luminosity: 0 },
    'mol': { length: 0, mass: 0, time: 0, current: 0, temperature: 0, amount: 1, luminosity: 0 },
    'cd': { length: 0, mass: 0, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 1 },

    // Common Derived Units
    'N': { length: 1, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Force: kg⋅m⋅s⁻²
    'J': { length: 2, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Energy: kg⋅m²⋅s⁻²
    'W': { length: 2, mass: 1, time: -3, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Power: kg⋅m²⋅s⁻³
    'Pa': { length: -1, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Pressure: kg⋅m⁻¹⋅s⁻²
    'V': { length: 2, mass: 1, time: -3, current: -1, temperature: 0, amount: 0, luminosity: 0 }, // Voltage: kg⋅m²⋅s⁻³⋅A⁻¹
    'C': { length: 0, mass: 0, time: 1, current: 1, temperature: 0, amount: 0, luminosity: 0 }, // Charge: s⋅A
    'Hz': { length: 0, mass: 0, time: -1, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Frequency: s⁻¹

    // Common Physics Units
    'eV': { length: 2, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Electron volt (energy)
    'cal': { length: 2, mass: 1, time: -2, current: 0, temperature: 0, amount: 0, luminosity: 0 }, // Calorie (energy)

    // Dimensionless
    '1': { length: 0, mass: 0, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 0 },
    '': { length: 0, mass: 0, time: 0, current: 0, temperature: 0, amount: 0, luminosity: 0 } // dimensionless
  };

  /**
   * Validate dimensional consistency of an equation
   */
  async validate(input: {
    equation: EquationSpec;
    unitMap: Record<string, string>;
    context?: string;
  }): Promise<ValidationResult> {
    const { equation, unitMap, context } = input;

    try {
      // Step 1: Parse equation to extract left and right sides
      const equationParts = this.parseEquation(equation.tex);
      if (!equationParts.valid) {
        return equationParts;
      }

      // Step 2: Parse variable dimensions from unit map
      const variableDimensions = this.parseVariableDimensions(unitMap);
      if (!variableDimensions.valid) {
        return variableDimensions;
      }

      // Step 3: Analyze dimensions of both sides
      const leftAnalysis = this.analyzeDimensions(
        equationParts.data.left,
        variableDimensions.data
      );
      if (!leftAnalysis.valid) {
        return leftAnalysis;
      }

      const rightAnalysis = this.analyzeDimensions(
        equationParts.data.right,
        variableDimensions.data
      );
      if (!rightAnalysis.valid) {
        return rightAnalysis;
      }

      // Step 4: Check dimensional consistency
      const consistencyCheck = this.checkDimensionalConsistency(
        leftAnalysis.data,
        rightAnalysis.data
      );

      if (!consistencyCheck.valid) {
        return this.createError(
          'E-G11-DIMENSIONAL-MISMATCH',
          'Equation sides have incompatible dimensions',
          {
            equation: equation.tex,
            leftDimensions: leftAnalysis.data,
            rightDimensions: rightAnalysis.data,
            context,
            unitMap
          }
        );
      }

      return this.createSuccess({
        equation: equation.tex,
        dimensions: leftAnalysis.data,
        leftSide: equationParts.data.left,
        rightSide: equationParts.data.right,
        unitMap,
        context
      });

    } catch (error) {
      return this.createError(
        'E-G11-ANALYSIS-ERROR',
        'Error during dimensional analysis',
        {
          equation: equation.tex,
          error: error instanceof Error ? error.message : String(error),
          context
        }
      );
    }
  }

  /**
   * Parse equation into left and right sides
   */
  private parseEquation(tex: string): ValidationResult & { data?: { left: string; right: string } } {
    // Remove LaTeX formatting for analysis
    const cleaned = tex
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // Remove LaTeX commands with braces
      .replace(/\\[a-zA-Z]+/g, '') // Remove LaTeX commands
      .replace(/[{}]/g, '') // Remove remaining braces
      .trim();

    // Find the equals sign
    const equalsMatch = cleaned.match(/^([^=]+)=([^=]+)$/);
    if (!equalsMatch) {
      return this.createError(
        'E-G11-EQUATION-PARSE',
        'Could not parse equation - expected format: left = right',
        { tex, cleaned }
      );
    }

    const [, left, right] = equalsMatch;

    return {
      valid: true,
      data: {
        left: left.trim(),
        right: right.trim()
      }
    };
  }

  /**
   * Parse variable dimensions from unit map
   */
  private parseVariableDimensions(unitMap: Record<string, string>): ValidationResult & {
    data?: Record<string, UnitDimensions>
  } {
    const variableDimensions: Record<string, UnitDimensions> = {};
    const errors: string[] = [];

    for (const [variable, unitString] of Object.entries(unitMap)) {
      const dimensionsResult = this.parseUnitString(unitString);
      if (!dimensionsResult.valid) {
        errors.push(`Invalid unit for variable ${variable}: ${unitString}`);
        continue;
      }

      variableDimensions[variable] = dimensionsResult.data;
    }

    if (errors.length > 0) {
      return this.createError(
        'E-G11-UNIT-PARSE',
        'Failed to parse some units',
        { errors, unitMap }
      );
    }

    return {
      valid: true,
      data: variableDimensions
    };
  }

  /**
   * Parse a unit string into dimensions
   */
  private parseUnitString(unitString: string): ValidationResult & { data?: UnitDimensions } {
    const cleaned = unitString.trim();

    if (!cleaned || cleaned === '1' || cleaned === 'dimensionless') {
      return {
        valid: true,
        data: UnitsValidationGate.baseUnits['1']
      };
    }

    // Handle simple units first
    if (UnitsValidationGate.baseUnits[cleaned]) {
      return {
        valid: true,
        data: UnitsValidationGate.baseUnits[cleaned]
      };
    }

    // Parse compound units (simplified parser)
    try {
      const dimensions = this.parseCompoundUnit(cleaned);
      return {
        valid: true,
        data: dimensions
      };
    } catch (error) {
      return this.createError(
        'E-G11-COMPOUND-UNIT-PARSE',
        `Failed to parse compound unit: ${unitString}`,
        { unitString, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Parse compound units (simplified implementation)
   */
  private parseCompoundUnit(unitString: string): UnitDimensions {
    // This is a simplified parser - production would need a full unit grammar
    let result: UnitDimensions = {
      length: 0, mass: 0, time: 0, current: 0,
      temperature: 0, amount: 0, luminosity: 0
    };

    // Handle simple patterns like "m/s", "kg⋅m/s²", etc.
    const parts = unitString.split(/[⋅·*]/); // Split by multiplication symbols

    for (const part of parts) {
      const [numerator, denominator] = part.split('/');

      // Process numerator
      if (numerator) {
        const numResult = this.parseUnitWithExponent(numerator.trim());
        result = this.addDimensions(result, numResult);
      }

      // Process denominator (with negative exponents)
      if (denominator) {
        const denResult = this.parseUnitWithExponent(denominator.trim());
        const negativeResult = this.negateDimensions(denResult);
        result = this.addDimensions(result, negativeResult);
      }
    }

    return result;
  }

  /**
   * Parse unit with exponent (e.g., "m²", "s⁻¹")
   */
  private parseUnitWithExponent(unitPart: string): UnitDimensions {
    // Extract exponent
    const exponentMatch = unitPart.match(/^([a-zA-Z]+)([⁻⁰¹²³⁴⁵⁶⁷⁸⁹\-0-9]*)$/);
    if (!exponentMatch) {
      throw new Error(`Invalid unit format: ${unitPart}`);
    }

    const [, baseUnit, exponentStr] = exponentMatch;
    const baseDimensions = UnitsValidationGate.baseUnits[baseUnit];

    if (!baseDimensions) {
      throw new Error(`Unknown base unit: ${baseUnit}`);
    }

    // Parse exponent
    let exponent = 1;
    if (exponentStr) {
      // Convert superscript to regular numbers
      const normalizedExp = exponentStr
        .replace(/⁻/g, '-')
        .replace(/⁰/g, '0')
        .replace(/¹/g, '1')
        .replace(/²/g, '2')
        .replace(/³/g, '3')
        .replace(/⁴/g, '4')
        .replace(/⁵/g, '5')
        .replace(/⁶/g, '6')
        .replace(/⁷/g, '7')
        .replace(/⁸/g, '8')
        .replace(/⁹/g, '9');

      exponent = parseInt(normalizedExp) || 1;
    }

    // Apply exponent to all dimensions
    return {
      length: baseDimensions.length * exponent,
      mass: baseDimensions.mass * exponent,
      time: baseDimensions.time * exponent,
      current: baseDimensions.current * exponent,
      temperature: baseDimensions.temperature * exponent,
      amount: baseDimensions.amount * exponent,
      luminosity: baseDimensions.luminosity * exponent
    };
  }

  /**
   * Add two dimension objects
   */
  private addDimensions(a: UnitDimensions, b: UnitDimensions): UnitDimensions {
    return {
      length: a.length + b.length,
      mass: a.mass + b.mass,
      time: a.time + b.time,
      current: a.current + b.current,
      temperature: a.temperature + b.temperature,
      amount: a.amount + b.amount,
      luminosity: a.luminosity + b.luminosity
    };
  }

  /**
   * Negate all dimensions
   */
  private negateDimensions(dimensions: UnitDimensions): UnitDimensions {
    return {
      length: -dimensions.length,
      mass: -dimensions.mass,
      time: -dimensions.time,
      current: -dimensions.current,
      temperature: -dimensions.temperature,
      amount: -dimensions.amount,
      luminosity: -dimensions.luminosity
    };
  }

  /**
   * Analyze dimensions of an expression side
   */
  private analyzeDimensions(
    expression: string,
    variableDimensions: Record<string, UnitDimensions>
  ): ValidationResult & { data?: UnitDimensions } {
    try {
      // Simple dimensional analysis (in production, use proper expression parsing)
      const variables = this.extractVariables(expression);

      if (variables.length === 0) {
        // No variables, assume dimensionless
        return {
          valid: true,
          data: UnitsValidationGate.baseUnits['1']
        };
      }

      // For now, assume simple linear combination (first variable determines dimensions)
      const firstVar = variables[0];
      if (!variableDimensions[firstVar]) {
        return this.createError(
          'E-G11-VARIABLE-DIMENSION-MISSING',
          `No dimensions specified for variable: ${firstVar}`,
          { expression, variable: firstVar, availableVariables: Object.keys(variableDimensions) }
        );
      }

      return {
        valid: true,
        data: variableDimensions[firstVar]
      };

    } catch (error) {
      return this.createError(
        'E-G11-DIMENSION-ANALYSIS',
        'Error analyzing expression dimensions',
        {
          expression,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  /**
   * Extract variable names from expression
   */
  private extractVariables(expression: string): string[] {
    const variables: string[] = [];
    const matches = expression.match(/[a-zA-Z][a-zA-Z0-9_]*/g) || [];

    for (const match of matches) {
      // Filter out mathematical functions
      if (!['sin', 'cos', 'tan', 'log', 'exp', 'sqrt', 'abs', 'pi', 'e'].includes(match)) {
        if (!variables.includes(match)) {
          variables.push(match);
        }
      }
    }

    return variables;
  }

  /**
   * Check if two dimension objects are equal
   */
  private checkDimensionalConsistency(
    leftDimensions: UnitDimensions,
    rightDimensions: UnitDimensions
  ): ValidationResult {
    const tolerance = 1e-10;

    const dimensionsMatch =
      Math.abs(leftDimensions.length - rightDimensions.length) < tolerance &&
      Math.abs(leftDimensions.mass - rightDimensions.mass) < tolerance &&
      Math.abs(leftDimensions.time - rightDimensions.time) < tolerance &&
      Math.abs(leftDimensions.current - rightDimensions.current) < tolerance &&
      Math.abs(leftDimensions.temperature - rightDimensions.temperature) < tolerance &&
      Math.abs(leftDimensions.amount - rightDimensions.amount) < tolerance &&
      Math.abs(leftDimensions.luminosity - rightDimensions.luminosity) < tolerance;

    return {
      valid: dimensionsMatch,
      data: { dimensionsMatch, leftDimensions, rightDimensions }
    };
  }

  /**
   * Validate multiple equations with unit maps
   */
  async validateBatch(
    equations: Array<{
      equation: EquationSpec;
      unitMap: Record<string, string>;
      id?: string;
      context?: string;
    }>
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

  /**
   * Format dimensions for human-readable output
   */
  static formatDimensions(dimensions: UnitDimensions): string {
    const parts: string[] = [];

    if (dimensions.length !== 0) parts.push(`L${dimensions.length !== 1 ? `^${dimensions.length}` : ''}`);
    if (dimensions.mass !== 0) parts.push(`M${dimensions.mass !== 1 ? `^${dimensions.mass}` : ''}`);
    if (dimensions.time !== 0) parts.push(`T${dimensions.time !== 1 ? `^${dimensions.time}` : ''}`);
    if (dimensions.current !== 0) parts.push(`I${dimensions.current !== 1 ? `^${dimensions.current}` : ''}`);
    if (dimensions.temperature !== 0) parts.push(`Θ${dimensions.temperature !== 1 ? `^${dimensions.temperature}` : ''}`);
    if (dimensions.amount !== 0) parts.push(`N${dimensions.amount !== 1 ? `^${dimensions.amount}` : ''}`);
    if (dimensions.luminosity !== 0) parts.push(`J${dimensions.luminosity !== 1 ? `^${dimensions.luminosity}` : ''}`);

    return parts.length > 0 ? parts.join('⋅') : '1';
  }
}