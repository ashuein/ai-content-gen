import { performance } from 'perf_hooks';
import { PipelineOrchestrator } from '../../fsm/src/pipeline.js';
import { CacheManager } from '../../cache/src/cache-manager.js';
import { ValidationPipeline } from '../../validators/src/validation-pipeline.js';
import type { PlanRequest } from '../../schemas-shared/plan-request.v1.schema.js';

/**
 * Performance Benchmarking Suite for Content Generation Pipeline
 * Measures throughput, latency, and resource utilization under various loads
 */
export class PerformanceBenchmarks {
  private pipeline: PipelineOrchestrator;
  private cacheManager: CacheManager;
  private validationPipeline: ValidationPipeline;

  constructor() {
    this.cacheManager = new CacheManager('./benchmark-cache');
    this.validationPipeline = new ValidationPipeline();
    this.pipeline = new PipelineOrchestrator(this.cacheManager, this.validationPipeline);
  }

  /**
   * Run comprehensive performance benchmark suite
   */
  async runBenchmarks(): Promise<BenchmarkResults> {
    console.log('🚀 Starting Content Engine Performance Benchmarks...\n');

    const results: BenchmarkResults = {
      singleRequest: await this.benchmarkSingleRequest(),
      concurrentRequests: await this.benchmarkConcurrentRequests(),
      cachePerformance: await this.benchmarkCachePerformance(),
      validationGates: await this.benchmarkValidationGates(),
      memoryUsage: await this.benchmarkMemoryUsage(),
      summary: {
        timestamp: new Date().toISOString(),
        environment: this.getEnvironmentInfo()
      }
    };

    this.printResults(results);
    return results;
  }

  /**
   * Benchmark single request processing time
   */
  async benchmarkSingleRequest(): Promise<SingleRequestBenchmark> {
    console.log('📊 Benchmarking single request performance...');

    const testCases: Array<{ name: string; request: PlanRequest }> = [
      {
        name: 'Simple Physics',
        request: this.createTestRequest('physics', 'basic', 1000)
      },
      {
        name: 'Complex Mathematics',
        request: this.createTestRequest('mathematics', 'advanced', 5000)
      },
      {
        name: 'Chemistry with SMILES',
        request: this.createTestRequest('chemistry', 'intermediate', 3000)
      }
    ];

    const results: Record<string, RequestMetrics> = {};

    for (const testCase of testCases) {
      const metrics = await this.measureSingleRequest(testCase.request, testCase.name);
      results[testCase.name] = metrics;
      console.log(`  ✅ ${testCase.name}: ${metrics.totalTime}ms`);
    }

    return { testCases: results };
  }

  /**
   * Benchmark concurrent request handling
   */
  async benchmarkConcurrentRequests(): Promise<ConcurrentBenchmark> {
    console.log('📊 Benchmarking concurrent request handling...');

    const concurrencyLevels = [1, 2, 5, 10];
    const results: Record<number, ConcurrencyMetrics> = {};

    for (const concurrency of concurrencyLevels) {
      const metrics = await this.measureConcurrentRequests(concurrency);
      results[concurrency] = metrics;
      console.log(`  ✅ ${concurrency} concurrent: ${metrics.averageTime}ms avg, ${metrics.throughput} req/s`);
    }

    return { concurrencyLevels: results };
  }

  /**
   * Benchmark cache performance
   */
  async benchmarkCachePerformance(): Promise<CacheBenchmark> {
    console.log('📊 Benchmarking cache performance...');

    // Warm cache first
    await this.warmTestCache();

    const cacheTests = [
      { operation: 'hit', iterations: 1000 },
      { operation: 'miss', iterations: 100 },
      { operation: 'write', iterations: 500 }
    ];

    const results: Record<string, CacheMetrics> = {};

    for (const test of cacheTests) {
      const metrics = await this.measureCacheOperation(test.operation as any, test.iterations);
      results[test.operation] = metrics;
      console.log(`  ✅ Cache ${test.operation}: ${metrics.averageTime}ms avg`);
    }

    const stats = this.cacheManager.getStats();
    return {
      operations: results,
      hitRate: stats.hitRate || 0,
      totalSize: stats.totalSize
    };
  }

