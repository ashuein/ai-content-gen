/**
 * Course Database Resolver
 * Automatically selects appropriate PDF files from course_database based on metadata
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface CourseMetadata {
  grade: string;
  subject: string;
  chapter: string;
  standard: string;
}

export interface ChapterInfo {
  chapterName: string;
  pdfPath: string;
  class: string;
  subject: string;
  chapterNumber: number;
}

export interface UnifiedIndexEntry {
  absolutePath: string;
  fileName: string;
  fileSize: number;
  chapterNumber: number | null;
  chapterName: string;
  subject: string;
  class: string;
  confidence: number;
  extractionMethod: string;
  indexedAt: string;
}

export interface UnifiedIndex {
  metadata: {
    version: string;
    indexedAt: string;
    scannedFolder: string;
    totalPDFs: number;
    successfullyIndexed: number;
    failedIndexing: number;
  };
  index: Record<string, UnifiedIndexEntry>;
}

/**
 * Resolves course metadata to PDF paths using indexed NCERT database
 */
export class CourseDatabaseResolver {
  private courseRoot: string;
  private simpleMappingCache?: Record<string, ChapterInfo>;
  private unifiedIndexCache?: UnifiedIndex;
  private logger?: (level: string, message: string, data?: any) => void;

  constructor(courseRoot: string = './course_database', logger?: (level: string, message: string, data?: any) => void) {
    this.courseRoot = courseRoot;
    this.logger = logger;
  }

