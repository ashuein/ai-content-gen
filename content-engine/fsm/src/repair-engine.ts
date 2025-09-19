import type { ModuleError, ValidationResult } from '../../../content-engine/schemas-shared/types.js';

/**
 * Content Engine Repair System
 * Implements automated error recovery strategies per specification
 */
export class RepairEngine {
  private repairAttempts: Map<string, number> = new Map();
  private repairHistory: RepairRecord[] = [];

  /**
   * Attempt to repair validation errors
   */
  async attemptRepair(
    moduleName: string,
    errors: ModuleError[],
    correlationId: string
  ): Promise<RepairResult> {
    const repairKey = `${moduleName}-${correlationId}`;
    const currentAttempts = this.repairAttempts.get(repairKey) || 0;

    // Check if we've exceeded max attempts
    const maxAttempts = this.getMaxAttemptsForError(errors[0]);
    if (currentAttempts >= maxAttempts) {
      return {
        success: false,
        error: 'Maximum repair attempts exceeded',
        attemptsUsed: currentAttempts
      };
    }

    this.repairAttempts.set(repairKey, currentAttempts + 1);

    try {
      // Group errors by type for batch repair
      const errorGroups = this.groupErrorsByType(errors);
      const repairs: RepairAction[] = [];

      for (const [errorType, errorList] of errorGroups) {
        const repairActions = await this.getRepairStrategy(errorType, errorList);
        repairs.push(...repairActions);
      }

      if (repairs.length === 0) {
        return {
          success: false,
          error: 'No repair strategies available for error types',
          attemptsUsed: currentAttempts + 1
        };
      }

      // Apply repairs and generate repaired content
      const repairedContent = await this.applyRepairs(repairs);

      // Record repair for audit trail
      const repairRecord: RepairRecord = {
        timestamp: new Date().toISOString(),
        correlationId,
        moduleName,
        originalErrors: errors,
        repairActions: repairs,
        attempt: currentAttempts + 1,
        success: true
      };

      this.repairHistory.push(repairRecord);

      return {
        success: true,
        repairedContent,
        repairActions: repairs,
        attemptsUsed: currentAttempts + 1
      };

    } catch (error) {
      const repairRecord: RepairRecord = {
        timestamp: new Date().toISOString(),
        correlationId,
        moduleName,
        originalErrors: errors,
        repairActions: [],
        attempt: currentAttempts + 1,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown repair error'
      };

      this.repairHistory.push(repairRecord);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown repair error',
        attemptsUsed: currentAttempts + 1
      };
    }
  }

  /**
   * Get repair strategy for specific error type
   */
  private async getRepairStrategy(errorType: string, errors: ModuleError[]): Promise<RepairAction[]> {
    const strategies: RepairAction[] = [];

    switch (errorType) {
      case 'SCHEMA_VALIDATION':
        strategies.push(...await this.getSchemaRepairActions(errors));
        break;

      case 'KATEX_VALIDATION':
        strategies.push(...await this.getKaTeXRepairActions(errors));
        break;

      case 'MATH_EXPRESSION':
        strategies.push(...await this.getMathRepairActions(errors));
        break;

      case 'SMILES_VALIDATION':
        strategies.push(...await this.getSmilesRepairActions(errors));
        break;

      case 'PLOT_LEXER':
        strategies.push(...await this.getPlotLexerRepairActions(errors));
        break;

      case 'UNICODE_SANITIZATION':
        strategies.push(...await this.getUnicodeRepairActions(errors));
        break;

      case 'UNITS_VALIDATION':
        strategies.push(...await this.getUnitsRepairActions(errors));
        break;

      case 'CROSS_REFERENCE':
        strategies.push(...await this.getCrossRefRepairActions(errors));
        break;

      default:
        // Generic repair strategies
        strategies.push(...await this.getGenericRepairActions(errors));
        break;
    }

    return strategies;
  }

  /**
   * Schema validation repair strategies
   */
  private async getSchemaRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      if (error.context?.missingFields) {
        actions.push({
          type: 'add_missing_fields',
          description: 'Add missing required fields with default values',
          target: error.context.path || 'root',
          changes: {
            fields: error.context.missingFields.map((field: string) => ({
              name: field,
              value: this.getDefaultValueForField(field),
              action: 'add'
            }))
          }
        });
      }

      if (error.context?.invalidValues) {
        actions.push({
          type: 'fix_invalid_values',
          description: 'Correct invalid field values',
          target: error.context.path || 'root',
          changes: {
            corrections: error.context.invalidValues.map((invalid: any) => ({
              field: invalid.field,
              current: invalid.current,
              corrected: this.correctFieldValue(invalid.field, invalid.current),
              action: 'update'
            }))
          }
        });
      }
    }

    return actions;
  }

  /**
   * KaTeX expression repair strategies
   */
  private async getKaTeXRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      const texContent = error.context?.tex || '';

      // Fix missing closing braces
      if (error.message.includes('Missing closing brace') || error.message.includes('unclosed')) {
        const fixed = this.fixMissingBraces(texContent);
        actions.push({
          type: 'fix_missing_braces',
          description: 'Add missing closing braces in LaTeX expression',
          target: 'tex_expression',
          changes: {
            from: texContent,
            to: fixed,
            action: 'replace'
          }
        });
      }

      // Fix unbalanced delimiters
      if (error.message.includes('delimiter') || error.message.includes('unbalanced')) {
        const fixed = this.fixUnbalancedDelimiters(texContent);
        actions.push({
          type: 'fix_delimiters',
          description: 'Balance parentheses and delimiters',
          target: 'tex_expression',
          changes: {
            from: texContent,
            to: fixed,
            action: 'replace'
          }
        });
      }

      // Fix unknown commands
      if (error.message.includes('Unknown command') || error.message.includes('undefined')) {
        const fixed = this.fixUnknownCommands(texContent);
        actions.push({
          type: 'fix_unknown_commands',
          description: 'Replace unknown LaTeX commands with valid alternatives',
          target: 'tex_expression',
          changes: {
            from: texContent,
            to: fixed,
            action: 'replace'
          }
        });
      }
    }

    return actions;
  }

  /**
   * Mathematical expression repair strategies
   */
  private async getMathRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      const expression = error.context?.expression || '';

      // Fix unbalanced parentheses
      if (error.message.includes('parentheses') || error.message.includes('bracket')) {
        const fixed = this.balanceParentheses(expression);
        actions.push({
          type: 'balance_parentheses',
          description: 'Balance parentheses in mathematical expression',
          target: 'math_expression',
          changes: {
            from: expression,
            to: fixed,
            action: 'replace'
          }
        });
      }

      // Fix invalid operators
      if (error.message.includes('operator') || error.message.includes('syntax')) {
        const fixed = this.fixMathOperators(expression);
        actions.push({
          type: 'fix_operators',
          description: 'Correct mathematical operators',
          target: 'math_expression',
          changes: {
            from: expression,
            to: fixed,
            action: 'replace'
          }
        });
      }
    }

    return actions;
  }

  /**
   * SMILES string repair strategies
   */
  private async getSmilesRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      const smiles = error.context?.smiles || '';

      // Fix unclosed rings
      if (error.message.includes('unclosed ring') || error.message.includes('ring')) {
        const fixed = this.fixUnclosedRings(smiles);
        actions.push({
          type: 'fix_rings',
          description: 'Close unclosed ring structures in SMILES',
          target: 'smiles_string',
          changes: {
            from: smiles,
            to: fixed,
            action: 'replace'
          }
        });
      }

      // Fix invalid characters
      if (error.message.includes('invalid character') || error.message.includes('illegal')) {
        const fixed = this.removeInvalidSmilesChars(smiles);
        actions.push({
          type: 'remove_invalid_chars',
          description: 'Remove invalid characters from SMILES string',
          target: 'smiles_string',
          changes: {
            from: smiles,
            to: fixed,
            action: 'replace'
          }
        });
      }
    }

    return actions;
  }

  /**
   * Plot lexer repair strategies
   */
  private async getPlotLexerRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      const expression = error.context?.expr || '';

      // Fix dangerous patterns
      if (error.message.includes('dangerous') || error.message.includes('security')) {
        const fixed = this.sanitizePlotExpression(expression);
        actions.push({
          type: 'sanitize_expression',
          description: 'Remove dangerous patterns from plot expression',
          target: 'plot_expression',
          changes: {
            from: expression,
            to: fixed,
            action: 'replace'
          }
        });
      }
    }

    return actions;
  }

  /**
   * Unicode sanitization repair strategies
   */
  private async getUnicodeRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      const text = error.context?.text || '';

      // Fix security violations
      if (error.message.includes('security') || error.message.includes('dangerous')) {
        const fixed = this.sanitizeUnicodeText(text);
        actions.push({
          type: 'sanitize_unicode',
          description: 'Remove dangerous Unicode characters',
          target: 'text_content',
          changes: {
            from: text,
            to: fixed,
            action: 'replace'
          }
        });
      }
    }

    return actions;
  }

  /**
   * Units validation repair strategies
   */
  private async getUnitsRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      if (error.message.includes('dimensional') || error.message.includes('units')) {
        actions.push({
          type: 'fix_dimensional_analysis',
          description: 'Correct unit inconsistencies',
          target: 'equation_units',
          changes: {
            suggestion: 'Review equation for dimensional consistency',
            action: 'manual_review_required'
          }
        });
      }
    }

    return actions;
  }

  /**
   * Cross-reference repair strategies
   */
  private async getCrossRefRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    for (const error of errors) {
      if (error.message.includes('duplicate') || error.message.includes('collision')) {
        actions.push({
          type: 'fix_id_collision',
          description: 'Generate unique IDs for colliding references',
          target: 'cross_references',
          changes: {
            strategy: 'append_suffix',
            action: 'regenerate_ids'
          }
        });
      }
    }

    return actions;
  }

  /**
   * Generic repair strategies
   */
  private async getGenericRepairActions(errors: ModuleError[]): Promise<RepairAction[]> {
    return [{
      type: 'manual_review',
      description: 'Manual review required - no automatic repair available',
      target: 'content',
      changes: {
        action: 'manual_intervention_required',
        errors: errors.map(e => e.message)
      }
    }];
  }

  /**
   * Apply repair actions to generate repaired content
   */
  private async applyRepairs(repairs: RepairAction[]): Promise<any> {
    const repairedContent: any = {};

    for (const repair of repairs) {
      switch (repair.type) {
        case 'add_missing_fields':
          if (repair.changes.fields) {
            for (const field of repair.changes.fields) {
              repairedContent[field.name] = field.value;
            }
          }
          break;

        case 'fix_invalid_values':
          if (repair.changes.corrections) {
            for (const correction of repair.changes.corrections) {
              repairedContent[correction.field] = correction.corrected;
            }
          }
          break;

        case 'fix_missing_braces':
        case 'fix_delimiters':
        case 'fix_unknown_commands':
        case 'balance_parentheses':
        case 'fix_operators':
        case 'fix_rings':
        case 'remove_invalid_chars':
        case 'sanitize_expression':
        case 'sanitize_unicode':
          repairedContent[repair.target] = repair.changes.to;
          break;

        default:
          // Other repair types that don't directly modify content
          repairedContent._repairNotes = repairedContent._repairNotes || [];
          repairedContent._repairNotes.push(repair.description);
          break;
      }
    }

    return repairedContent;
  }

  /**
   * Helper methods for specific repair operations
   */
  private fixMissingBraces(tex: string): string {
    let fixed = tex;
    const openBraces = (tex.match(/\{/g) || []).length;
    const closeBraces = (tex.match(/\}/g) || []).length;

    if (openBraces > closeBraces) {
      fixed += '}'.repeat(openBraces - closeBraces);
    }

    return fixed;
  }

  private fixUnbalancedDelimiters(tex: string): string {
    let fixed = tex;

    // Fix parentheses
    const openParens = (tex.match(/\(/g) || []).length;
    const closeParens = (tex.match(/\)/g) || []).length;

    if (openParens > closeParens) {
      fixed += ')'.repeat(openParens - closeParens);
    }

    return fixed;
  }

  private fixUnknownCommands(tex: string): string {
    // Replace common unknown commands with valid alternatives
    const replacements = {
      '\\unknown': '\\text{unknown}',
      '\\undefined': '\\text{undefined}',
      '\\invalid': '\\text{invalid}'
    };

    let fixed = tex;
    for (const [unknown, replacement] of Object.entries(replacements)) {
      fixed = fixed.replace(new RegExp(unknown.replace('\\', '\\\\'), 'g'), replacement);
    }

    return fixed;
  }

  private balanceParentheses(expr: string): string {
    let fixed = expr;
    const openParens = (expr.match(/\(/g) || []).length;
    const closeParens = (expr.match(/\)/g) || []).length;

    if (openParens > closeParens) {
      fixed += ')'.repeat(openParens - closeParens);
    }

    return fixed;
  }

  private fixMathOperators(expr: string): string {
    return expr
      .replace(/\+\+/g, '+')
      .replace(/--/g, '-')
      .replace(/\*\*/g, '^')
      .replace(/([0-9])([a-zA-Z])/g, '$1*$2'); // Add multiplication signs
  }

  private fixUnclosedRings(smiles: string): string {
    // This is a simplified fix - in practice, would need more sophisticated SMILES parsing
    return smiles.replace(/[0-9](?![0-9])/g, ''); // Remove unclosed ring numbers
  }

  private removeInvalidSmilesChars(smiles: string): string {
    // Keep only valid SMILES characters
    return smiles.replace(/[^A-Za-z0-9@+\-\[\]()=#\/\\%:.]/g, '');
  }

  private sanitizePlotExpression(expr: string): string {
    // Remove dangerous patterns
    return expr
      .replace(/eval\s*\(/gi, 'Math.abs(')
      .replace(/function\s*\(/gi, 'Math.abs(')
      .replace(/import\s+/gi, '')
      .replace(/require\s*\(/gi, 'Math.abs(');
  }

  private sanitizeUnicodeText(text: string): string {
    // Normalize and remove dangerous Unicode
    return text
      .normalize('NFC')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
  }

  /**
   * Utility methods
   */
  private groupErrorsByType(errors: ModuleError[]): Map<string, ModuleError[]> {
    const groups = new Map<string, ModuleError[]>();

    for (const error of errors) {
      const type = this.getErrorType(error);
      if (!groups.has(type)) {
        groups.set(type, []);
      }
      groups.get(type)!.push(error);
    }

    return groups;
  }

  private getErrorType(error: ModuleError): string {
    if (error.code.includes('SCHEMA')) return 'SCHEMA_VALIDATION';
    if (error.code.includes('KATEX')) return 'KATEX_VALIDATION';
    if (error.code.includes('MATH')) return 'MATH_EXPRESSION';
    if (error.code.includes('SMILES')) return 'SMILES_VALIDATION';
    if (error.code.includes('PLOT')) return 'PLOT_LEXER';
    if (error.code.includes('UNICODE')) return 'UNICODE_SANITIZATION';
    if (error.code.includes('UNITS')) return 'UNITS_VALIDATION';
    if (error.code.includes('REFERENCE')) return 'CROSS_REFERENCE';

    return 'UNKNOWN';
  }

  private getMaxAttemptsForError(error: ModuleError): number {
    const type = this.getErrorType(error);

    const maxAttempts = {
      'SCHEMA_VALIDATION': 2,
      'KATEX_VALIDATION': 3,
      'MATH_EXPRESSION': 3,
      'SMILES_VALIDATION': 2,
      'PLOT_LEXER': 2,
      'UNICODE_SANITIZATION': 1,
      'UNITS_VALIDATION': 1,
      'CROSS_REFERENCE': 2,
      'UNKNOWN': 1
    };

    return maxAttempts[type] || 1;
  }

  private getDefaultValueForField(field: string): any {
    const defaults: Record<string, any> = {
      'title': 'Untitled',
      'description': '',
      'version': '1.0.0',
      'id': `generated-${Date.now()}`,
      'type': 'unknown',
      'status': 'draft'
    };

    return defaults[field] || null;
  }

  private correctFieldValue(field: string, currentValue: any): any {
    // Basic field correction logic
    if (field === 'version' && typeof currentValue !== 'string') {
      return '1.0.0';
    }

    if (field === 'id' && (!currentValue || typeof currentValue !== 'string')) {
      return `corrected-${Date.now()}`;
    }

    return currentValue;
  }

  /**
   * Get repair history and statistics
   */
  getRepairHistory(): RepairRecord[] {
    return [...this.repairHistory];
  }

  getRepairStatistics(): RepairStatistics {
    const total = this.repairHistory.length;
    const successful = this.repairHistory.filter(r => r.success).length;

    const errorTypes = new Map<string, number>();
    this.repairHistory.forEach(record => {
      record.originalErrors.forEach(error => {
        const type = this.getErrorType(error);
        errorTypes.set(type, (errorTypes.get(type) || 0) + 1);
      });
    });

    return {
      totalRepairs: total,
      successfulRepairs: successful,
      successRate: total > 0 ? successful / total : 0,
      errorTypeBreakdown: Object.fromEntries(errorTypes),
      averageAttemptsPerRepair: total > 0
        ? this.repairHistory.reduce((sum, r) => sum + r.attempt, 0) / total
        : 0
    };
  }

  /**
   * Clear repair history (for testing or maintenance)
   */
  clearHistory(): void {
    this.repairHistory = [];
    this.repairAttempts.clear();
  }
}

// Type definitions
export interface RepairResult {
  success: boolean;
  repairedContent?: any;
  repairActions?: RepairAction[];
  error?: string;
  attemptsUsed: number;
}

export interface RepairAction {
  type: string;
  description: string;
  target: string;
  changes: any;
}

export interface RepairRecord {
  timestamp: string;
  correlationId: string;
  moduleName: string;
  originalErrors: ModuleError[];
  repairActions: RepairAction[];
  attempt: number;
  success: boolean;
  error?: string;
}

export interface RepairStatistics {
  totalRepairs: number;
  successfulRepairs: number;
  successRate: number;
  errorTypeBreakdown: Record<string, number>;
  averageAttemptsPerRepair: number;
}