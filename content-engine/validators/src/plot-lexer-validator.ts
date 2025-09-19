import { BaseValidationGate, ValidationResult } from './validation-gate.js';

/**
 * G5: Plot Expression Lexer Validation Gate
 * Validates mathematical expressions used in plot specifications
 */
export class PlotLexerValidationGate extends BaseValidationGate {
  readonly name = "Plot Expression Lexer Validator";
  readonly gateNumber = "G5";
  readonly description = "Validates mathematical expressions for plot rendering safety";

  private readonly allowedTokens = new Set([
    // Numbers and variables
    'NUMBER', 'VARIABLE',

    // Basic arithmetic
    '+', '-', '*', '/', '^',

    // Parentheses
    '(', ')',

    // Mathematical functions
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'log', 'ln', 'exp', 'sqrt', 'abs',
    'floor', 'ceil', 'round',

    // Mathematical constants
    'pi', 'e',

    // Comparison operators (for piecewise functions)
    '>', '<', '>=', '<=', '==', '!=',

    // Conditional operators
    'if', 'else',

    // Whitespace
    'WHITESPACE'
  ]);

  private readonly dangerousPatterns = [
    // Potential code injection
    /eval\s*\(/i,
    /function\s*\(/i,
    /=>\s*{/i,
    /new\s+/i,
    /import\s+/i,
    /require\s*\(/i,

    // File system access
    /fs\./i,
    /path\./i,
    /process\./i,

    // Network access
    /fetch\s*\(/i,
    /axios\./i,
    /http\./i,

    // Infinite loops
    /while\s*\(/i,
    /for\s*\(/i,

    // Object access that could be dangerous
    /\[\s*["']/,
    /\.\s*constructor/i,
    /\.\s*prototype/i
  ];

  /**
   * Validate plot expression for safety and correctness
   */
  async validate(input: {
    expr: string;
    context?: string;
    maxComplexity?: number;
  }): Promise<ValidationResult> {
    const { expr, context, maxComplexity = 100 } = input;

    if (!expr || typeof expr !== 'string') {
      return this.createError(
        'E-G5-INVALID-INPUT',
        'Plot expression must be a non-empty string',
        { expr, context }
      );
    }

    const cleanExpr = expr.trim();

    if (cleanExpr.length === 0) {
      return this.createError(
        'E-G5-EMPTY-EXPRESSION',
        'Plot expression cannot be empty',
        { expr, context }
      );
    }

    try {
      // Step 1: Check for dangerous patterns
      const dangerousResult = this.checkDangerousPatterns(cleanExpr);
      if (!dangerousResult.valid) {
        return dangerousResult;
      }

      // Step 2: Tokenize and validate tokens
      const tokens = this.tokenizeExpression(cleanExpr);
      const tokenResult = this.validateTokens(tokens);
      if (!tokenResult.valid) {
        return tokenResult;
      }

      // Step 3: Check expression complexity
      const complexityResult = this.validateComplexity(tokens, maxComplexity);
      if (!complexityResult.valid) {
        return complexityResult;
      }

      // Step 4: Validate mathematical syntax
      const syntaxResult = this.validateMathematicalSyntax(tokens);
      if (!syntaxResult.valid) {
        return syntaxResult;
      }

      // Step 5: Check for potential performance issues
      const performanceResult = this.validatePerformance(cleanExpr);
      if (!performanceResult.valid) {
        return performanceResult;
      }

      return this.createSuccess({
        expr: cleanExpr,
        tokens: tokens.length,
        complexity: this.calculateComplexity(tokens),
        context
      });

    } catch (error) {
      return this.createError(
        'E-G5-VALIDATION-ERROR',
        'Error during plot expression validation',
        {
          expr: cleanExpr,
          error: error instanceof Error ? error.message : String(error),
          context
        }
      );
    }
  }

  /**
   * Check for dangerous patterns that could indicate code injection
   */
  private checkDangerousPatterns(expr: string): ValidationResult {
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(expr)) {
        return this.createError(
          'E-G5-DANGEROUS-PATTERN',
          'Expression contains potentially dangerous pattern',
          { expr, pattern: pattern.source }
        );
      }
    }

    return this.createSuccess();
  }

  /**
   * Tokenize expression into recognizable components
   */
  private tokenizeExpression(expr: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < expr.length) {
      const char = expr[i];

      // Skip whitespace
      if (/\s/.test(char)) {
        i++;
        continue;
      }

      // Numbers (including decimals and scientific notation)
      if (/\d/.test(char) || (char === '.' && /\d/.test(expr[i + 1] || ''))) {
        const numberMatch = expr.slice(i).match(/^(\d+\.?\d*([eE][+-]?\d+)?)/);
        if (numberMatch) {
          tokens.push({ type: 'NUMBER', value: numberMatch[1], position: i });
          i += numberMatch[1].length;
          continue;
        }
      }

      // Variables and functions
      if (/[a-zA-Z_]/.test(char)) {
        const identifierMatch = expr.slice(i).match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (identifierMatch) {
          const identifier = identifierMatch[1];
          const type = this.allowedTokens.has(identifier) ? 'FUNCTION' : 'VARIABLE';
          tokens.push({ type, value: identifier, position: i });
          i += identifier.length;
          continue;
        }
      }

      // Operators and punctuation
      const twoCharOp = expr.slice(i, i + 2);
      if (['>=', '<=', '==', '!=', '**'].includes(twoCharOp)) {
        tokens.push({ type: 'OPERATOR', value: twoCharOp, position: i });
        i += 2;
        continue;
      }

      const singleChar = char;
      if (['+', '-', '*', '/', '^', '>', '<', '(', ')', ','].includes(singleChar)) {
        tokens.push({ type: 'OPERATOR', value: singleChar, position: i });
        i++;
        continue;
      }

      // Unknown character
      tokens.push({ type: 'UNKNOWN', value: char, position: i });
      i++;
    }

    return tokens;
  }

  /**
   * Validate that all tokens are allowed
   */
  private validateTokens(tokens: Token[]): ValidationResult {
    const invalidTokens: Token[] = [];

    for (const token of tokens) {
      if (token.type === 'UNKNOWN') {
        invalidTokens.push(token);
        continue;
      }

      if (token.type === 'FUNCTION' && !this.allowedTokens.has(token.value)) {
        invalidTokens.push(token);
        continue;
      }

      // Variable names should be reasonable
      if (token.type === 'VARIABLE') {
        if (token.value.length > 20) {
          invalidTokens.push(token);
        }
      }
    }

    if (invalidTokens.length > 0) {
      return this.createError(
        'E-G5-INVALID-TOKENS',
        'Expression contains invalid tokens',
        {
          invalidTokens: invalidTokens.map(t => ({
            value: t.value,
            position: t.position,
            type: t.type
          }))
        }
      );
    }

    return this.createSuccess();
  }

  /**
   * Validate expression complexity to prevent DoS
   */
  private validateComplexity(tokens: Token[], maxComplexity: number): ValidationResult {
    const complexity = this.calculateComplexity(tokens);

    if (complexity > maxComplexity) {
      return this.createError(
        'E-G5-COMPLEXITY-TOO-HIGH',
        `Expression complexity ${complexity} exceeds maximum ${maxComplexity}`,
        { complexity, maxComplexity, tokenCount: tokens.length }
      );
    }

    return this.createSuccess({ complexity });
  }

  /**
   * Calculate expression complexity score
   */
  private calculateComplexity(tokens: Token[]): number {
    let complexity = 0;

    for (const token of tokens) {
      switch (token.type) {
        case 'NUMBER':
        case 'VARIABLE':
          complexity += 1;
          break;
        case 'FUNCTION':
          complexity += 3; // Functions are more expensive
          break;
        case 'OPERATOR':
          complexity += 2;
          break;
      }
    }

    return complexity;
  }

  /**
   * Validate mathematical syntax (balanced parentheses, etc.)
   */
  private validateMathematicalSyntax(tokens: Token[]): ValidationResult {
    let parenDepth = 0;
    let lastToken: Token | null = null;

    for (const token of tokens) {
      // Check parentheses balance
      if (token.value === '(') {
        parenDepth++;
      } else if (token.value === ')') {
        parenDepth--;
        if (parenDepth < 0) {
          return this.createError(
            'E-G5-UNBALANCED-PARENS',
            'Unbalanced parentheses - too many closing parentheses',
            { position: token.position }
          );
        }
      }

      // Check for invalid operator sequences
      if (lastToken && this.isInvalidOperatorSequence(lastToken, token)) {
        return this.createError(
          'E-G5-INVALID-OPERATOR-SEQUENCE',
          'Invalid operator sequence',
          {
            sequence: `${lastToken.value} ${token.value}`,
            position: token.position
          }
        );
      }

      lastToken = token;
    }

    if (parenDepth !== 0) {
      return this.createError(
        'E-G5-UNBALANCED-PARENS',
        'Unbalanced parentheses - missing closing parentheses',
        { unclosedCount: parenDepth }
      );
    }

    return this.createSuccess();
  }

  /**
   * Check if two consecutive tokens form an invalid sequence
   */
  private isInvalidOperatorSequence(token1: Token, token2: Token): boolean {
    const operators = ['+', '-', '*', '/', '^'];

    // Two consecutive operators (except +/- which can be unary)
    if (operators.includes(token1.value) && operators.includes(token2.value)) {
      // Allow +/- as unary operators
      if ((token1.value === '+' || token1.value === '-') &&
          (token2.value === '+' || token2.value === '-')) {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Validate for potential performance issues
   */
  private validatePerformance(expr: string): ValidationResult {
    const warnings: string[] = [];

    // Check for deeply nested expressions
    const maxDepth = this.calculateNestingDepth(expr);
    if (maxDepth > 10) {
      warnings.push(`Deep nesting detected (depth: ${maxDepth})`);
    }

    // Check for potential infinite loops in piecewise functions
    if (expr.includes('if') && expr.split('if').length > 5) {
      warnings.push('Multiple conditional statements may impact performance');
    }

    // Check expression length
    if (expr.length > 500) {
      warnings.push('Very long expression may impact performance');
    }

    return this.createSuccess({ warnings });
  }

  /**
   * Calculate maximum nesting depth
   */
  private calculateNestingDepth(expr: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of expr) {
      if (char === '(') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === ')') {
        currentDepth--;
      }
    }

    return maxDepth;
  }

  /**
   * Validate multiple expressions
   */
  async validateBatch(expressions: Array<{
    expr: string;
    id?: string;
    context?: string;
    maxComplexity?: number;
  }>): Promise<{
    allValid: boolean;
    results: Array<{ id?: string; valid: boolean; errors?: any[]; data?: any }>;
  }> {
    const results = [];
    let allValid = true;

    for (const item of expressions) {
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

interface Token {
  type: 'NUMBER' | 'VARIABLE' | 'FUNCTION' | 'OPERATOR' | 'UNKNOWN';
  value: string;
  position: number;
}