  /**
   * Benchmark validation gate performance
   */
  async benchmarkValidationGates(): Promise<ValidationBenchmark> {
    console.log('📊 Benchmarking validation gates...');

    const gates = [
      { name: 'G1-Schema', test: () => this.testSchemaValidation() },
      { name: 'G3-KaTeX', test: () => this.testKaTeXValidation() },
      { name: 'G4-Math', test: () => this.testMathValidation() },
      { name: 'G5-PlotLexer', test: () => this.testPlotLexerValidation() },
      { name: 'G6-SMILES', test: () => this.testSmilesValidation() },
      { name: 'G9-Unicode', test: () => this.testUnicodeValidation() },
      { name: 'G11-Units', test: () => this.testUnitsValidation() }
    ];

    const results: Record<string, ValidationMetrics> = {};

    for (const gate of gates) {
      const metrics = await this.measureValidationGate(gate.test);
      results[gate.name] = metrics;
      console.log(`  ✅ ${gate.name}: ${metrics.averageTime}ms avg`);
    }

    return { gates: results };
  }

  /**
   * Benchmark memory usage patterns
   */
  async benchmarkMemoryUsage(): Promise<MemoryBenchmark> {
    console.log('📊 Benchmarking memory usage...');

    const initialMemory = process.memoryUsage();
    const memorySnapshots: MemorySnapshot[] = [
      { stage: 'initial', ...initialMemory, timestamp: Date.now() }
    ];

    // Process requests and take memory snapshots
    const request = this.createTestRequest('physics', 'intermediate', 2000);

    for (let i = 0; i < 10; i++) {
      await this.pipeline.execute(request, `memory-test-${i}`);

      if (i % 2 === 0) {
        const memory = process.memoryUsage();
        memorySnapshots.push({
          stage: `request-${i}`,
          ...memory,
          timestamp: Date.now()
        });
      }
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      const gcMemory = process.memoryUsage();
      memorySnapshots.push({
        stage: 'post-gc',
        ...gcMemory,
        timestamp: Date.now()
      });
    }

    const peakHeapUsed = Math.max(...memorySnapshots.map(s => s.heapUsed));
    const memoryGrowth = memorySnapshots[memorySnapshots.length - 1].heapUsed - initialMemory.heapUsed;

    return {
      snapshots: memorySnapshots,
      peakHeapUsed,
      memoryGrowth,
      recommendedHeapSize: Math.ceil(peakHeapUsed * 1.5 / 1024 / 1024) // MB with 50% buffer
    };
  }

  /**
   * Measure single request performance
   */
  private async measureSingleRequest(request: PlanRequest, testName: string): Promise<RequestMetrics> {
    const startTime = performance.now();
    const startMemory = process.memoryUsage();

    const result = await this.pipeline.execute(request, `benchmark-${testName.toLowerCase().replace(/\s+/g, '-')}`);

    const endTime = performance.now();
    const endMemory = process.memoryUsage();

    return {
      totalTime: Math.round(endTime - startTime),
      success: result.success,
      memoryDelta: endMemory.heapUsed - startMemory.heapUsed,
      cacheHits: this.cacheManager.getStats().hits,
      validationsPassed: result.success ? 1 : 0
    };
  }

  /**
   * Measure concurrent request performance
   */
  private async measureConcurrentRequests(concurrency: number): Promise<ConcurrencyMetrics> {
    const requests = Array.from({ length: concurrency }, (_, i) =>
      this.createTestRequest('physics', 'intermediate', 1500)
    );

    const startTime = performance.now();

    const results = await Promise.all(
      requests.map((request, i) =>
        this.pipeline.execute(request, `concurrent-${concurrency}-${i}`)
      )
    );

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    const successCount = results.filter(r => r.success).length;

    return {
      totalTime: Math.round(totalTime),
      averageTime: Math.round(totalTime / concurrency),
      successRate: successCount / concurrency,
      throughput: Math.round((concurrency / totalTime) * 1000) // requests per second
    };
  }

  /**
   * Measure cache operation performance
   */
  private async measureCacheOperation(operation: 'hit' | 'miss' | 'write', iterations: number): Promise<CacheMetrics> {
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const startTime = performance.now();

      switch (operation) {
        case 'hit':
          await this.cacheManager.get('test-content-hash', 'math');
          break;
        case 'miss':
          await this.cacheManager.get(`non-existent-${i}`, 'math');
          break;
        case 'write':
          await this.cacheManager.set({ test: `data-${i}` }, 'math');
          break;
      }

      const endTime = performance.now();
      times.push(endTime - startTime);
    }

    times.sort((a, b) => a - b);

