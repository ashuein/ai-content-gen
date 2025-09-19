import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheManager } from '../../../cache/src/cache-manager.js';

/**
 * Diagram Compiler for Mermaid/PlantUML diagrams
 * Supports multiple diagram formats with SVG output
 */
export class DiagramCompiler {
  private cacheManager: CacheManager;

  constructor(cacheManager: CacheManager) {
    this.cacheManager = cacheManager;
  }

  /**
   * Compile diagram specification to SVG
   */
  async compile(diagramSpec: DiagramSpec, correlationId?: string): Promise<CompilerResult> {
    try {
      // Validate diagram specification
      this.validateDiagramSpec(diagramSpec);

      // Check cache first
      const cacheKey = this.generateCacheKey(diagramSpec);
      const cached = await this.cacheManager.get<string>(cacheKey, 'diagrams');

      if (cached) {
        return {
          success: true,
          svg: cached,
          metadata: {
            compiler: `${diagramSpec.type}-compiler`,
            compilerVersion: '1.0.0',
            cached: true,
            contentHash: cacheKey
          }
        };
      }

      // Compile based on diagram type
      let svg: string;
      switch (diagramSpec.type) {
        case 'mermaid':
          svg = await this.compileMermaid(diagramSpec);
          break;
        case 'plantuml':
          svg = await this.compilePlantUML(diagramSpec);
          break;
        case 'dot':
          svg = await this.compileGraphviz(diagramSpec);
          break;
        default:
          throw new Error(`Unsupported diagram type: ${diagramSpec.type}`);
      }

      // Cache the result
      await this.cacheManager.set(svg, 'diagrams', {
        templateVersion: '1.0.0',
        compiler: `${diagramSpec.type}-compiler`,
        tags: ['diagram', diagramSpec.type],
        ttl: 3600 // 1 hour TTL
      });

      return {
        success: true,
        svg,
        metadata: {
          compiler: `${diagramSpec.type}-compiler`,
          compilerVersion: '1.0.0',
          cached: false,
          contentHash: cacheKey
        }
      };

    } catch (error) {
      return {
        success: false,
        error: {
          code: 'E-COMPILER-DIAGRAM',
          message: error instanceof Error ? error.message : 'Unknown diagram compilation error',
          context: { diagramSpec, correlationId }
        }
      };
    }
  }

