import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import crypto from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  SectionDoc,
  ReaderDocJSON,
  ReaderSection,
  AssemblyResult,
  AssetFile,
  AssemblyValidationReport,
  ModuleError,
  Result,
  Ok,
  Err,
  ValidationResult,
  ContentBlock,
  GeneratedAsset
} from './types.js';

/**
 * M4-Assembler: Final assembly module that produces Reader-compatible output
 * CRITICAL: Must validate against reader.v1.schema.json (G10)
 */
export class ContentAssembler {
  private ajv: Ajv;
  private readerSchema: any;
  private outputPath: string;

  constructor(outputPath: string = '../..') {
    this.outputPath = outputPath;
    this.ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(this.ajv);

    // Load Reader schema (CRITICAL for G10 validation)
    const readerSchemaPath = new URL('../../schemas-shared/reader.v1.schema.json', import.meta.url);
    this.readerSchema = JSON.parse(readFileSync(readerSchemaPath, 'utf-8'));
    this.ajv.addSchema(this.readerSchema, 'reader.v1.schema.json');
  }

  /**
   * Main entry point: assemble chapter from section documents
   */
  async assembleChapter(sectionDocs: SectionDoc[]): Promise<Result<AssemblyResult, ModuleError[]>> {
    if (sectionDocs.length === 0) {
      return Err([{
        code: 'E-M4-NO-SECTIONS',
        module: 'M4',
        data: { message: 'No section documents provided for assembly' },
        correlationId: 'unknown'
      }]);
    }

    const correlationId = sectionDocs[0].envelope.correlationId.split('-sec-')[0]; // Extract base correlation ID

    try {
      // Step 1: Validate input compatibility
      const compatibilityResult = this.validateInputCompatibility(sectionDocs);
      if (!compatibilityResult.valid) {
        return Err([{
          code: 'E-M4-INPUT-INCOMPATIBLE',
          module: 'M4',
          data: compatibilityResult.errors,
          correlationId
        }]);
      }

      // Step 2: Sort sections by ID to ensure proper order
      const sortedSections = this.sortSectionsByID(sectionDocs);

      // Step 3: Extract metadata from first section
      const chapterMeta = this.extractChapterMetadata(sortedSections);

      // Step 4: Assemble content blocks into Reader sections
      const readerSections = this.assembleReaderSections(sortedSections);

      // Step 5: Extract and process asset files
      const assetFiles = await this.extractAssetFiles(sortedSections, chapterMeta.chapterId);

      // Step 6: Create final Reader DocJSON
      const readerDocJSON: ReaderDocJSON = {
        meta: {
          title: chapterMeta.title,
          grade: chapterMeta.grade,
          subject: chapterMeta.subject,
          version: "1.0.0"
        },
        sections: readerSections
      };

      // Step 7: Run comprehensive validation (G8, G10)
      const validationReport = await this.validateAssembly(readerDocJSON, assetFiles, correlationId);

      // Step 8: Write files to disk if validation passes
      if (validationReport.readerSchemaValid && validationReport.crossReferencesValid) {
        await this.writeOutputFiles(readerDocJSON, assetFiles, chapterMeta.chapterId);
      }

      const result: AssemblyResult = {
        readerDocJSON,
        assetFiles,
        validationReport
      };

      if (!validationReport.readerSchemaValid) {
        return Err([{
          code: 'E-M4-READER-SCHEMA-INVALID',
          module: 'M4',
          data: { validationReport, errors: validationReport.errors },
          correlationId
        }]);
      }

      return Ok(result);

    } catch (error) {
      return Err([{
        code: 'E-M4-ASSEMBLY-FAILED',
        module: 'M4',
        data: { error: error instanceof Error ? error.message : String(error) },
        correlationId
      }]);
    }
  }