    return {
      averageTime: Math.round(times.reduce((sum, t) => sum + t, 0) / times.length),
      medianTime: Math.round(times[Math.floor(times.length / 2)]),
      p95Time: Math.round(times[Math.floor(times.length * 0.95)]),
      minTime: Math.round(times[0]),
      maxTime: Math.round(times[times.length - 1])
    };
  }

  /**
   * Measure validation gate performance
   */
  private async measureValidationGate(testFn: () => Promise<any>): Promise<ValidationMetrics> {
    const iterations = 100;
    const times: number[] = [];
    let successCount = 0;

    for (let i = 0; i < iterations; i++) {
      const startTime = performance.now();

      try {
        const result = await testFn();
        if (result && result.valid) {
          successCount++;
        }
      } catch (error) {
        // Count as failure
      }

      const endTime = performance.now();
      times.push(endTime - startTime);
    }

    times.sort((a, b) => a - b);

    return {
      averageTime: Math.round(times.reduce((sum, t) => sum + t, 0) / times.length),
      successRate: successCount / iterations,
      p95Time: Math.round(times[Math.floor(times.length * 0.95)])
    };
  }

  /**
   * Create standardized test request
   */
  private createTestRequest(subject: string, difficulty: string, length: number): PlanRequest {
    return {
      subjectArea: subject,
      topicTitle: `Benchmark Test - ${subject}`,
      difficultyLevel: difficulty as any,
      estimatedLength: length,
      learningObjectives: ['Test objective 1', 'Test objective 2'],
      targetAudience: 'undergraduate',
      prerequisites: ['basic_knowledge'],
      contentGuidelines: {
        includeExamples: true,
        includeExercises: false,
        visualAids: ['diagrams'],
        mathematicalRigor: 'moderate'
      }
    };
  }

  /**
   * Warm cache with test data
   */
  private async warmTestCache(): Promise<void> {
    const testContent = [
      { content: { tex: 'E = mc^2' }, type: 'math' as const },
      { content: { expr: 'x^2 + 1' }, type: 'plots' as const },
      { content: { smiles: 'CCO' }, type: 'chem' as const }
    ];

    await this.cacheManager.warmCache(testContent);
  }

  /**
   * Test validation gates
   */
  private async testSchemaValidation() {
    const { AjvValidationGate } = await import('../../validators/src/ajv-validator.js');
    const gate = new AjvValidationGate();
    return gate.validate({ data: { test: 'value' }, schemaName: 'test.schema.json' });
  }

  private async testKaTeXValidation() {
    const { KatexValidationGate } = await import('../../validators/src/katex-validator.js');
    const gate = new KatexValidationGate();
    return gate.validate({ tex: 'E = mc^2', context: 'benchmark' });
  }

  private async testMathValidation() {
    const { MathValidationGate } = await import('../../validators/src/math-validator.js');
    const gate = new MathValidationGate();
    return gate.validate({
      expression: 'x^2 + 1',
      variables: { x: { min: -5, max: 5, type: 'real' } },
      expectedForm: 'polynomial'
    });
  }

  private async testPlotLexerValidation() {
    const { PlotLexerValidationGate } = await import('../../validators/src/plot-lexer-validator.js');
    const gate = new PlotLexerValidationGate();
    return gate.validate({ expr: 'sin(x)', context: 'benchmark' });
  }

  private async testSmilesValidation() {
    const { SmilesValidationGate } = await import('../../validators/src/smiles-validator.js');
    const gate = new SmilesValidationGate();
    return gate.validate({ smiles: 'CCO', context: 'benchmark' });
  }

  private async testUnicodeValidation() {
    const { UnicodeSanitizerGate } = await import('../../validators/src/unicode-sanitizer.js');
    const gate = new UnicodeSanitizerGate();
    return gate.validate({ text: 'Test content', mode: 'strict', context: 'benchmark' });
  }

  private async testUnitsValidation() {
    const { UnitsValidationGate } = await import('../../validators/src/units-validator.js');
    const gate = new UnitsValidationGate();
    return gate.validate({
      expression: 'F = ma',
      variables: {
        F: { unit: 'N', dimension: 'force' },
        m: { unit: 'kg', dimension: 'mass' },
        a: { unit: 'm/s^2', dimension: 'acceleration' }
      }
    });
  }

  /**
   * Get environment information
   */
  private getEnvironmentInfo(): EnvironmentInfo {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: require('os').cpus().length,
      totalMemory: require('os').totalmem(),
      freeMemory: require('os').freemem()
    };
  }

  /**
   * Print benchmark results
   */
  private printResults(results: BenchmarkResults): void {
    console.log('\n🎯 BENCHMARK RESULTS SUMMARY');
    console.log('=' .repeat(50));

    // Single request performance
    console.log('\n📊 Single Request Performance:');
    Object.entries(results.singleRequest.testCases).forEach(([name, metrics]) => {
      console.log(`  ${name}: ${metrics.totalTime}ms (${metrics.success ? 'SUCCESS' : 'FAILED'})`);
    });

    // Concurrent performance
    console.log('\n🔀 Concurrent Request Performance:');
    Object.entries(results.concurrentRequests.concurrencyLevels).forEach(([level, metrics]) => {
      console.log(`  ${level} concurrent: ${metrics.throughput} req/s, ${metrics.successRate * 100}% success`);
    });

    // Cache performance
    console.log('\n💾 Cache Performance:');
    console.log(`  Hit Rate: ${results.cachePerformance.hitRate}%`);
    Object.entries(results.cachePerformance.operations).forEach(([op, metrics]) => {
      console.log(`  ${op}: ${metrics.averageTime}ms avg (p95: ${metrics.p95Time}ms)`);
    });

    // Memory usage
    console.log('\n🧠 Memory Usage:');
    console.log(`  Peak Heap: ${Math.round(results.memoryUsage.peakHeapUsed / 1024 / 1024)}MB`);
    console.log(`  Memory Growth: ${Math.round(results.memoryUsage.memoryGrowth / 1024 / 1024)}MB`);
    console.log(`  Recommended Heap: ${results.memoryUsage.recommendedHeapSize}MB`);

    // Environment
    console.log('\n🖥️  Environment:');
    console.log(`  Node.js: ${results.summary.environment.nodeVersion}`);
    console.log(`  Platform: ${results.summary.environment.platform} (${results.summary.environment.arch})`);
    console.log(`  CPUs: ${results.summary.environment.cpuCount}`);
    console.log(`  Memory: ${Math.round(results.summary.environment.totalMemory / 1024 / 1024 / 1024)}GB total`);

    console.log('\n✅ Benchmarks completed successfully!');
  }
}

