import { smilesToSVG } from '../../../../server/chem/rdkit.js';
import { CacheManager } from '../../../cache/src/cache-manager.js';
import { SmilesValidationGate } from '../../../validators/src/smiles-validator.js';

/**
 * RDKit Compiler Wrapper
 * Bridges existing RDKit SMILES compilation to Content Engine architecture
 */
export class RDKitCompiler {
  private cacheManager: CacheManager;
  private smilesValidator: SmilesValidationGate;

  constructor(cacheManager: CacheManager) {
    this.cacheManager = cacheManager;
    this.smilesValidator = new SmilesValidationGate();
  }

  /**
   * Compile SMILES string to SVG using existing RDKit pipeline
   */
  async compile(chemSpec: ChemSpec, correlationId?: string): Promise<CompilerResult> {
    try {
      // Validate the SMILES string first using G6 validator
      const validationResult = await this.smilesValidator.validate({
        smiles: chemSpec.smiles,
        context: `rdkit-compilation-${correlationId}`
      });

      if (!validationResult.valid) {
        return {
          success: false,
          error: {
            code: 'E-COMPILER-RDKIT-VALIDATION',
            message: 'SMILES validation failed',
            context: {
              chemSpec,
              correlationId,
              validationErrors: validationResult.errors
            }
          }
        };
      }

      // Check cache first
      const cacheKey = this.generateCacheKey(chemSpec);
      const cached = await this.cacheManager.get<string>(cacheKey, 'chem');

      if (cached) {
        return {
          success: true,
          svg: cached,
          metadata: {
            compiler: 'rdkit',
            compilerVersion: '1.0.0',
            cached: true,
            contentHash: cacheKey,
            molecularFormula: validationResult.data?.molecularFormula,
            atomCount: validationResult.data?.atomCount
          }
        };
      }

      // Compile using existing RDKit implementation
      const svg = await smilesToSVG(chemSpec.smiles);

      // Validate that we got valid SVG
      if (!svg || !svg.includes('<svg')) {
        throw new Error('RDKit compilation did not produce valid SVG output');
      }

      // Cache the result
      await this.cacheManager.set(svg, 'chem', {
        templateVersion: '1.0.0',
        compiler: 'rdkit',
        tags: ['chemistry', 'smiles', 'molecular'],
        ttl: 7200 // 2 hour TTL for chemical structures
      });

      return {
        success: true,
        svg,
        metadata: {
          compiler: 'rdkit',
          compilerVersion: '1.0.0',
          cached: false,
          contentHash: cacheKey,
          molecularFormula: validationResult.data?.molecularFormula,
          atomCount: validationResult.data?.atomCount
        }
      };

    } catch (error) {
      return {
        success: false,
        error: {
          code: 'E-COMPILER-RDKIT',
          message: error instanceof Error ? error.message : 'Unknown RDKit compilation error',
          context: { chemSpec, correlationId }
        }
      };
    }
  }

  /**
   * Validate SMILES string using Content Engine validation
   */
  async validateSmiles(smiles: string, correlationId?: string): Promise<ValidationResult> {
    const result = await this.smilesValidator.validate({
      smiles,
      context: `rdkit-validation-${correlationId}`
    });

    return {
      valid: result.valid,
      error: result.valid ? undefined : result.errors?.[0]?.message,
      data: result.data
    };
  }

  /**
   * Generate cache key for chemistry specification
   */
  private generateCacheKey(chemSpec: ChemSpec): string {
    // Create deterministic cache key based on chemical content
    const normalizedSpec = {
      smiles: chemSpec.smiles.trim(),
      style: chemSpec.style || {},
      label: chemSpec.label || '',
      description: chemSpec.description || ''
    };

    // Sort object keys for deterministic hashing
    const sortedSpec = JSON.stringify(normalizedSpec, Object.keys(normalizedSpec).sort());

    return `sha256:${require('crypto').createHash('sha256').update(sortedSpec).digest('hex')}`;
  }

  /**
   * Get compiler information
   */
  getCompilerInfo(): CompilerInfo {
    return {
      name: 'RDKit Chemical Structure Compiler',
      version: '1.0.0',
      supportedFormats: ['smiles'],
      dependencies: ['rdkit', 'python'],
      outputFormat: 'svg'
    };
  }

  /**
   * Batch compile multiple SMILES strings
   */
  async compileBatch(
    chemSpecs: ChemSpec[],
    correlationId?: string
  ): Promise<BatchCompilerResult> {
    const results: CompilerResult[] = [];
    let successCount = 0;

    for (let i = 0; i < chemSpecs.length; i++) {
      const spec = chemSpecs[i];
      const batchCorrelationId = `${correlationId}-batch-${i}`;

      const result = await this.compile(spec, batchCorrelationId);
      results.push(result);

      if (result.success) {
        successCount++;
      }
    }

    return {
      results,
      summary: {
        total: chemSpecs.length,
        successful: successCount,
        failed: chemSpecs.length - successCount,
        successRate: successCount / chemSpecs.length
      }
    };
  }

  /**
   * Get molecular information for SMILES string
   */
  async getMolecularInfo(smiles: string): Promise<MolecularInfo | null> {
    try {
      const validationResult = await this.smilesValidator.validate({
        smiles,
        context: 'molecular-info-query'
      });

      if (!validationResult.valid || !validationResult.data) {
        return null;
      }

      return {
        smiles,
        molecularFormula: validationResult.data.molecularFormula,
        atomCount: validationResult.data.atomCount,
        bondCount: validationResult.data.bondCount,
        ringCount: validationResult.data.ringCount
      };

    } catch (error) {
      console.error('Error getting molecular info:', error);
      return null;
    }
  }

  /**
   * Check if RDKit service is available
   */
  async checkServiceHealth(): Promise<HealthCheck> {
    try {
      // Test with a simple molecule (methane)
      const testSVG = await smilesToSVG('C');

      return {
        healthy: testSVG.includes('<svg'),
        service: 'rdkit',
        timestamp: new Date().toISOString(),
        details: {
          testMolecule: 'C',
          outputValid: testSVG.includes('<svg')
        }
      };

    } catch (error) {
      return {
        healthy: false,
        service: 'rdkit',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        details: {
          testMolecule: 'C',
          outputValid: false
        }
      };
    }
  }
}

// Type definitions
export interface ChemSpec {
  smiles: string;
  style?: {
    width?: number;
    height?: number;
    background?: string;
  };
  label?: string;
  description?: string;
}

export interface CompilerResult {
  success: boolean;
  svg?: string;
  error?: {
    code: string;
    message: string;
    context?: any;
  };
  metadata?: {
    compiler: string;
    compilerVersion: string;
    cached: boolean;
    contentHash: string;
    molecularFormula?: string;
    atomCount?: number;
  };
}

export interface BatchCompilerResult {
  results: CompilerResult[];
  summary: {
    total: number;
    successful: number;
    failed: number;
    successRate: number;
  };
}

export interface CompilerInfo {
  name: string;
  version: string;
  supportedFormats: string[];
  dependencies: string[];
  outputFormat: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  data?: any;
}

export interface MolecularInfo {
  smiles: string;
  molecularFormula: string;
  atomCount: number;
  bondCount: number;
  ringCount: number;
}

export interface HealthCheck {
  healthy: boolean;
  service: string;
  timestamp: string;
  error?: string;
  details?: any;
}