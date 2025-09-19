import katex from 'katex';
import { BaseValidationGate, ValidationResult } from './validation-gate.js';

/**
 * G3: KaTeX Validation Gate
 * Validates LaTeX expressions for mathematical content
 */
export class KatexValidationGate extends BaseValidationGate {
  readonly name = "KaTeX LaTeX Validator";
  readonly gateNumber = "G3";
  readonly description = "Validates LaTeX mathematical expressions using KaTeX parser";

  private readonly katexOptions = {
    throwOnError: true,
    errorColor: '#cc0000',
    strict: 'warn',
    output: 'mathml',
    displayMode: false,
    macros: {
      // Common physics/chemistry macros
      "\\unit": "\\,\\text{#1}",
      "\\SI": "#1\\,\\text{#2}",
      "\\degree": "^\\circ",
      "\\celsius": "^\\circ\\text{C}",
      "\\fahrenheit": "^\\circ\\text{F}",
      "\\ohm": "\\Omega"
    }
  };

  /**
   * Validate a single LaTeX expression
   */
  async validate(input: { tex: string; context?: string }): Promise<ValidationResult> {
    const { tex, context } = input;

    if (!tex || typeof tex !== 'string') {
      return this.createError(
        'E-G3-INVALID-INPUT',
        'LaTeX expression must be a non-empty string',
        { tex, context }
      );
    }

    // Trim whitespace
    const cleanTex = tex.trim();

    if (cleanTex.length === 0) {
      return this.createError(
        'E-G3-EMPTY-EXPRESSION',
        'LaTeX expression cannot be empty',
        { tex, context }
      );
    }

    try {
      // Attempt to parse with KaTeX
      const rendered = katex.renderToString(cleanTex, this.katexOptions);

      // Additional validation checks
      const additionalChecks = this.performAdditionalChecks(cleanTex);
      if (!additionalChecks.valid) {
        return additionalChecks;
      }

      return this.createSuccess({
        tex: cleanTex,
        rendered,
        context,
        message: 'LaTeX expression parsed successfully'
      });

    } catch (error) {
      const katexError = error as Error;

      return this.createError(
        'E-G3-KATEX-PARSE',
        'LaTeX expression failed to parse',
        {
          tex: cleanTex,
          context,
          error: katexError.message,
          errorName: katexError.name,
          position: this.extractErrorPosition(katexError.message)
        }
      );
    }
  }

  /**
   * Perform additional validation checks beyond basic parsing
   */
  private performAdditionalChecks(tex: string): ValidationResult {
    const errors: string[] = [];

    // Check for balanced braces
    if (!this.hasBalancedBraces(tex)) {
      errors.push('Unbalanced braces in LaTeX expression');
    }

    // Check for dangerous commands (security)
    const dangerousCommands = [
      '\\write', '\\input', '\\include', '\\openin', '\\openout',
      '\\immediate', '\\expandafter', '\\csname', '\\endcsname',
      '\\catcode', '\\def', '\\gdef', '\\edef', '\\xdef'
    ];

    for (const cmd of dangerousCommands) {
      if (tex.includes(cmd)) {
        errors.push(`Dangerous LaTeX command detected: ${cmd}`);
      }
    }

    // Check for excessive nesting (prevent DoS)
    if (this.getMaxNestingDepth(tex) > 10) {
      errors.push('Excessive nesting depth in LaTeX expression');
    }

    // Check expression length (prevent DoS)
    if (tex.length > 5000) {
      errors.push('LaTeX expression too long (max 5000 characters)');
    }

    if (errors.length > 0) {
      return this.createError(
        'E-G3-ADDITIONAL-CHECKS',
        'LaTeX expression failed additional validation',
        { errors, tex }
      );
    }

    return this.createSuccess();
  }

  /**
   * Check if braces are balanced in LaTeX expression
   */
  private hasBalancedBraces(tex: string): boolean {
    let braceCount = 0;
    let inMathMode = false;

    for (let i = 0; i < tex.length; i++) {
      const char = tex[i];
      const prevChar = i > 0 ? tex[i - 1] : '';

      // Skip escaped characters
      if (prevChar === '\\') continue;

      if (char === '$') {
        inMathMode = !inMathMode;
      } else if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount < 0) return false;
      }
    }

    return braceCount === 0;
  }

  /**
   * Calculate maximum nesting depth
   */
  private getMaxNestingDepth(tex: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (let i = 0; i < tex.length; i++) {
      const char = tex[i];
      const prevChar = i > 0 ? tex[i - 1] : '';

      // Skip escaped characters
      if (prevChar === '\\') continue;

      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth--;
      }
    }

    return maxDepth;
  }

  /**
   * Extract error position from KaTeX error message
   */
  private extractErrorPosition(errorMessage: string): number | null {
    const positionMatch = errorMessage.match(/position (\d+)/);
    return positionMatch ? parseInt(positionMatch[1]) : null;
  }

  /**
   * Validate multiple LaTeX expressions
   */
  async validateBatch(expressions: Array<{ tex: string; id?: string; context?: string }>): Promise<{
    allValid: boolean;
    results: Array<{ id?: string; valid: boolean; errors?: any[]; data?: any }>;
  }> {
    const results = [];
    let allValid = true;

    for (const expr of expressions) {
      const result = await this.validate(expr);
      results.push({
        id: expr.id,
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
   * Validate equation with automatic repair suggestions
   */
  async validateWithRepairSuggestions(tex: string): Promise<ValidationResult & { repairSuggestions?: string[] }> {
    const result = await this.validate({ tex });

    if (!result.valid && result.errors) {
      const suggestions = this.generateRepairSuggestions(tex, result.errors[0]);
      return { ...result, repairSuggestions: suggestions };
    }

    return result;
  }

  /**
   * Generate repair suggestions for common LaTeX errors
   */
  private generateRepairSuggestions(tex: string, error: any): string[] {
    const suggestions: string[] = [];

    if (error.message?.includes('brace')) {
      suggestions.push('Check for missing or unmatched braces {}');
      suggestions.push('Ensure all \\left commands have matching \\right commands');
    }

    if (error.message?.includes('undefined')) {
      suggestions.push('Check for typos in command names');
      suggestions.push('Ensure all required packages are available');
    }

    if (!this.hasBalancedBraces(tex)) {
      const braceBalance = this.calculateBraceBalance(tex);
      if (braceBalance > 0) {
        suggestions.push(`Add ${braceBalance} closing brace(s) }`);
      } else {
        suggestions.push(`Remove ${Math.abs(braceBalance)} closing brace(s) }`);
      }
    }

    return suggestions;
  }

  /**
   * Calculate brace balance (positive = too many opening, negative = too many closing)
   */
  private calculateBraceBalance(tex: string): number {
    let balance = 0;

    for (let i = 0; i < tex.length; i++) {
      const char = tex[i];
      const prevChar = i > 0 ? tex[i - 1] : '';

      // Skip escaped characters
      if (prevChar === '\\') continue;

      if (char === '{') {
        balance++;
      } else if (char === '}') {
        balance--;
      }
    }

    return balance;
  }
}