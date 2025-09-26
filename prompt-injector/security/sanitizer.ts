/**
 * Security and Input Sanitization Layer
 *
 * Comprehensive input validation and sanitization for the Prompt Injector.
 * Protects against injection attacks, encoding issues, and malicious content.
 *
 * Security Features:
 * - Unicode normalization and validation
 * - Bidirectional text attack prevention
 * - Mixed script detection
 * - Template injection protection
 * - Path traversal prevention
 * - Content length validation
 * - Character encoding validation
 */

import { createHash } from 'crypto';
import { InjectorInput, PromptEnvelopeV1 } from '../contracts/prompt-envelope.v1.js';

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: any;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Security configuration
 */
export interface SecurityConfig {
  enable_unicode_normalization: boolean;
  reject_bidi_characters: boolean;
  max_mixed_scripts: number;
  allow_template_variables: boolean;
  max_content_length: number;
  enable_path_validation: boolean;
  log_security_events: boolean;
}

/**
 * Default security configuration (production-safe)
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enable_unicode_normalization: true,
  reject_bidi_characters: true,
  max_mixed_scripts: 2,
  allow_template_variables: true,
  max_content_length: 100000,
  enable_path_validation: true,
  log_security_events: true
};

/**
 * Dangerous Unicode ranges that could be used for attacks
 */
const DANGEROUS_UNICODE_RANGES = [
  // Bidirectional override characters
  [0x202A, 0x202E], // LRE, RLE, PDF, LRO, RLO
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI

  // Format characters that could hide content
  [0x200B, 0x200F], // Zero-width spaces and marks
  [0x2028, 0x2029], // Line and paragraph separators
  [0xFEFF, 0xFEFF], // Byte order mark

  // Control characters
  [0x0000, 0x001F], // C0 controls (excluding tab, LF, CR)
  [0x007F, 0x009F], // DEL and C1 controls
];

/**
 * Script detection patterns for mixed script validation
 */
const SCRIPT_PATTERNS = {
  latin: /[\u0000-\u007F\u0080-\u00FF\u0100-\u017F\u0180-\u024F]/,
  cyrillic: /[\u0400-\u04FF\u0500-\u052F]/,
  arabic: /[\u0600-\u06FF\u0750-\u077F]/,
  chinese: /[\u4E00-\u9FFF]/,
  japanese: /[\u3040-\u309F\u30A0-\u30FF]/,
  korean: /[\uAC00-\uD7AF]/,
  devanagari: /[\u0900-\u097F]/,
  mathematical: /[\u2200-\u22FF\u27C0-\u27EF\u2980-\u29FF]/
};

/**
 * Template variable patterns that are allowed
 */
const SAFE_TEMPLATE_PATTERNS = [
  /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/g,  // {{variable_name}}
  /\$\{[a-zA-Z_][a-zA-Z0-9_]*\}/g,          // ${variable_name}
];

/**
 * Dangerous template patterns that could lead to injection
 */
