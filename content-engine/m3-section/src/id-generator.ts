import { ValidationResult } from './types.js';

/**
 * Deterministic ID Generator for stable cross-rebuild references
 * Implements the ID conventions specified in con_gen_schema.md
 */
export class IDGenerator {
  private counters: Record<string, number> = {};

  constructor(private chapterSlug: string) {}

  /**
   * Generate deterministic ID for asset types
   */
  generateID(type: 'eq' | 'plot' | 'fig' | 'wid' | 'chem'): string {
    // Increment counter for this type
    this.counters[type] = (this.counters[type] || 0) + 1;

    // Format: {type}-{chapter-slug}-{zero-padded-sequence}
    const sequence = this.counters[type].toString().padStart(2, '0');
    return `${type}-${this.chapterSlug}-${sequence}`;
  }

  /**
   * Generate prose block ID
   */
  generateProseID(sectionId: string): string {
    const proseKey = `prose-${sectionId}`;
    this.counters[proseKey] = (this.counters[proseKey] || 0) + 1;

    const sequence = this.counters[proseKey].toString().padStart(2, '0');
    return `prose-${sectionId}-${sequence}`;
  }

  /**
   * Validate ID format according to conventions
   */
  validateID(id: string, expectedType: string): ValidationResult {
    const patterns = {
      'eq': /^eq-[a-z0-9-]+-[0-9]{2,}$/,
      'plot': /^plot-[a-z0-9-]+-[0-9]{2,}$/,
      'fig': /^fig-[a-z0-9-]+-[0-9]{2,}$/,
      'wid': /^wid-[a-z0-9-]+-[0-9]{2,}$/,
      'chem': /^chem-[a-z0-9-]+-[0-9]{2,}$/,
      'prose': /^prose-sec-[0-9]+-[0-9]{2,}$/
    };

    const pattern = patterns[expectedType as keyof typeof patterns];
    if (!pattern) {
      return {
        valid: false,
        errors: [`Unknown ID type: ${expectedType}`],
        data: { id, expectedType }
      };
    }

    if (!pattern.test(id)) {
      return {
        valid: false,
        errors: [`ID format invalid for type ${expectedType}: ${id}`],
        data: { id, expectedType, expectedPattern: pattern.source }
      };
    }

    return { valid: true };
  }

  /**
   * Check for ID collisions within generated IDs
   */
  checkCollisions(ids: string[]): ValidationResult {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const id of ids) {
      if (seen.has(id)) {
        duplicates.push(id);
      } else {
        seen.add(id);
      }
    }

    if (duplicates.length > 0) {
      return {
        valid: false,
        errors: [`Duplicate IDs detected: ${duplicates.join(', ')}`],
        data: { duplicateIds: duplicates }
      };
    }

    return { valid: true };
  }

  /**
   * Reset counters (for testing or new chapter)
   */
  reset(): void {
    this.counters = {};
  }

  /**
   * Get current counter state (for debugging)
   */
  getCounters(): Record<string, number> {
    return { ...this.counters };
  }

  /**
   * Validate chapter slug format
   */
  static validateChapterSlug(slug: string): ValidationResult {
    // Must be lowercase, alphanumeric, and hyphens only
    const pattern = /^[a-z0-9-]+$/;

    if (!pattern.test(slug)) {
      return {
        valid: false,
        errors: ['Chapter slug must contain only lowercase letters, numbers, and hyphens'],
        data: { slug, pattern: pattern.source }
      };
    }

    // No consecutive hyphens
    if (slug.includes('--')) {
      return {
        valid: false,
        errors: ['Chapter slug cannot contain consecutive hyphens'],
        data: { slug }
      };
    }

    // No leading or trailing hyphens
    if (slug.startsWith('-') || slug.endsWith('-')) {
      return {
        valid: false,
        errors: ['Chapter slug cannot start or end with hyphens'],
        data: { slug }
      };
    }

    // Length constraints
    if (slug.length < 3 || slug.length > 50) {
      return {
        valid: false,
        errors: ['Chapter slug must be between 3 and 50 characters'],
        data: { slug, length: slug.length }
      };
    }

    return { valid: true };
  }

  /**
   * Generate spec reference path for assets
   */
  generateSpecRef(type: 'plot' | 'diagram' | 'widget', id: string): string {
    const typeMapping = {
      'plot': 'plots',
      'diagram': 'diagrams',
      'widget': 'widgets'
    };

    const folder = typeMapping[type];
    return `${folder}/${id}.json`;
  }
}