  /**
   * Resolve course metadata to PDF path with fallback strategies
   */
  async resolvePdfPath(metadata: CourseMetadata): Promise<{
    success: boolean;
    pdfPath?: string;
    checksum?: string;
    confidence: number;
    method: string;
    error?: string;
  }> {
    try {
      this.logger?.('info', 'Resolving PDF path for course metadata', metadata);

      // Strategy 1: Try unified index (most comprehensive)
      const unifiedResult = await this.tryUnifiedIndex(metadata);
      if (unifiedResult.success) {
        const checksum = await this.calculateFileChecksum(unifiedResult.pdfPath!);
        return {
          ...unifiedResult,
          checksum,
          method: 'unified_index'
        };
      }

      // Strategy 2: Try simple mapping (fallback)
      const simpleResult = await this.trySimpleMapping(metadata);
      if (simpleResult.success) {
        const checksum = await this.calculateFileChecksum(simpleResult.pdfPath!);
        return {
          ...simpleResult,
          checksum,
          method: 'simple_mapping'
        };
      }

      // Strategy 3: Try fuzzy matching on chapter names
      const fuzzyResult = await this.tryFuzzyMatching(metadata);
      if (fuzzyResult.success) {
        const checksum = await this.calculateFileChecksum(fuzzyResult.pdfPath!);
        return {
          ...fuzzyResult,
          checksum,
          method: 'fuzzy_matching'
        };
      }

      return {
        success: false,
        confidence: 0,
        method: 'none',
        error: 'No matching PDF found in course database'
      };

    } catch (error) {
      this.logger?.(
        'error',
        'Failed to resolve PDF path',
        { metadata, error: error instanceof Error ? error.message : String(error) }
      );

      return {
        success: false,
        confidence: 0,
        method: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Strategy 1: Use unified index for precise matching
   */
  private async tryUnifiedIndex(metadata: CourseMetadata): Promise<{
    success: boolean;
    pdfPath?: string;
    confidence: number;
  }> {
    try {
      const unifiedIndex = await this.loadUnifiedIndex();
      if (!unifiedIndex) {
        return { success: false, confidence: 0 };
      }

      // Normalize input metadata
      const normalizedGrade = this.normalizeGrade(metadata.grade);
      const normalizedSubject = this.normalizeSubject(metadata.subject);
      const normalizedChapter = this.normalizeChapter(metadata.chapter);

      let bestMatch: { entry: UnifiedIndexEntry; confidence: number } | null = null;

      // Search through index
      for (const [key, entry] of Object.entries(unifiedIndex.index)) {
        // Basic filters
        if (entry.class !== normalizedGrade || entry.subject !== normalizedSubject) {
          continue;
        }

        // Calculate confidence based on chapter name similarity
        const chapterSimilarity = this.calculateSimilarity(
          normalizedChapter,
          this.normalizeChapter(entry.chapterName)
        );

        // Only consider matches above threshold
        if (chapterSimilarity < 0.7) {
          continue;
        }

        // Factor in extraction confidence
        const totalConfidence = chapterSimilarity * entry.confidence;

        if (!bestMatch || totalConfidence > bestMatch.confidence) {
          bestMatch = {
            entry,
            confidence: totalConfidence
          };
        }
      }

      if (bestMatch && bestMatch.confidence >= 0.8) {
        this.logger?.('info', 'Found high-confidence match in unified index', {
          pdfPath: bestMatch.entry.absolutePath,
          confidence: bestMatch.confidence,
          chapterName: bestMatch.entry.chapterName
        });

        return {
          success: true,
          pdfPath: bestMatch.entry.absolutePath,
          confidence: bestMatch.confidence
        };
      }

      return { success: false, confidence: bestMatch?.confidence || 0 };

    } catch (error) {
      this.logger?.('warn', 'Unified index search failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { success: false, confidence: 0 };
    }
  }

  /**
   * Strategy 2: Use simple mapping as fallback
   */
  private async trySimpleMapping(metadata: CourseMetadata): Promise<{
    success: boolean;
    pdfPath?: string;
    confidence: number;
  }> {
    try {
      const simpleMapping = await this.loadSimpleMapping();
      if (!simpleMapping) {
        return { success: false, confidence: 0 };
      }

      const normalizedGrade = this.normalizeGrade(metadata.grade);
      const normalizedSubject = this.normalizeSubject(metadata.subject);
      const normalizedChapter = this.normalizeChapter(metadata.chapter);

      let bestMatch: { info: ChapterInfo; confidence: number } | null = null;

      // Search through mapping
      for (const [key, info] of Object.entries(simpleMapping)) {
        if (info.class !== normalizedGrade || info.subject !== normalizedSubject) {
          continue;
        }

        const chapterSimilarity = this.calculateSimilarity(
          normalizedChapter,
          this.normalizeChapter(info.chapterName)
        );

        if (chapterSimilarity >= 0.7) {
          if (!bestMatch || chapterSimilarity > bestMatch.confidence) {
            bestMatch = {
              info,
              confidence: chapterSimilarity
            };
          }
        }
      }

      if (bestMatch && bestMatch.confidence >= 0.8) {
        this.logger?.('info', 'Found match in simple mapping', {
          pdfPath: bestMatch.info.pdfPath,
          confidence: bestMatch.confidence,
          chapterName: bestMatch.info.chapterName
        });

        return {
          success: true,
          pdfPath: bestMatch.info.pdfPath,
          confidence: bestMatch.confidence
        };
      }

      return { success: false, confidence: bestMatch?.confidence || 0 };

    } catch (error) {
      this.logger?.('warn', 'Simple mapping search failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { success: false, confidence: 0 };
    }
  }

  /**
   * Strategy 3: Fuzzy matching on chapter names
   */
  private async tryFuzzyMatching(metadata: CourseMetadata): Promise<{
    success: boolean;
    pdfPath?: string;
    confidence: number;
  }> {
    try {
      // Load both indices for comprehensive fuzzy search
      const unifiedIndex = await this.loadUnifiedIndex();
      const simpleMapping = await this.loadSimpleMapping();

      const normalizedGrade = this.normalizeGrade(metadata.grade);
      const normalizedSubject = this.normalizeSubject(metadata.subject);
      const normalizedChapter = this.normalizeChapter(metadata.chapter);

      let candidates: Array<{ path: string; name: string; confidence: number }> = [];

      // Collect candidates from unified index
      if (unifiedIndex) {
        for (const entry of Object.values(unifiedIndex.index)) {
          if (entry.class === normalizedGrade && entry.subject === normalizedSubject) {
            const similarity = this.calculateFuzzySimilarity(
              normalizedChapter,
              this.normalizeChapter(entry.chapterName)
            );
            if (similarity >= 0.5) {
              candidates.push({
                path: entry.absolutePath,
                name: entry.chapterName,
                confidence: similarity * entry.confidence
              });
            }
          }
        }
      }

      // Collect candidates from simple mapping
      if (simpleMapping) {
        for (const info of Object.values(simpleMapping)) {
          if (info.class === normalizedGrade && info.subject === normalizedSubject) {
            const similarity = this.calculateFuzzySimilarity(
              normalizedChapter,
              this.normalizeChapter(info.chapterName)
            );
            if (similarity >= 0.5) {
              candidates.push({
                path: info.pdfPath,
                name: info.chapterName,
                confidence: similarity * 0.9 // Slightly lower confidence for simple mapping
              });
            }
          }
        }
      }

      // Sort by confidence and take best match
      candidates.sort((a, b) => b.confidence - a.confidence);
      const bestMatch = candidates[0];

      if (bestMatch && bestMatch.confidence >= 0.6) {
        this.logger?.('info', 'Found fuzzy match', {
          pdfPath: bestMatch.path,
          confidence: bestMatch.confidence,
          chapterName: bestMatch.name
        });

        return {
          success: true,
          pdfPath: bestMatch.path,
          confidence: bestMatch.confidence
        };
      }

      return { success: false, confidence: bestMatch?.confidence || 0 };

    } catch (error) {
      this.logger?.('warn', 'Fuzzy matching failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { success: false, confidence: 0 };
    }
  }

  /**
   * Load unified index with caching
   */
  private async loadUnifiedIndex(): Promise<UnifiedIndex | null> {
    if (this.unifiedIndexCache) {
      return this.unifiedIndexCache;
    }

    try {
      const indexPath = path.join(this.courseRoot, 'unified_index_ncert.json');
      const content = await fs.readFile(indexPath, 'utf8');
      this.unifiedIndexCache = JSON.parse(content);
      return this.unifiedIndexCache;
    } catch (error) {
      this.logger?.('warn', 'Failed to load unified index', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Load simple mapping with caching
   */
  private async loadSimpleMapping(): Promise<Record<string, ChapterInfo> | null> {
    if (this.simpleMappingCache) {
      return this.simpleMappingCache;
    }

    try {
      const mappingPath = path.join(this.courseRoot, 'chapter_mapping_simple.json');
      const content = await fs.readFile(mappingPath, 'utf8');
      this.simpleMappingCache = JSON.parse(content);
      return this.simpleMappingCache;
    } catch (error) {
      this.logger?.('warn', 'Failed to load simple mapping', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Calculate file checksum for integrity verification
   */
  private async calculateFileChecksum(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      this.logger?.('warn', 'Failed to calculate file checksum', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      return '';
    }
  }

  /**
   * Normalize grade string
   */
  private normalizeGrade(grade: string): string {
    return grade.toLowerCase()
      .replace(/class\s*/i, '')
      .replace(/xi/i, '11')
      .replace(/xii/i, '12');
  }

  /**
   * Normalize subject string
   */
  private normalizeSubject(subject: string): string {
    return subject.toLowerCase();
  }

  /**
   * Normalize chapter string
   */
  private normalizeChapter(chapter: string): string {
    return chapter.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Calculate string similarity (exact matching)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;

    const words1 = str1.split(' ');
    const words2 = str2.split(' ');

    const commonWords = words1.filter(word => words2.includes(word));
    const totalWords = Math.max(words1.length, words2.length);

    return commonWords.length / totalWords;
  }

  /**
   * Calculate fuzzy similarity (more permissive)
   */
  private calculateFuzzySimilarity(str1: string, str2: string): number {
    // Levenshtein distance based similarity
    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    return maxLength === 0 ? 1 : 1 - (distance / maxLength);
  }

  /**
   * Calculate Levenshtein distance
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * List available chapters for debugging
   */
  async listAvailableChapters(grade?: string, subject?: string): Promise<Array<{
    grade: string;
    subject: string;
    chapter: string;
    confidence: number;
    path: string;
  }>> {
    const chapters: Array<{
      grade: string;
      subject: string;
      chapter: string;
      confidence: number;
      path: string;
    }> = [];

    try {
      const unifiedIndex = await this.loadUnifiedIndex();
      if (unifiedIndex) {
        for (const entry of Object.values(unifiedIndex.index)) {
          if ((!grade || entry.class === this.normalizeGrade(grade)) &&
              (!subject || entry.subject === this.normalizeSubject(subject))) {
            chapters.push({
              grade: entry.class,
              subject: entry.subject,
              chapter: entry.chapterName,
              confidence: entry.confidence,
              path: entry.absolutePath
            });
          }
        }
      }

      return chapters.sort((a, b) => b.confidence - a.confidence);

    } catch (error) {
      this.logger?.('error', 'Failed to list available chapters', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.simpleMappingCache = undefined;
    this.unifiedIndexCache = undefined;
  }
}