const DANGEROUS_TEMPLATE_PATTERNS = [
  /\{\{\s*[^}]*[\(\)\[\]<>'"`;\\|&$]*[^}]*\}\}/g,  // Suspicious characters in templates
  /\$\{[^}]*[\(\)\[\]<>'"`;\\|&]*[^}]*\}/g,        // Suspicious characters in ${} syntax
  /<%.*?%>/g,                                       // Server-side template syntax
  /<\?.*?\?>/g,                                     // PHP-style tags
  /\{\%.*?\%\}/g,                                   // Jinja/Django template syntax
];

/**
 * Main sanitizer class
 */
export class SecuritySanitizer {
  private config: SecurityConfig;
  private logger?: (level: string, message: string, data?: any) => void;

  constructor(config: Partial<SecurityConfig> = {}, logger?: (level: string, message: string, data?: any) => void) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Main validation entry point for InjectorInput
   */
  validateInjectorInput(input: InjectorInput): SecurityValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let risk_level: 'low' | 'medium' | 'high' | 'critical' = 'low';

    try {
      // Validate each field
      const gradeResult = this.validateTextField(input.grade, 'grade', 50);
      const subjectResult = this.validateEnumField(input.subject, ['Physics', 'Chemistry', 'Mathematics'], 'subject');
      const chapterResult = this.validateTextField(input.chapter, 'chapter', 200);
      const standardResult = this.validateTextField(input.standard, 'standard', 100);
      const difficultyResult = this.validateEnumField(input.difficulty, ['comfort', 'hustle', 'advanced'], 'difficulty');

      let pagesHintResult: SecurityValidationResult | null = null;
      if (input.pages_hint) {
        pagesHintResult = this.validateTextField(input.pages_hint, 'pages_hint', 500);
      }

      let pdfPathResult: SecurityValidationResult | null = null;
      if (input.chapter_pdf_path) {
        pdfPathResult = this.validateFilePath(input.chapter_pdf_path);
      }

      // Aggregate results
      const results = [gradeResult, subjectResult, chapterResult, standardResult, difficultyResult]
        .concat(pagesHintResult ? [pagesHintResult] : [])
        .concat(pdfPathResult ? [pdfPathResult] : []);

      for (const result of results) {
        errors.push(...result.errors);
        warnings.push(...result.warnings);
        if (this.getRiskLevel(result.risk_level) > this.getRiskLevel(risk_level)) {
          risk_level = result.risk_level;
        }
      }

      // Additional cross-field validation
      const crossValidation = this.validateCrossFields(input);
      errors.push(...crossValidation.errors);
      warnings.push(...crossValidation.warnings);

      const valid = errors.length === 0;

      if (this.config.log_security_events && (errors.length > 0 || risk_level !== 'low')) {
        this.logger?.('warn', 'Security validation issues detected', {
          errors,
          warnings,
          risk_level,
          input_summary: {
            grade: input.grade?.substring(0, 20),
            subject: input.subject,
            chapter: input.chapter?.substring(0, 30)
          }
        });
      }

      return {
        valid,
        errors,
        warnings,
        risk_level,
        sanitized: valid ? this.sanitizeInjectorInput(input) : undefined
      };

    } catch (error) {
      this.logger?.('error', 'Security validation error', { error: error instanceof Error ? error.message : String(error) });
      return {
        valid: false,
        errors: ['Internal validation error'],
        warnings: [],
        risk_level: 'critical'
      };
    }
  }

  /**
   * Validate PromptEnvelope for security issues
   */
  validatePromptEnvelope(envelope: PromptEnvelopeV1): SecurityValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let risk_level: 'low' | 'medium' | 'high' | 'critical' = 'low';

    // Validate correlation ID format
    if (!envelope.envelope.correlationId.match(/^ch-[a-z0-9]+-[a-z0-9]+$/)) {
      errors.push('Invalid correlation ID format');
      risk_level = 'high';
    }

    // Validate message content
    for (const message of envelope.messages) {
      const contentResult = this.validateMessageContent(message.content);
      errors.push(...contentResult.errors);
      warnings.push(...contentResult.warnings);
      if (this.getRiskLevel(contentResult.risk_level) > this.getRiskLevel(risk_level)) {
        risk_level = contentResult.risk_level;
      }
    }

    // Validate template fields
    if (!envelope.template.template_hash.match(/^[a-f0-9]{64}$/)) {
      errors.push('Invalid template hash format');
      risk_level = 'medium';
    }

    if (!envelope.template.vars_hash.match(/^[a-f0-9]{64}$/)) {
      errors.push('Invalid vars hash format');
      risk_level = 'medium';
    }

    // Validate attachment checksums
    for (const attachment of envelope.attachments) {
      if (!attachment.checksum.match(/^[a-f0-9]{64}$/)) {
        errors.push('Invalid attachment checksum format');
        risk_level = 'medium';
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      risk_level
    };
  }

  /**
   * Validate a text field for security issues
   */
  private validateTextField(text: string, fieldName: string, maxLength: number): SecurityValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let risk_level: 'low' | 'medium' | 'high' | 'critical' = 'low';

    // Length validation
    if (text.length > maxLength) {
      errors.push(`${fieldName} exceeds maximum length of ${maxLength} characters`);
      risk_level = 'medium';
    }

    // Unicode normalization
    if (this.config.enable_unicode_normalization) {
      const normalized = text.normalize('NFC');
      if (normalized !== text) {
        warnings.push(`${fieldName} was normalized for Unicode compatibility`);
      }
    }

    // Dangerous Unicode detection
    const dangerousChars = this.detectDangerousUnicode(text);
    if (dangerousChars.length > 0) {
      errors.push(`${fieldName} contains dangerous Unicode characters: ${dangerousChars.join(', ')}`);
      risk_level = 'high';
    }

    // Bidirectional text detection
    if (this.config.reject_bidi_characters && this.containsBidiCharacters(text)) {
      errors.push(`${fieldName} contains bidirectional text override characters`);
      risk_level = 'high';
    }

    // Mixed script detection
    const scripts = this.detectScripts(text);
    if (scripts.length > this.config.max_mixed_scripts) {
      warnings.push(`${fieldName} contains ${scripts.length} different scripts: ${scripts.join(', ')}`);
      if (scripts.length > 3) {
        risk_level = 'medium';
      }
    }

    // Template injection detection
    if (!this.config.allow_template_variables) {
      const templateVars = this.detectTemplateVariables(text);
      if (templateVars.length > 0) {
        errors.push(`${fieldName} contains template variables which are not allowed: ${templateVars.join(', ')}`);
        risk_level = 'medium';
      }
    } else {
      const dangerousTemplates = this.detectDangerousTemplates(text);
      if (dangerousTemplates.length > 0) {
        errors.push(`${fieldName} contains potentially dangerous template syntax: ${dangerousTemplates.join(', ')}`);
        risk_level = 'high';
      }
    }

    return { valid: errors.length === 0, errors, warnings, risk_level };
  }

  /**
   * Validate enum field
   */
  private validateEnumField(value: string, allowedValues: string[], fieldName: string): SecurityValidationResult {
    if (!allowedValues.includes(value)) {
      return {
        valid: false,
        errors: [`${fieldName} must be one of: ${allowedValues.join(', ')}`],
        warnings: [],
        risk_level: 'medium'
      };
    }
    return { valid: true, errors: [], warnings: [], risk_level: 'low' };
  }

  /**
   * Validate file path for security issues
   */
  private validateFilePath(filePath: string): SecurityValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let risk_level: 'low' | 'medium' | 'high' | 'critical' = 'low';

    if (!this.config.enable_path_validation) {
      return { valid: true, errors: [], warnings: [], risk_level: 'low' };
    }

    // Path traversal detection
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.includes('../') || normalizedPath.includes('./') || normalizedPath.includes('..\\')) {
      errors.push('File path contains directory traversal patterns');
      risk_level = 'high';
    }

    // Absolute path validation (should be relative or explicitly allowed)
    if (normalizedPath.startsWith('/') || normalizedPath.match(/^[a-zA-Z]:/)) {
      warnings.push('File path appears to be absolute');
      risk_level = 'medium';
    }

    // File extension validation
    if (!normalizedPath.toLowerCase().endsWith('.pdf')) {
      errors.push('Only PDF files are allowed');
      risk_level = 'medium';
    }

    // Suspicious characters
    const suspiciousChars = /[<>:"|?*\x00-\x1f]/;
    if (suspiciousChars.test(filePath)) {
      errors.push('File path contains suspicious characters');
      risk_level = 'high';
    }

    return { valid: errors.length === 0, errors, warnings, risk_level };
  }

  /**
   * Validate message content for prompt injection
   */
  private validateMessageContent(content: string): SecurityValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let risk_level: 'low' | 'medium' | 'high' | 'critical' = 'low';

    // Length validation
    if (content.length > this.config.max_content_length) {
      errors.push(`Message content exceeds maximum length of ${this.config.max_content_length} characters`);
      risk_level = 'medium';
    }

    // Prompt injection patterns
    const injectionPatterns = [
      /ignore\s+previous\s+instructions/i,
      /forget\s+everything/i,
      /new\s+instructions/i,
      /system\s*:\s*you\s+are/i,
      /assistant\s*:\s*/i,
      /\[INST\]/i,
      /\[\/INST\]/i,
      /<\|im_start\|>/i,
      /<\|im_end\|>/i
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(content)) {
        errors.push('Message content contains potential prompt injection patterns');
        risk_level = 'critical';
        break;
      }
    }

    // Excessive repetition (could be used to confuse the model)
    const repetitionMatch = content.match(/(.{10,})\1{3,}/);
    if (repetitionMatch) {
      warnings.push('Message content contains excessive repetition');
      risk_level = 'medium';
    }

    return { valid: errors.length === 0, errors, warnings, risk_level };
  }

  /**
   * Cross-field validation
   */
  private validateCrossFields(input: InjectorInput): SecurityValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let risk_level: 'low' | 'medium' | 'high' | 'critical' = 'low';

    // Check for consistency between subject and chapter content
    const subjectKeywords = {
      'Physics': ['force', 'energy', 'motion', 'wave', 'particle', 'quantum', 'mechanics', 'optics'],
      'Chemistry': ['atom', 'molecule', 'reaction', 'bond', 'element', 'compound', 'organic', 'inorganic'],
      'Mathematics': ['equation', 'function', 'calculus', 'algebra', 'geometry', 'trigonometry', 'statistics']
    };

    const expectedKeywords = subjectKeywords[input.subject] || [];
    const chapterLower = input.chapter.toLowerCase();
    const hasRelevantKeywords = expectedKeywords.some(keyword => chapterLower.includes(keyword));

    if (!hasRelevantKeywords && input.chapter.length > 10) {
      warnings.push(`Chapter title does not contain typical ${input.subject} keywords`);
    }

    return { valid: errors.length === 0, errors, warnings, risk_level };
  }

  /**
   * Sanitize InjectorInput by applying safe transformations
   */
  private sanitizeInjectorInput(input: InjectorInput): InjectorInput {
    const sanitized: InjectorInput = {
      grade: this.sanitizeText(input.grade),
      subject: input.subject, // Enum, already validated
      chapter: this.sanitizeText(input.chapter),
      standard: this.sanitizeText(input.standard),
      difficulty: input.difficulty, // Enum, already validated
    };

    if (input.pages_hint) {
      sanitized.pages_hint = this.sanitizeText(input.pages_hint);
    }

    if (input.chapter_pdf_path) {
      sanitized.chapter_pdf_path = this.sanitizeFilePath(input.chapter_pdf_path);
    }

    return sanitized;
  }

  /**
   * Sanitize text by normalizing and removing dangerous characters
   */
  private sanitizeText(text: string): string {
    let sanitized = text;

    // Unicode normalization
    if (this.config.enable_unicode_normalization) {
      sanitized = sanitized.normalize('NFC');
    }

    // Remove dangerous Unicode characters
    for (const [start, end] of DANGEROUS_UNICODE_RANGES) {
      const pattern = new RegExp(`[\\u${start.toString(16).padStart(4, '0')}-\\u${end.toString(16).padStart(4, '0')}]`, 'g');
      sanitized = sanitized.replace(pattern, '');
    }

    // Trim whitespace
    sanitized = sanitized.trim();

    return sanitized;
  }

  /**
   * Sanitize file path
   */
  private sanitizeFilePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  /**
   * Utility methods for character detection
   */
  private detectDangerousUnicode(text: string): string[] {
    const dangerous: string[] = [];

    for (const [start, end] of DANGEROUS_UNICODE_RANGES) {
      for (let i = 0; i < text.length; i++) {
        const codePoint = text.codePointAt(i);
        if (codePoint && codePoint >= start && codePoint <= end) {
          dangerous.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      }
    }

    return [...new Set(dangerous)];
  }

  private containsBidiCharacters(text: string): boolean {
    return /[\u202A-\u202E\u2066-\u2069]/g.test(text);
  }

  private detectScripts(text: string): string[] {
    const detectedScripts: string[] = [];

    for (const [scriptName, pattern] of Object.entries(SCRIPT_PATTERNS)) {
      if (pattern.test(text)) {
        detectedScripts.push(scriptName);
      }
    }

    return detectedScripts;
  }

  private detectTemplateVariables(text: string): string[] {
    const variables: string[] = [];

    for (const pattern of SAFE_TEMPLATE_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        variables.push(match[0]);
      }
    }

    return [...new Set(variables)];
  }

  private detectDangerousTemplates(text: string): string[] {
    const dangerous: string[] = [];

    for (const pattern of DANGEROUS_TEMPLATE_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        dangerous.push(match[0]);
      }
    }

    return [...new Set(dangerous)];
  }

  private getRiskLevel(level: string): number {
    const levels = { 'low': 0, 'medium': 1, 'high': 2, 'critical': 3 };
    return levels[level as keyof typeof levels] || 0;
  }
}

/**
 * Convenience function for quick validation
 */
export function validateInjectorInput(input: InjectorInput, config?: Partial<SecurityConfig>): SecurityValidationResult {
  const sanitizer = new SecuritySanitizer(config);
  return sanitizer.validateInjectorInput(input);
}

/**
 * Convenience function for quick PromptEnvelope validation
 */
export function validatePromptEnvelope(envelope: PromptEnvelopeV1, config?: Partial<SecurityConfig>): SecurityValidationResult {
  const sanitizer = new SecuritySanitizer(config);
  return sanitizer.validatePromptEnvelope(envelope);
}