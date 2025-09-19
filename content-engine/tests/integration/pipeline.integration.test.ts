import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ContentPipeline } from '../../fsm/src/pipeline.js';
import { CacheManager } from '../../cache/src/cache-manager.js';
import type { PlanRequest } from '../../schemas-shared/plan-request.v1.schema.js';

/**
 * Integration Tests for Complete Content Generation Pipeline
 * Tests end-to-end functionality from PlanRequest to Reader DocJSON
 */
describe('Content Generation Pipeline Integration', () => {
  let pipeline: ContentPipeline;
  let cacheManager: CacheManager;

  beforeAll(async () => {
    // Initialize test infrastructure
    cacheManager = new CacheManager('./test-cache');
    pipeline = new ContentPipeline('./test-output');

    // Warm cache with test data
    await cacheManager.warmCache([
      {
        content: { tex: 'E = mc^2', rendered: 'energy-mass-equation' },
        type: 'math',
        metadata: { tags: ['physics', 'test'] }
      }
    ]);
  });

  afterAll(async () => {
    // Cleanup test cache
    await cacheManager.clearType('math');
    await cacheManager.clearType('plots');
    await cacheManager.clearType('chem');
  });

  describe('Complete Pipeline Execution', () => {
    it('should successfully process a simple physics chapter request', async () => {
      const request: PlanRequest = {
        subjectArea: 'physics',
        topicTitle: 'Newton\'s Laws of Motion',
        difficultyLevel: 'intermediate',
        estimatedLength: 2500,
        learningObjectives: [
          'Understand Newton\'s First Law',
          'Apply Newton\'s Second Law',
          'Analyze Newton\'s Third Law'
        ],
        targetAudience: 'undergraduate',
        prerequisites: ['basic_mechanics', 'algebra'],
        contentGuidelines: {
          includeExamples: true,
          includeExercises: true,
          visualAids: ['diagrams', 'plots'],
          mathematicalRigor: 'moderate'
        }
      };

      const result = await pipeline.execute(request);

      expect(result.status).toBe('SUCCESS');
      expect(result.moduleResults).toBeDefined();

      if (result.status === 'SUCCESS' && result.moduleResults?.m4) {
        const assemblyResult = result.moduleResults.m4;

        // Verify Reader DocJSON structure
        expect(assemblyResult.readerDocJSON.metadata).toBeDefined();
        expect(assemblyResult.readerDocJSON.metadata.title).toBe('Newton\'s Laws of Motion');
        expect(assemblyResult.readerDocJSON.metadata.subjectArea).toBe('physics');

        // Verify sections exist
        expect(assemblyResult.readerDocJSON.sections).toBeDefined();
        expect(assemblyResult.readerDocJSON.sections.length).toBeGreaterThan(0);

        // Verify at least one mathematical expression
        const mathSections = assemblyResult.readerDocJSON.sections.filter(s =>
          s.blocks.some(b => b.type === 'equation')
        );
        expect(mathSections.length).toBeGreaterThan(0);

        // Verify assets were generated
        expect(assemblyResult.assetFiles).toBeDefined();
        expect(assemblyResult.assetFiles.length).toBeGreaterThan(0);
      }
    }, 30000); // 30 second timeout for full pipeline

    it('should successfully process a chemistry chapter with SMILES validation', async () => {
      const request: PlanRequest = {
        subjectArea: 'chemistry',
        topicTitle: 'Organic Molecule Structure',
        difficultyLevel: 'advanced',
        estimatedLength: 3000,
        learningObjectives: [
          'Understand SMILES notation',
          'Analyze molecular structures',
          'Predict chemical properties'
        ],
        targetAudience: 'graduate',
        prerequisites: ['organic_chemistry', 'molecular_structure'],
        contentGuidelines: {
          includeExamples: true,
          includeExercises: false,
          visualAids: ['molecular_diagrams'],
          mathematicalRigor: 'high'
        }
      };

      const result = await pipeline.execute(request);

      expect(result.status).toBe('SUCCESS');

      if (result.status === 'SUCCESS' && result.moduleResults?.m4) {
        const assemblyResult = result.moduleResults.m4;

        // Verify chemistry-specific content
        const chemSections = assemblyResult.readerDocJSON.sections.filter(s =>
          s.blocks.some(b => b.type === 'chemistry')
        );
        expect(chemSections.length).toBeGreaterThan(0);

        // Verify SMILES validation passed
        const chemBlocks = assemblyResult.readerDocJSON.sections.flatMap(s =>
          s.blocks.filter(b => b.type === 'chemistry')
        );

        for (const block of chemBlocks) {
          if (block.type === 'chemistry') {
            expect(block.data.smiles).toBeDefined();
            expect(typeof block.data.smiles).toBe('string');
            expect(block.data.smiles.length).toBeGreaterThan(0);
          }
        }
      }
    }, 35000);

    it('should handle mathematics chapter with complex expressions', async () => {
      const request: PlanRequest = {
        subjectArea: 'mathematics',
        topicTitle: 'Calculus Fundamentals',
        difficultyLevel: 'intermediate',
        estimatedLength: 4000,
        learningObjectives: [
          'Master derivative rules',
          'Understand integration techniques',
          'Apply fundamental theorem of calculus'
        ],
        targetAudience: 'undergraduate',
        prerequisites: ['algebra', 'trigonometry'],
        contentGuidelines: {
          includeExamples: true,
          includeExercises: true,
          visualAids: ['plots', 'diagrams'],
          mathematicalRigor: 'high'
        }
      };

      const result = await pipeline.execute(request);

      expect(result.status).toBe('SUCCESS');

      if (result.status === 'SUCCESS' && result.moduleResults?.m4) {
        const assemblyResult = result.moduleResults.m4;

        // Verify mathematical content
        const mathBlocks = assemblyResult.readerDocJSON.sections.flatMap(s =>
          s.blocks.filter(b => b.type === 'equation')
        );
        expect(mathBlocks.length).toBeGreaterThan(0);

        // Verify plot content
        const plotBlocks = assemblyResult.readerDocJSON.sections.flatMap(s =>
          s.blocks.filter(b => b.type === 'plot')
        );
        expect(plotBlocks.length).toBeGreaterThan(0);

        // Verify KaTeX validation passed
        for (const block of mathBlocks) {
          if (block.type === 'equation') {
            expect(block.data.tex).toBeDefined();
            expect(typeof block.data.tex).toBe('string');
          }
        }
      }
    }, 40000);

    it('should handle validation failures gracefully', async () => {
      const invalidRequest: PlanRequest = {
        subjectArea: 'physics',
        topicTitle: '', // Invalid: empty title
        difficultyLevel: 'intermediate',
        estimatedLength: -100, // Invalid: negative length
        learningObjectives: [], // Invalid: no objectives
        targetAudience: 'undergraduate',
        prerequisites: ['basic_mechanics'],
        contentGuidelines: {
          includeExamples: true,
          includeExercises: false,
          visualAids: [],
          mathematicalRigor: 'moderate'
        }
      };

      const result = await pipeline.execute(invalidRequest);

      expect(result.status).toBe('CRITICAL_FAILURE');
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);

      // Verify error details contain validation information
      const validationErrors = result.errors.filter(e =>
        e.code.includes('VALIDATION')
      );
      expect(validationErrors.length).toBeGreaterThan(0);
    });
  });

  describe('Module Independence Verification', () => {
    it('should demonstrate M1-Plan module independence', async () => {
      const { PlanGenerator } = await import('../../m1-plan/src/plan-generator.js');
      const planGenerator = new PlanGenerator();

      const request: PlanRequest = {
        subjectArea: 'physics',
        topicTitle: 'Thermodynamics',
        difficultyLevel: 'intermediate',
        estimatedLength: 2000,
        learningObjectives: ['Understand heat transfer'],
        targetAudience: 'undergraduate',
        prerequisites: ['basic_physics'],
        contentGuidelines: {
          includeExamples: true,
          includeExercises: false,
          visualAids: ['diagrams'],
          mathematicalRigor: 'moderate'
        }
      };

      const result = await planGenerator.generatePlan(request, 'test-m1-001');

      expect(result.isSuccess()).toBe(true);
      if (result.isSuccess()) {
        expect(result.value.version).toBe('1.0.0');
        expect(result.value.payload.beats).toBeDefined();
        expect(result.value.payload.beats.length).toBeGreaterThan(0);
      }
    });

    it('should demonstrate M2-Scaffold module independence', async () => {
      const { ScaffoldGenerator } = await import('../../m2-scaffold/src/scaffold-generator.js');
      const scaffoldGenerator = new ScaffoldGenerator();

      // Create mock DocPlan
      const mockDocPlan = {
        version: '1.0.0' as const,
        payload: {
          title: 'Test Chapter',
          beats: [
            {
              id: 'beat-1',
              title: 'Introduction',
              description: 'Chapter introduction',
              contentType: 'text' as const,
              estimatedLength: 500,
              dependencies: [],
              learningObjectives: ['Understand basics'],
              difficultyLevel: 'beginner' as const
            }
          ],
          metadata: {
            subjectArea: 'physics',
            targetAudience: 'undergraduate',
            estimatedLength: 2000,
            difficultyLevel: 'intermediate' as const
          }
        }
      };

      const result = await scaffoldGenerator.generateScaffold(
        { version: '1.0.0', payload: mockDocPlan },
        'test-m2-001'
      );

      expect(result.isSuccess()).toBe(true);
      if (result.isSuccess()) {
        expect(result.value.version).toBe('1.0.0');
        expect(result.value.payload.sections).toBeDefined();
      }
    });

    it('should demonstrate adapter pattern decoupling', async () => {
      const { ScaffoldToContextAdapter } = await import('../../adapters/src/scaffold-to-context.js');
      const adapter = new ScaffoldToContextAdapter();

      const mockScaffold = {
        title: 'Test Chapter',
        sections: [
          {
            id: 'section-1',
            title: 'Test Section',
            beats: ['beat-1'],
            estimatedLength: 1000,
            contentBlocks: [
              {
                type: 'paragraph' as const,
                content: 'Test content',
                dependencies: []
              }
            ]
          }
        ],
        metadata: {
          totalLength: 1000,
          sectionCount: 1,
          beatMapping: new Map([['beat-1', 'section-1']])
        }
      };

      const contexts = adapter.transform(mockScaffold);

      expect(contexts).toBeDefined();
      expect(contexts.length).toBe(1);
      expect(contexts[0].sectionId).toBe('section-1');
      expect(contexts[0].title).toBe('Test Section');
    });
  });

  describe('Validation Gate Integration', () => {
    it('should validate mathematical expressions through G4 gate', async () => {
      const { MathValidationGate } = await import('../../validators/src/math-validator.js');
      const mathGate = new MathValidationGate();

      const validExpression = {
        expression: 'x^2 + 2*x + 1',
        variables: { x: { min: -10, max: 10, type: 'real' as const } },
        expectedForm: 'polynomial',
        context: 'integration-test'
      };

      const result = await mathGate.validate(validExpression);

      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.trialsRun).toBeGreaterThanOrEqual(5);
        expect(result.data.successRate).toBeGreaterThanOrEqual(0.8);
      }
    });

    it('should validate SMILES strings through G6 gate', async () => {
      const { SmilesValidationGate } = await import('../../validators/src/smiles-validator.js');
      const smilesGate = new SmilesValidationGate();

      const validSmiles = {
        smiles: 'CCO', // Ethanol
        context: 'integration-test'
      };

      const result = await smilesGate.validate(validSmiles);

      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.molecularFormula).toBeDefined();
        expect(result.data.atomCount).toBeGreaterThan(0);
      }
    });

    it('should validate Unicode content through G9 gate', async () => {
      const { UnicodeSanitizerGate } = await import('../../validators/src/unicode-sanitizer.js');
      const unicodeGate = new UnicodeSanitizerGate();

      const testText = {
        text: 'Physics equation: F = ma (force equals mass times acceleration)',
        mode: 'strict' as const,
        context: 'integration-test'
      };

      const result = await unicodeGate.validate(testText);

      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      if (result.data) {
        expect(result.data.sanitizedText).toBeDefined();
        expect(result.data.securityAnalysis).toBeDefined();
      }
    });
  });

  describe('Cache Integration', () => {
    it('should demonstrate deterministic caching behavior', async () => {
      const testContent = {
        type: 'equation',
        tex: '\\frac{d}{dx}(x^2) = 2x',
        variables: ['x']
      };

      // First cache operation
      const hash1 = await cacheManager.set(testContent, 'math', {
        templateVersion: '1.0.0',
        tags: ['calculus', 'integration-test']
      });

      // Second cache operation with identical content
      const hash2 = await cacheManager.set(testContent, 'math', {
        templateVersion: '1.0.0',
        tags: ['calculus', 'integration-test']
      });

      // Hashes should be identical (deterministic)
      expect(hash1).toBe(hash2);

      // Verify retrieval
      const retrieved = await cacheManager.get(hash1, 'math');
      expect(retrieved).toEqual(testContent);
    });

    it('should handle cache warming for production scenarios', async () => {
      const { CacheWarmer } = await import('../../cache/src/cache-manager.js');
      const warmer = new CacheWarmer(cacheManager);

      const mathHashes = await warmer.warmMathCache();
      const plotHashes = await warmer.warmPlotCache();

      expect(mathHashes.length).toBeGreaterThan(0);
      expect(plotHashes.length).toBeGreaterThan(0);

      // Verify cache hits
      const stats = cacheManager.getStats();
      expect(stats.writes).toBeGreaterThan(0);
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle LLM API failures gracefully', async () => {
      // Simulate LLM API failure by providing invalid context
      const request: PlanRequest = {
        subjectArea: 'invalid_subject',
        topicTitle: 'Test Failure Handling',
        difficultyLevel: 'intermediate',
        estimatedLength: 1000,
        learningObjectives: ['Test error handling'],
        targetAudience: 'undergraduate',
        prerequisites: [],
        contentGuidelines: {
          includeExamples: false,
          includeExercises: false,
          visualAids: [],
          mathematicalRigor: 'low'
        }
      };

      const result = await pipeline.execute(request);

      // Should fail gracefully with descriptive errors
      expect(result.status).toBe('CRITICAL_FAILURE');
      expect(result.errors).toBeDefined();
      expect(result.errors.some(e => e.code.includes('INVALID'))).toBe(true);
    });

    it('should maintain correlation ID tracking through failures', async () => {
      const correlationId = 'test-correlation-tracking';

      const invalidRequest: PlanRequest = {
        subjectArea: 'physics',
        topicTitle: 'Test',
        difficultyLevel: 'intermediate',
        estimatedLength: -1, // Invalid
        learningObjectives: [],
        targetAudience: 'undergraduate',
        prerequisites: [],
        contentGuidelines: {
          includeExamples: false,
          includeExercises: false,
          visualAids: [],
          mathematicalRigor: 'low'
        }
      };

      const result = await pipeline.execute(invalidRequest);

      expect(result.status).toBe('CRITICAL_FAILURE');
      expect(result.correlationId).toBeDefined();

      // All errors should contain correlation ID
      for (const error of result.errors) {
        expect(error.correlationId || error.context?.correlationId).toBeDefined();
      }
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle concurrent requests efficiently', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => ({
        subjectArea: 'physics' as const,
        topicTitle: `Concurrent Test ${i + 1}`,
        difficultyLevel: 'beginner' as const,
        estimatedLength: 1000,
        learningObjectives: [`Objective ${i + 1}`],
        targetAudience: 'undergraduate' as const,
        prerequisites: [],
        contentGuidelines: {
          includeExamples: false,
          includeExercises: false,
          visualAids: [],
          mathematicalRigor: 'low' as const
        }
      }));

      const startTime = Date.now();

      const results = await Promise.all(
        requests.map((request, i) =>
          pipeline.execute(request)
        )
      );

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      // All requests should complete
      expect(results.length).toBe(5);

      // Performance should be reasonable (less than 60 seconds for 5 concurrent requests)
      expect(totalTime).toBeLessThan(60000);

      // At least some should succeed (allowing for test environment limitations)
      const successCount = results.filter(r => r.status === 'SUCCESS').length;
      expect(successCount).toBeGreaterThan(0);
    }, 65000);
  });
});