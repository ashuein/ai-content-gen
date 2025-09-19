import { compilePlotToSVG, validateExpr } from '../../../../server/pgf/compile.js';
import { CacheManager } from '../../../cache/src/cache-manager.js';
import type { PlotSpec } from '../../../../types.js';

/**
 * PGFPlots Compiler Wrapper
 * Bridges existing tectonic compilation to Content Engine architecture
 */
export class PGFPlotsCompiler {
  private cacheManager: CacheManager;

  constructor(cacheManager: CacheManager) {
    this.cacheManager = cacheManager;
  }

  /**
   * Compile plot specification to SVG using existing tectonic pipeline
   */
  async compile(plotSpec: PlotSpec, correlationId?: string): Promise<CompilerResult> {
    try {
      // Validate the plot expression first
      this.validatePlotSpec(plotSpec);

      // Check cache first
      const cacheKey = this.generateCacheKey(plotSpec);
      const cached = await this.cacheManager.get<string>(cacheKey, 'plots');

      if (cached) {
        return {
          success: true,
          svg: cached,
          metadata: {
            compiler: 'tectonic-dvisvgm',
            compilerVersion: '1.0.0',
            cached: true,
            contentHash: cacheKey
          }
        };
      }

      // Compile using existing implementation
      const svg = await compilePlotToSVG(plotSpec);

      // Cache the result
      await this.cacheManager.set(svg, 'plots', {
        templateVersion: '1.0.0',
        compiler: 'tectonic-dvisvgm',
        tags: ['pgfplot', plotSpec.kind],
        ttl: 3600 // 1 hour TTL
      });

      return {
        success: true,
        svg,
        metadata: {
          compiler: 'tectonic-dvisvgm',
          compilerVersion: '1.0.0',
          cached: false,
          contentHash: cacheKey
        }
      };

    } catch (error) {
      return {
        success: false,
        error: {
          code: 'E-COMPILER-PGFPLOTS',
          message: error instanceof Error ? error.message : 'Unknown compilation error',
          context: { plotSpec, correlationId }
        }
      };
    }
  }

  /**
   * Validate plot specification
   */
  private validatePlotSpec(plotSpec: PlotSpec): void {
    if (plotSpec.kind !== 'pgfplot') {
      throw new Error('Unsupported plot kind: only pgfplot is supported');
    }

    if (!plotSpec.expr) {
      throw new Error('Plot expression is required');
    }

    // Use existing expression validator
    validateExpr(plotSpec.expr);

    // Validate parameters if present
    if (plotSpec.params) {
      for (const [name, value] of Object.entries(plotSpec.params)) {
        if (typeof value !== 'number' || !isFinite(value)) {
          throw new Error(`Invalid parameter value for ${name}: must be a finite number`);
        }
      }
    }

    // Validate axis ranges
    if (plotSpec.x.min >= plotSpec.x.max) {
      throw new Error('X-axis min must be less than max');
    }

    if (plotSpec.y.min >= plotSpec.y.max) {
      throw new Error('Y-axis min must be less than max');
    }

    // Validate samples count
    const samples = plotSpec.style?.samples ?? 201;
    if (samples < 10 || samples > 10000) {
      throw new Error('Samples count must be between 10 and 10000');
    }
  }

  /**
   * Generate cache key for plot specification
   */
  private generateCacheKey(plotSpec: PlotSpec): string {
    // Create deterministic cache key based on plot content
    const normalizedSpec = {
      kind: plotSpec.kind,
      expr: plotSpec.expr,
      x: plotSpec.x,
      y: plotSpec.y,
      style: plotSpec.style || {},
      params: plotSpec.params || {},
      title: plotSpec.title || ''
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
      name: 'PGFPlots Tectonic Compiler',
      version: '1.0.0',
      supportedFormats: ['pgfplot'],
      dependencies: ['tectonic', 'dvisvgm', 'ghostscript'],
      outputFormat: 'svg'
    };
  }

  /**
   * Validate plot expression syntax
   */
  async validateExpression(expression: string): Promise<ValidationResult> {
    try {
      validateExpr(expression);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid expression'
      };
    }
  }

  /**
   * Generate secure LaTeX template for manual compilation
   */
  generateSecureTemplate(plotSpec: PlotSpec): string {
    const xmin = plotSpec.x.min;
    const xmax = plotSpec.x.max;
    const ymin = plotSpec.y.min;
    const ymax = plotSpec.y.max;
    const samples = Math.max(11, plotSpec.style?.samples ?? 201);
    const grid = plotSpec.style?.grid ? ',grid=both' : '';
    const xlabel = plotSpec.x.label ?? '';
    const ylabel = plotSpec.y.label ?? '';
    const labelOpts = `${xlabel ? `,xlabel={${xlabel}}` : ''}${ylabel ? `,ylabel={${ylabel}}` : ''}`;

    return `\\documentclass[tikz,border=2pt]{standalone}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}

% Security: Disable dangerous commands
\\let\\write\\undefined
\\let\\input\\undefined
\\let\\include\\undefined

\\begin{document}
\\begin{tikzpicture}
\\begin{axis}[xmin=${xmin}, xmax=${xmax}, ymin=${ymin}, ymax=${ymax}, samples=${samples}${grid}${labelOpts}]
\\addplot[blue, thick, domain=${xmin}:${xmax}] expression{${plotSpec.expr}};
\\end{axis}
\\end{tikzpicture}
\\end{document}
`;
  }
}

// Type definitions
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
}