  /**
   * Compile Mermaid diagram
   */
  private async compileMermaid(diagramSpec: DiagramSpec): Promise<string> {
    const mermaidCLI = process.env.MERMAID_CLI || 'mmdc';

    // Check if we can use HTTP service first
    const mermaidURL = process.env.MERMAID_URL;
    if (mermaidURL) {
      try {
        return await this.compileMermaidHTTP(diagramSpec, mermaidURL);
      } catch (error) {
        console.warn('Mermaid HTTP service failed, falling back to CLI:', error);
      }
    }

    // Use CLI compilation
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mermaid-'));
    const inputPath = path.join(tmpDir, 'diagram.mmd');
    const outputPath = path.join(tmpDir, 'diagram.svg');

    try {
      // Write mermaid source
      await fs.writeFile(inputPath, diagramSpec.source, 'utf8');

      // Run mermaid CLI
      const result = await this.runCommand(mermaidCLI, [
        '-i', inputPath,
        '-o', outputPath,
        '-t', 'svg',
        '--backgroundColor', 'white'
      ], tmpDir);

      if (result.code !== 0) {
        throw new Error(`Mermaid compilation failed: ${result.stderr}`);
      }

      // Read generated SVG
      const svg = await fs.readFile(outputPath, 'utf8');

      if (!svg.includes('<svg')) {
        throw new Error('Mermaid did not produce valid SVG output');
      }

      return svg;

    } finally {
      // Cleanup
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Compile Mermaid via HTTP service
   */
  private async compileMermaidHTTP(diagramSpec: DiagramSpec, serviceURL: string): Promise<string> {
    const url = `${serviceURL.replace(/\/$/, '')}/svg`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: diagramSpec.source,
        config: diagramSpec.config || {}
      })
    });

    if (!response.ok) {
      throw new Error(`Mermaid HTTP service error: ${response.status} ${response.statusText}`);
    }

    const svg = await response.text();

    if (!svg.includes('<svg')) {
      throw new Error('Mermaid HTTP service did not return valid SVG');
    }

    return svg;
  }

  /**
   * Compile PlantUML diagram
   */
  private async compilePlantUML(diagramSpec: DiagramSpec): Promise<string> {
    const plantumlJar = process.env.PLANTUML_JAR || 'plantuml.jar';

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plantuml-'));
    const inputPath = path.join(tmpDir, 'diagram.puml');
    const outputPath = path.join(tmpDir, 'diagram.svg');

    try {
      // Write PlantUML source
      await fs.writeFile(inputPath, diagramSpec.source, 'utf8');

      // Run PlantUML
      const result = await this.runCommand('java', [
        '-jar', plantumlJar,
        '-tsvg',
        '-o', tmpDir,
        inputPath
      ], tmpDir);

      if (result.code !== 0) {
        throw new Error(`PlantUML compilation failed: ${result.stderr}`);
      }

      // Read generated SVG
      const svg = await fs.readFile(outputPath, 'utf8');

      if (!svg.includes('<svg')) {
        throw new Error('PlantUML did not produce valid SVG output');
      }

      return svg;

    } finally {
      // Cleanup
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Compile Graphviz DOT diagram
   */
  private async compileGraphviz(diagramSpec: DiagramSpec): Promise<string> {
    const dotBin = process.env.GRAPHVIZ_DOT || 'dot';

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphviz-'));
    const inputPath = path.join(tmpDir, 'diagram.dot');
    const outputPath = path.join(tmpDir, 'diagram.svg');

    try {
      // Write DOT source
      await fs.writeFile(inputPath, diagramSpec.source, 'utf8');

      // Run Graphviz
      const result = await this.runCommand(dotBin, [
        '-Tsvg',
        '-o', outputPath,
        inputPath
      ], tmpDir);

      if (result.code !== 0) {
        throw new Error(`Graphviz compilation failed: ${result.stderr}`);
      }

      // Read generated SVG
      const svg = await fs.readFile(outputPath, 'utf8');

      if (!svg.includes('<svg')) {
        throw new Error('Graphviz did not produce valid SVG output');
      }

      return svg;

    } finally {
      // Cleanup
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Validate diagram specification
   */
  private validateDiagramSpec(diagramSpec: DiagramSpec): void {
    if (!diagramSpec.type) {
      throw new Error('Diagram type is required');
    }

    if (!diagramSpec.source || typeof diagramSpec.source !== 'string') {
      throw new Error('Diagram source code is required and must be a string');
    }

    if (diagramSpec.source.length > 100000) {
      throw new Error('Diagram source code is too large (max 100KB)');
    }

    // Type-specific validation
    switch (diagramSpec.type) {
      case 'mermaid':
        this.validateMermaidSource(diagramSpec.source);
        break;
      case 'plantuml':
        this.validatePlantUMLSource(diagramSpec.source);
        break;
      case 'dot':
        this.validateDotSource(diagramSpec.source);
        break;
    }
  }

  /**
   * Validate Mermaid source
   */
  private validateMermaidSource(source: string): void {
    // Basic syntax validation
    const lines = source.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    if (lines.length === 0) {
      throw new Error('Mermaid diagram cannot be empty');
    }

    // Check for dangerous patterns
    const dangerousPatterns = [
      /javascript:/i,
      /data:/i,
      /eval\s*\(/i,
      /<script/i,
      /onclick/i,
      /onerror/i
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(source)) {
        throw new Error('Mermaid diagram contains potentially dangerous content');
      }
    }
  }

  /**
   * Validate PlantUML source
   */
  private validatePlantUMLSource(source: string): void {
    if (!source.includes('@startuml') || !source.includes('@enduml')) {
      throw new Error('PlantUML diagram must start with @startuml and end with @enduml');
    }

    // Check for dangerous patterns
    if (source.includes('!include') || source.includes('!import')) {
      throw new Error('PlantUML include/import directives are not allowed for security');
    }
  }

  /**
   * Validate DOT source
   */
  private validateDotSource(source: string): void {
    // Basic DOT validation
    if (!source.includes('digraph') && !source.includes('graph')) {
      throw new Error('DOT diagram must contain digraph or graph declaration');
    }

    // Check for dangerous patterns
    if (source.includes('URL=') || source.includes('href=')) {
      throw new Error('DOT URL/href attributes are not allowed for security');
    }
  }

  /**
   * Generate cache key for diagram specification
   */
  private generateCacheKey(diagramSpec: DiagramSpec): string {
    const normalizedSpec = {
      type: diagramSpec.type,
      source: diagramSpec.source.trim(),
      config: diagramSpec.config || {},
      title: diagramSpec.title || ''
    };

    const sortedSpec = JSON.stringify(normalizedSpec, Object.keys(normalizedSpec).sort());
    return `sha256:${require('crypto').createHash('sha256').update(sortedSpec).digest('hex')}`;
  }

  /**
   * Run command and return result
   */
  private runCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const process = spawn(cmd, args, { cwd, shell: false });
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        resolve({
          code: code ?? 0,
          stdout,
          stderr
        });
      });
    });
  }

  /**
   * Get compiler information
   */
  getCompilerInfo(): CompilerInfo {
    return {
      name: 'Multi-Format Diagram Compiler',
      version: '1.0.0',
      supportedFormats: ['mermaid', 'plantuml', 'dot'],
      dependencies: ['mermaid-cli', 'plantuml', 'graphviz'],
      outputFormat: 'svg'
    };
  }

  /**
   * Check service health for available diagram compilers
   */
  async checkServiceHealth(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    // Test Mermaid
    try {
      const testResult = await this.compile({
        type: 'mermaid',
        source: 'graph TD\n    A[Start] --> B[End]',
        title: 'Health Check'
      });

      checks.push({
        healthy: testResult.success,
        service: 'mermaid',
        timestamp: new Date().toISOString(),
        error: testResult.error?.message
      });
    } catch (error) {
      checks.push({
        healthy: false,
        service: 'mermaid',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    return checks;
  }
}

// Type definitions
export interface DiagramSpec {
  type: 'mermaid' | 'plantuml' | 'dot';
  source: string;
  config?: Record<string, any>;
  title?: string;
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
  };
}

export interface CompilerInfo {
  name: string;
  version: string;
  supportedFormats: string[];
  dependencies: string[];
  outputFormat: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HealthCheck {
  healthy: boolean;
  service: string;
  timestamp: string;
  error?: string;
}