import { BaseValidationGate, ValidationResult } from './validation-gate.ts';

/**
 * G12: Style Validation Gate
 * Enforces publication-grade textbook prose formatting requirements
 * Rejects content with markdown formatting, bullets, or file references
 */

export interface StyleValidationInput {
  md: string;
  id?: string;
}

export class StyleValidationGate extends BaseValidationGate {
  readonly name = "Style Format Validator";
  readonly gateNumber = "G12";
  readonly description = "Validates content follows publication-grade textbook prose without markdown formatting, bullets, or raw filenames";
  private readonly patterns = {
    // Markdown headers (# ## ### etc.)
    headers: /^#{1,6}\s+.+$/gm,

    // Bullet points (- * +)
    bullets: /^\s*[-*+]\s+.+$/gm,

    // Numbered lists (1. 2. etc.)
    numberedLists: /^\s*\d+\.\s+.+$/gm,

    // Code fences (``` or ```)
    codeFences: /```[\s\S]*?```|`[^`]+`/g,

    // File references (filename.extension)
    fileReferences: /\b\w+\.(pdf|doc|docx|txt|md|json|xml|html|jpg|png|gif)\b/gi,

    // Common problematic file patterns
    pdfReferences: /\b(kech\d+|ncert|textbook)\.pdf\b/gi
  };

  /**
   * Validate content against style requirements
   */
  async validate(input: StyleValidationInput): Promise<ValidationResult> {
    const { md, id } = input;

    if (!md || typeof md !== 'string') {
      return this.createError(
        'E-G12-INVALID-INPUT',
        'Content must be a non-empty string',
        { md, id }
      );
    }

    const violations: any[] = [];

    // Check for markdown headers
    const headerMatches = Array.from(md.matchAll(this.patterns.headers));
    for (const match of headerMatches) {
      violations.push({
        code: 'E-G12-MARKDOWN-HEADER',
        type: 'markdown_header',
        message: 'Markdown headers are forbidden - use formal textbook paragraphs instead',
        location: id ? `${id}:${this.getLineNumber(md, match.index!)}` : undefined,
        content: match[0].trim()
      });
    }

    // Check for bullet points
    const bulletMatches = Array.from(md.matchAll(this.patterns.bullets));
    for (const match of bulletMatches) {
      violations.push({
        code: 'E-G12-BULLET-LIST',
        type: 'bullet_list',
        message: 'Bullet points are forbidden - use narrative paragraph flow instead',
        location: id ? `${id}:${this.getLineNumber(md, match.index!)}` : undefined,
        content: match[0].trim()
      });
    }

    // Check for numbered lists
    const numberedMatches = Array.from(md.matchAll(this.patterns.numberedLists));
    for (const match of numberedMatches) {
      violations.push({
        code: 'E-G12-NUMBERED-LIST',
        type: 'numbered_list',
        message: 'Numbered lists are forbidden - use narrative paragraph flow instead',
        location: id ? `${id}:${this.getLineNumber(md, match.index!)}` : undefined,
        content: match[0].trim()
      });
    }

    // Check for code fences
    const codeMatches = Array.from(md.matchAll(this.patterns.codeFences));
    for (const match of codeMatches) {
      violations.push({
        code: 'E-G12-CODE-FENCE',
        type: 'code_fence',
        message: 'Code fences are forbidden - use formal textbook language only',
        location: id ? `${id}:${this.getLineNumber(md, match.index!)}` : undefined,
        content: match[0].substring(0, 50) + (match[0].length > 50 ? '...' : '')
      });
    }

    // Check for file references
    const fileMatches = Array.from(md.matchAll(this.patterns.fileReferences));
    for (const match of fileMatches) {
      violations.push({
        code: 'E-G12-FILE-REFERENCE',
        type: 'file_reference',
        message: 'Raw filenames are forbidden - use proper in-text citations like "NCERT Class XI Chemistry (p. 98)" instead',
        location: id ? `${id}:${this.getLineNumber(md, match.index!)}` : undefined,
        content: match[0]
      });
    }

    if (violations.length > 0) {
      return {
        valid: false,
        errors: violations
      };
    }

    return this.createSuccess({
      message: 'Content follows publication-grade textbook prose requirements',
      statistics: {
        contentLength: md.length,
        paragraphs: md.split('\n\n').length
      }
    });
  }

  /**
   * Get line number for a character position in text
   */
  private getLineNumber(text: string, position: number): number {
    return text.substring(0, position).split('\n').length;
  }

  /**
   * Generate repair suggestions for common style violations
   */
  generateRepairSuggestions(violations: any[]): string[] {
    const suggestions: string[] = [];

    if (violations.some(e => e.type === 'markdown_header')) {
      suggestions.push('Replace markdown headers with topic sentences that introduce each concept naturally within paragraph flow');
    }

    if (violations.some(e => e.type === 'bullet_list' || e.type === 'numbered_list')) {
      suggestions.push('Convert lists to narrative paragraphs using transitional phrases like "first," "additionally," "furthermore"');
    }

    if (violations.some(e => e.type === 'file_reference')) {
      suggestions.push('Replace raw filenames with proper academic citations: "NCERT Class XI Chemistry (p. 98)"');
    }

    if (violations.some(e => e.type === 'code_fence')) {
      suggestions.push('Remove code formatting and express content in formal academic prose');
    }

    return suggestions;
  }
}