// Type definitions for benchmark results
interface BenchmarkResults {
  singleRequest: SingleRequestBenchmark;
  concurrentRequests: ConcurrentBenchmark;
  cachePerformance: CacheBenchmark;
  validationGates: ValidationBenchmark;
  memoryUsage: MemoryBenchmark;
  summary: {
    timestamp: string;
    environment: EnvironmentInfo;
  };
}

interface SingleRequestBenchmark {
  testCases: Record<string, RequestMetrics>;
}

interface ConcurrentBenchmark {
  concurrencyLevels: Record<number, ConcurrencyMetrics>;
}

interface CacheBenchmark {
  operations: Record<string, CacheMetrics>;
  hitRate: number;
  totalSize: number;
}

interface ValidationBenchmark {
  gates: Record<string, ValidationMetrics>;
}

interface MemoryBenchmark {
  snapshots: MemorySnapshot[];
  peakHeapUsed: number;
  memoryGrowth: number;
  recommendedHeapSize: number;
}

interface RequestMetrics {
  totalTime: number;
  success: boolean;
  memoryDelta: number;
  cacheHits: number;
  validationsPassed: number;
}

interface ConcurrencyMetrics {
  totalTime: number;
  averageTime: number;
  successRate: number;
  throughput: number;
}

interface CacheMetrics {
  averageTime: number;
  medianTime: number;
  p95Time: number;
  minTime: number;
  maxTime: number;
}

interface ValidationMetrics {
  averageTime: number;
  successRate: number;
  p95Time: number;
}

interface MemorySnapshot {
  stage: string;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  timestamp: number;
}

interface EnvironmentInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuCount: number;
  totalMemory: number;
  freeMemory: number;
}

// CLI runner for benchmarks
if (require.main === module) {
  const benchmarks = new PerformanceBenchmarks();
  benchmarks.runBenchmarks()
    .then(results => {
      console.log('\n📄 Results saved to benchmark-results.json');
      require('fs').writeFileSync(
        'benchmark-results.json',
        JSON.stringify(results, null, 2)
      );
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Benchmark failed:', error);
      process.exit(1);
    });
}