  /**
   * Validate input section document compatibility
   */
  private validateInputCompatibility(sectionDocs: SectionDoc[]): ValidationResult {
    const errors: string[] = [];

    // Check all sections are from same chapter
    const chapterIds = new Set(sectionDocs.map(doc => doc.payload.sectionMeta.chapterId));
    if (chapterIds.size > 1) {
      errors.push(`Sections from multiple chapters: ${Array.from(chapterIds).join(', ')}`);
    }

    // Check for duplicate section IDs
    const sectionIds = sectionDocs.map(doc => doc.payload.sectionMeta.sectionId);
    const duplicates = sectionIds.filter((id, index) => sectionIds.indexOf(id) !== index);
    if (duplicates.length > 0) {
      errors.push(`Duplicate section IDs: ${duplicates.join(', ')}`);
    }

    // Check version compatibility
    for (const doc of sectionDocs) {
      if (!this.isVersionCompatible(doc.envelope.version, '1.0.0')) {
        errors.push(`Incompatible SectionDoc version: ${doc.envelope.version}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Sort sections by section ID (sec-01, sec-02, etc.)
   */
  private sortSectionsByID(sectionDocs: SectionDoc[]): SectionDoc[] {
    return sectionDocs.sort((a, b) => {
      const aNum = parseInt(a.payload.sectionMeta.sectionId.replace('sec-', ''));
      const bNum = parseInt(b.payload.sectionMeta.sectionId.replace('sec-', ''));
      return aNum - bNum;
    });
  }

  /**
   * Extract chapter metadata from sections
   */
  private extractChapterMetadata(sectionDocs: SectionDoc[]) {
    const firstSection = sectionDocs[0].payload.sectionMeta;

    // Reconstruct chapter title from sections
    let chapterTitle = firstSection.title;

    // If we have multiple sections, try to infer chapter title
    if (sectionDocs.length > 1) {
      // Use a common prefix or first section title
      chapterTitle = this.inferChapterTitle(sectionDocs.map(doc => doc.payload.sectionMeta.title));
    }

    return {
      title: chapterTitle,
      chapterId: firstSection.chapterId,
      subject: firstSection.subject,
      difficulty: firstSection.difficulty,
      grade: this.formatGradeForReader(firstSection.difficulty, firstSection.subject)
    };
  }

  /**
   * Infer chapter title from section titles
   */
  private inferChapterTitle(sectionTitles: string[]): string {
    // Simple heuristic: use the longest common prefix or first title
    if (sectionTitles.length === 1) {
      return sectionTitles[0];
    }

    // For now, just return a generic title based on sections
    return `Chapter: ${sectionTitles.length} Sections`;
  }

  /**
   * Format grade for Reader compatibility
   */
  private formatGradeForReader(difficulty: string, subject: string): string {
    // Map difficulty and subject to grade
    const gradeMapping: Record<string, Record<string, string>> = {
      'comfort': { 'Physics': 'Class IX', 'Chemistry': 'Class X', 'Mathematics': 'Class VIII' },
      'hustle': { 'Physics': 'Class XI', 'Chemistry': 'Class XI', 'Mathematics': 'Class X' },
      'advanced': { 'Physics': 'Class XII', 'Chemistry': 'Class XII', 'Mathematics': 'Class XII' }
    };

    return gradeMapping[difficulty]?.[subject] || 'Class X';
  }

  /**
   * Assemble content blocks into Reader sections
   */
  private assembleReaderSections(sectionDocs: SectionDoc[]): ReaderSection[] {
    const readerSections: ReaderSection[] = [];

    for (const sectionDoc of sectionDocs) {
      for (const contentBlock of sectionDoc.payload.content) {
        const readerSection = this.convertContentBlockToReaderSection(contentBlock);
        if (readerSection) {
          readerSections.push(readerSection);
        }
      }
    }

    return readerSections;
  }

  /**
   * Convert content block to Reader section format
   */
  private convertContentBlockToReaderSection(block: ContentBlock): ReaderSection | null {
    switch (block.type) {
      case 'prose':
        return {
          id: block.id,
          type: 'paragraph',
          md: block.markdown
        };

      case 'equation':
        return {
          id: block.id,
          type: 'equation',
          tex: block.tex,
          check: block.check
        };

      case 'plot':
        return {
          id: block.id,
          type: 'plot',
          specRef: block.specRef
        };

      case 'chemistry':
        return {
          id: block.id,
          type: 'chem',
          smiles: block.smiles,
          caption: block.caption
        };

      case 'diagram':
        return {
          id: block.id,
          type: 'diagram',
          specRef: block.specRef
        };

      case 'widget':
        // Convert widget to Reader format
        const widget = this.convertWidgetToReaderFormat(block);
        if (widget) {
          return {
            id: block.id,
            type: 'widget',
            widget
          };
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert widget block to Reader widget format
   */
  private convertWidgetToReaderFormat(block: ContentBlock): any {
    // Extract widget spec from specRef or use default
    return {
      kind: 'formula-playground',
      expr: 'a * x + b', // Default expression
      params: [
        { name: 'a', min: -5, max: 5, step: 0.1, default: 1 },
        { name: 'b', min: -10, max: 10, step: 0.5, default: 0 }
      ],
      display: {
        latex: block.caption || 'Interactive Formula'
      }
    };
  }

  /**
   * Extract and process asset files including compiled SVG
   */
  private async extractAssetFiles(sectionDocs: SectionDoc[], chapterId: string): Promise<AssetFile[]> {
    const assetFiles: AssetFile[] = [];

    for (const sectionDoc of sectionDocs) {
      for (const asset of sectionDoc.payload.generatedAssets) {
        if (asset.spec && ['plot', 'diagram', 'widget', 'chemistry'].includes(asset.type)) {
          // Use specRef/specPath exactly for spec JSON so Reader specRef matches
          const specPath = asset.specPath;
          const specFile: AssetFile = {
            path: specPath,
            content: asset.spec,
            contentHash: asset.contentHash,
            type: asset.type
          };
          assetFiles.push(specFile);

          // Emit compiled SVG alongside spec (same base name, .svg)
          if (asset.compiledSvg && ['plot', 'diagram', 'chemistry'].includes(asset.type)) {
            const svgPath = specPath.replace(/\.json$/i, '.svg');
            const svgFile: AssetFile = {
              path: svgPath,
              content: asset.compiledSvg,
              contentHash: this.generateSvgContentHash(asset.compiledSvg),
              type: 'svg'
            };
            assetFiles.push(svgFile);
          }
        }
      }
    }

    return assetFiles;
  }

  /**
   * Generate asset file path
   */
  // No longer used for spec files; we trust asset.specPath from M3 and co-locate SVGs

  /**
   * Generate content hash for SVG content
   */
  private generateSvgContentHash(content: string): string {
    return `sha256:${require('crypto').createHash('sha256').update(content).digest('hex')}`;
  }

  /**
   * Run comprehensive validation (G8, G10)
   */
  private async validateAssembly(
    readerDocJSON: ReaderDocJSON,
    assetFiles: AssetFile[],
    correlationId: string
  ): Promise<AssemblyValidationReport> {
    const gatesPassed: string[] = [];
    const gatesFailed: string[] = [];
    const errors: any[] = [];
    const warnings: string[] = [];

    // G10: Reader schema validation (CRITICAL)
    const readerValidation = await this.validateReaderSchema(readerDocJSON);
    if (readerValidation.valid) {
      gatesPassed.push('G10-ReaderSchema');
    } else {
      gatesFailed.push('G10-ReaderSchema');
      if (readerValidation.errors) {
        errors.push(...readerValidation.errors);
      }
    }

    // G8: Cross-reference validation
    const crossRefValidation = this.validateCrossReferences(readerDocJSON, assetFiles);
    if (crossRefValidation.valid) {
      gatesPassed.push('G8-CrossReferences');
    } else {
      gatesFailed.push('G8-CrossReferences');
      if (crossRefValidation.errors) {
        warnings.push(...crossRefValidation.errors);
      }
    }

    // File path validation
    const pathValidation = this.validateFilePaths(assetFiles);

    return {
      readerSchemaValid: readerValidation.valid,
      crossReferencesValid: crossRefValidation.valid,
      filePathsValid: pathValidation.valid,
      gatesPassed,
      gatesFailed,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Validate against Reader schema (G10 - CRITICAL)
   */
  private async validateReaderSchema(readerDocJSON: ReaderDocJSON): Promise<ValidationResult> {
    const validate = this.ajv.getSchema('reader.v1.schema.json');
    if (!validate) {
      return {
        valid: false,
        errors: ['Reader schema not found']
      };
    }

    const valid = validate(readerDocJSON);
    if (!valid) {
      return {
        valid: false,
        errors: validate.errors
      };
    }

    return { valid: true };
  }

  /**
   * Validate cross-references between Reader sections and asset files
   */
  private validateCrossReferences(readerDocJSON: ReaderDocJSON, assetFiles: AssetFile[]): ValidationResult {
    const errors: string[] = [];
    const assetPaths = new Set(assetFiles.map(f => f.path));

    for (const section of readerDocJSON.sections) {
      if ('specRef' in section && section.specRef) {
        if (!assetPaths.has(section.specRef)) {
          errors.push(`Missing asset file for specRef: ${section.specRef}`);
        }
      }
    }

    // Check for unused asset files
    const referencedPaths = new Set<string>();
    for (const section of readerDocJSON.sections) {
      if ('specRef' in section && section.specRef) {
        referencedPaths.add(section.specRef);
      }
    }

    for (const assetFile of assetFiles) {
      if (!referencedPaths.has(assetFile.path)) {
        errors.push(`Unused asset file: ${assetFile.path}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Validate file paths for security
   */
  private validateFilePaths(assetFiles: AssetFile[]): ValidationResult {
    const errors: string[] = [];

    for (const assetFile of assetFiles) {
      // Check for path traversal
      if (assetFile.path.includes('..') || assetFile.path.includes('//')) {
        errors.push(`Invalid path: ${assetFile.path}`);
      }

      // Check for valid file extension (.json for specs/widgets, .svg for compiled outputs)
      if (!(assetFile.path.endsWith('.json') || assetFile.path.endsWith('.svg'))) {
        errors.push(`Invalid file extension: ${assetFile.path}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Write output files to disk
   */
  private async writeOutputFiles(
    readerDocJSON: ReaderDocJSON,
    assetFiles: AssetFile[],
    chapterId: string
  ): Promise<void> {
    // Write main chapter file to CR_chapters directory (for renderer compatibility)
    const chapterPath = join(this.outputPath, 'CR_chapters', `${chapterId}.json`);
    mkdirSync(dirname(chapterPath), { recursive: true });
    writeFileSync(chapterPath, JSON.stringify(readerDocJSON, null, 2));

    // Write asset files
    for (const assetFile of assetFiles) {
      const fullPath = join(this.outputPath, assetFile.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      if (assetFile.type === 'svg') {
        // Write raw SVG content
        writeFileSync(fullPath, String(assetFile.content));
      } else {
        writeFileSync(fullPath, JSON.stringify(assetFile.content, null, 2));
      }
    }
  }

  /**
   * Simple semantic version compatibility check
   */
  private isVersionCompatible(provided: string, supported: string): boolean {
    const [pMajor, pMinor] = provided.split('.').map(Number);
    const [sMajor, sMinor] = supported.split('.').map(Number);

    return pMajor === sMajor && pMinor <= sMinor;
  }

  /**
   * Get assembly statistics
   */
  getAssemblyStats(result: AssemblyResult): {
    sectionsCount: number;
    assetFilesCount: number;
    totalSize: number;
    gatesPassedCount: number;
    gatesFailedCount: number;
  } {
    const docSize = JSON.stringify(result.readerDocJSON).length;
    const assetSize = result.assetFiles.reduce(
      (sum, file) => sum + JSON.stringify(file.content).length,
      0
    );

    return {
      sectionsCount: result.readerDocJSON.sections.length,
      assetFilesCount: result.assetFiles.length,
      totalSize: docSize + assetSize,
      gatesPassedCount: result.validationReport.gatesPassed.length,
      gatesFailedCount: result.validationReport.gatesFailed.length
    };
  }
}