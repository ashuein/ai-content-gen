import { BaseValidationGate, ValidationResult } from './validation-gate.js';

/**
 * G9: Unicode Sanitization and Security Validation Gate
 * Validates and sanitizes text content for security and consistency
 */
export class UnicodeSanitizerGate extends BaseValidationGate {
  readonly name = "Unicode Sanitization and Security Validator";
  readonly gateNumber = "G9";
  readonly description = "Validates and sanitizes Unicode text for security vulnerabilities and homoglyph attacks";

  // Dangerous Unicode categories that should be removed or flagged
  private readonly dangerousCategories = [
    // Control characters (except common whitespace)
    /[\u0000-\u001F\u007F-\u009F]/g,

    // Zero-width characters (potential for hiding malicious content)
    /[\u200B-\u200D\u2060\uFEFF]/g,

    // Bidi override characters (can be used for spoofing)
    /[\u202A-\u202E\u2066-\u2069]/g,

    // Private use areas
    /[\uE000-\uF8FF\uF0000-\uFFFFD\u100000-\u10FFFD]/g,

    // Non-characters
    /[\uFDD0-\uFDEF\uFFFE\uFFFF]/g,

    // Surrogates (should be properly paired)
    /[\uD800-\uDFFF]/g
  ];

  // Common homoglyph mappings (simplified set)
  private readonly homoglyphMappings: Map<string, string> = new Map([
    // Cyrillic to Latin
    ['а', 'a'], ['о', 'o'], ['р', 'p'], ['с', 'c'], ['е', 'e'], ['х', 'x'],

    // Greek to Latin
    ['α', 'a'], ['ο', 'o'], ['ρ', 'p'], ['ν', 'v'], ['μ', 'u'],

    // Mathematical alphanumeric symbols
    ['𝐚', 'a'], ['𝐛', 'b'], ['𝐜', 'c'], ['𝐝', 'd'], ['𝐞', 'e'],

    // Fullwidth characters
    ['Ａ', 'A'], ['Ｂ', 'B'], ['Ｃ', 'C'], ['１', '1'], ['２', '2']
  ]);

  /**
   * Validate and sanitize Unicode text
   */
  async validate(input: {
    text: string;
    mode?: 'strict' | 'permissive';
    context?: string;
    maxLength?: number;
  }): ValidationResult {
    const { text, mode = 'strict', context, maxLength = 10000 } = input;

    if (typeof text !== 'string') {
      return this.createError(
        'E-G9-INVALID-INPUT',
        'Input must be a string',
        { text, context }
      );
    }

    try {
      // Step 1: Length validation
      if (text.length > maxLength) {
        return this.createError(
          'E-G9-TEXT-TOO-LONG',
          `Text length ${text.length} exceeds maximum ${maxLength}`,
          { length: text.length, maxLength, context }
        );
      }

      // Step 2: Detect and analyze security issues
      const securityAnalysis = this.analyzeSecurityIssues(text);

      // Step 3: Detect homoglyph attacks
      const homoglyphAnalysis = this.analyzeHomoglyphs(text);

      // Step 4: Sanitize text
      const sanitized = this.sanitizeText(text, mode);

      // Step 5: Validate the result
      const validationResult = this.validateSanitizedText(sanitized, mode);
      if (!validationResult.valid) {
        return validationResult;
      }

      // Determine if issues found require failure in strict mode
      const criticalIssues = securityAnalysis.criticalIssues.length > 0 ||
                           homoglyphAnalysis.risk === 'HIGH';

      if (mode === 'strict' && criticalIssues) {
        return this.createError(
          'E-G9-SECURITY-VIOLATION',
          'Text contains security violations in strict mode',
          {
            securityIssues: securityAnalysis,
            homoglyphAnalysis,
            originalText: text,
            context
          }
        );
      }

      return this.createSuccess({
        originalText: text,
        sanitizedText: sanitized,
        changed: text !== sanitized,
        securityAnalysis,
        homoglyphAnalysis,
        context
      });

    } catch (error) {
      return this.createError(
        'E-G9-SANITIZATION-ERROR',
        'Error during Unicode sanitization',
        {
          text: text.substring(0, 100), // Truncate for logging
          error: error instanceof Error ? error.message : String(error),
          context
        }
      );
    }
  }

  /**
   * Analyze text for security issues
   */
  private analyzeSecurityIssues(text: string): SecurityAnalysis {
    const issues: SecurityIssue[] = [];
    const criticalIssues: SecurityIssue[] = [];

    // Check for dangerous Unicode categories
    for (const [index, pattern] of this.dangerousCategories.entries()) {
      const matches = Array.from(text.matchAll(pattern));
      if (matches.length > 0) {
        const issue: SecurityIssue = {
          type: this.getSecurityIssueType(index),
          severity: this.getSecuritySeverity(index),
          count: matches.length,
          positions: matches.map(m => m.index!),
          description: this.getSecurityDescription(index)
        };

        issues.push(issue);

        if (issue.severity === 'CRITICAL') {
          criticalIssues.push(issue);
        }
      }
    }

    // Check for suspicious patterns
    const suspiciousPatterns = this.detectSuspiciousPatterns(text);
    issues.push(...suspiciousPatterns);

    return { issues, criticalIssues };
  }

  /**
   * Get security issue type by pattern index
   */
  private getSecurityIssueType(patternIndex: number): string {
    const types = [
      'CONTROL_CHARACTERS',
      'ZERO_WIDTH_CHARACTERS',
      'BIDI_OVERRIDE',
      'PRIVATE_USE',
      'NON_CHARACTERS',
      'UNPAIRED_SURROGATES'
    ];
    return types[patternIndex] || 'UNKNOWN';
  }

  /**
   * Get security severity by pattern index
   */
  private getSecuritySeverity(patternIndex: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const severities: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = [
      'MEDIUM',   // Control characters
      'HIGH',     // Zero-width characters
      'CRITICAL', // Bidi override
      'MEDIUM',   // Private use
      'HIGH',     // Non-characters
      'CRITICAL'  // Unpaired surrogates
    ];
    return severities[patternIndex] || 'LOW';
  }

  /**
   * Get security description by pattern index
   */
  private getSecurityDescription(patternIndex: number): string {
    const descriptions = [
      'Contains control characters that may affect display',
      'Contains zero-width characters that could hide malicious content',
      'Contains bidirectional override characters used for spoofing',
      'Contains private use area characters with undefined behavior',
      'Contains Unicode non-characters',
      'Contains unpaired surrogate characters'
    ];
    return descriptions[patternIndex] || 'Unknown security issue';
  }

  /**
   * Detect suspicious patterns
   */
  private detectSuspiciousPatterns(text: string): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    // Mixed script detection (potential for confusion)
    const scripts = this.detectScripts(text);
    if (scripts.size > 2) {
      issues.push({
        type: 'MIXED_SCRIPTS',
        severity: 'MEDIUM',
        count: scripts.size,
        positions: [],
        description: `Text contains ${scripts.size} different scripts: ${Array.from(scripts).join(', ')}`
      });
    }

    // Excessive combining characters
    const combiningMatches = Array.from(text.matchAll(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF]/g));
    if (combiningMatches.length > text.length * 0.1) {
      issues.push({
        type: 'EXCESSIVE_COMBINING',
        severity: 'HIGH',
        count: combiningMatches.length,
        positions: combiningMatches.map(m => m.index!),
        description: 'Excessive use of combining characters'
      });
    }

    return issues;
  }

  /**
   * Detect scripts used in text
   */
  private detectScripts(text: string): Set<string> {
    const scripts = new Set<string>();

    for (const char of text) {
      const codePoint = char.codePointAt(0)!;

      if (codePoint >= 0x0000 && codePoint <= 0x007F) {
        scripts.add('Latin');
      } else if (codePoint >= 0x0400 && codePoint <= 0x04FF) {
        scripts.add('Cyrillic');
      } else if (codePoint >= 0x0370 && codePoint <= 0x03FF) {
        scripts.add('Greek');
      } else if (codePoint >= 0x0590 && codePoint <= 0x05FF) {
        scripts.add('Hebrew');
      } else if (codePoint >= 0x0600 && codePoint <= 0x06FF) {
        scripts.add('Arabic');
      } else if (codePoint >= 0x4E00 && codePoint <= 0x9FFF) {
        scripts.add('CJK');
      } else if (codePoint > 0x007F) {
        scripts.add('Other');
      }
    }

    return scripts;
  }

  /**
   * Analyze text for homoglyph attacks
   */
  private analyzeHomoglyphs(text: string): HomoglyphAnalysis {
    const suspiciousChars: HomoglyphMatch[] = [];
    let risk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const replacement = this.homoglyphMappings.get(char);

      if (replacement) {
        suspiciousChars.push({
          original: char,
          replacement,
          position: i,
          codePoint: char.codePointAt(0)!
        });
      }
    }

    // Assess risk level
    if (suspiciousChars.length > 0) {
      const ratio = suspiciousChars.length / text.length;

      if (ratio > 0.3) {
        risk = 'HIGH';
      } else if (ratio > 0.1 || suspiciousChars.length > 5) {
        risk = 'MEDIUM';
      } else {
        risk = 'LOW';
      }
    }

    return {
      risk,
      suspiciousChars,
      totalSuspicious: suspiciousChars.length,
      suggestions: this.generateHomoglyphSuggestions(suspiciousChars)
    };
  }

  /**
   * Generate suggestions for homoglyph replacements
   */
  private generateHomoglyphSuggestions(matches: HomoglyphMatch[]): string[] {
    const suggestions: string[] = [];

    if (matches.length > 0) {
      suggestions.push('Consider replacing suspicious characters with their Latin equivalents');

      const uniqueReplacements = new Map<string, string>();
      matches.forEach(match => {
        uniqueReplacements.set(match.original, match.replacement);
      });

      for (const [original, replacement] of uniqueReplacements) {
        suggestions.push(`Replace '${original}' with '${replacement}'`);
      }
    }

    return suggestions;
  }

  /**
   * Sanitize text according to mode
   */
  private sanitizeText(text: string, mode: 'strict' | 'permissive'): string {
    let sanitized = text;

    // Step 1: Unicode normalization (NFC - canonical composition)
    sanitized = sanitized.normalize('NFC');

    // Step 2: Remove dangerous characters
    for (const pattern of this.dangerousCategories) {
      sanitized = sanitized.replace(pattern, '');
    }

    // Step 3: In strict mode, replace homoglyphs
    if (mode === 'strict') {
      for (const [homoglyph, replacement] of this.homoglyphMappings) {
        sanitized = sanitized.replace(new RegExp(homoglyph, 'g'), replacement);
      }
    }

    // Step 4: Normalize whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
  }

  /**
   * Validate sanitized text
   */
  private validateSanitizedText(text: string, mode: string): ValidationResult {
    // Check if text is still valid UTF-8
    try {
      encodeURIComponent(text);
    } catch (error) {
      return this.createError(
        'E-G9-INVALID-UTF8',
        'Sanitized text contains invalid UTF-8 sequences',
        { text: text.substring(0, 100) }
      );
    }

    // Check for remaining suspicious characters in strict mode
    if (mode === 'strict') {
      const remainingSuspicious = this.detectRemainingSuspiciousChars(text);
      if (remainingSuspicious.length > 0) {
        return this.createError(
          'E-G9-REMAINING_SUSPICIOUS',
          'Sanitized text still contains suspicious characters',
          { suspiciousChars: remainingSuspicious }
        );
      }
    }

    return this.createSuccess();
  }

  /**
   * Detect remaining suspicious characters after sanitization
   */
  private detectRemainingSuspiciousChars(text: string): string[] {
    const suspicious: string[] = [];

    for (const char of text) {
      const codePoint = char.codePointAt(0)!;

      // Flag very high code points as potentially suspicious
      if (codePoint > 0x1F000) {
        suspicious.push(char);
      }

      // Flag uncommon punctuation and symbols
      if ((codePoint >= 0x2000 && codePoint <= 0x206F) ||
          (codePoint >= 0x2070 && codePoint <= 0x209F)) {
        suspicious.push(char);
      }
    }

    return [...new Set(suspicious)];
  }

  /**
   * Validate multiple text inputs
   */
  async validateBatch(inputs: Array<{
    text: string;
    id?: string;
    mode?: 'strict' | 'permissive';
    context?: string;
    maxLength?: number;
  }>): Promise<{
    allValid: boolean;
    results: Array<{ id?: string; valid: boolean; errors?: any[]; data?: any }>;
  }> {
    const results = [];
    let allValid = true;

    for (const input of inputs) {
      const result = await this.validate(input);
      results.push({
        id: input.id,
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
   * Quick sanitization utility for simple use cases
   */
  static quickSanitize(text: string): string {
    if (typeof text !== 'string') return '';

    return text
      .normalize('NFC')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

// Type definitions
interface SecurityAnalysis {
  issues: SecurityIssue[];
  criticalIssues: SecurityIssue[];
}

interface SecurityIssue {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  count: number;
  positions: number[];
  description: string;
}

interface HomoglyphAnalysis {
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  suspiciousChars: HomoglyphMatch[];
  totalSuspicious: number;
  suggestions: string[];
}

interface HomoglyphMatch {
  original: string;
  replacement: string;
  position: number;
  codePoint: number;
}