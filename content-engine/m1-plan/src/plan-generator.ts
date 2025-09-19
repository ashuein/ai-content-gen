import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { PlanRequest, DocPlan, DocPlanPayload, ModuleError, Result, Ok, Err, ValidationResult } from './types.js';
import { BeatValidator } from './beat-validator.js';

/**
 * M1-PlanGenerator: Transforms PlanRequest into structured DocPlan
 * with validated beat dependencies and asset suggestions
 */
export class PlanGenerator {
  private ajv: Ajv;
  private schema: any;

  constructor() {
    this.ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(this.ajv);

    // Load and compile DocPlan schema
    const schemaPath = new URL('../schemas/docplan.v1.schema.json', import.meta.url);
    this.schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    this.ajv.addSchema(this.schema);
  }

  /**
   * Main entry point: generate DocPlan from PlanRequest
   */
  async generatePlan(request: PlanRequest, correlationId: string): Promise<Result<DocPlan, ModuleError[]>> {
    try {
      // Step 1: Generate content using LLM (mock for now)
      const payload = await this.generatePlanContent(request);

      // Step 2: Run validation gates
      const validationResult = await this.validatePlan(payload, correlationId);
      if (!validationResult.valid) {
        return Err(validationResult.errors || []);
      }

      // Step 3: Create versioned envelope
      const envelope = this.createEnvelope(payload, correlationId);

      // Step 4: Final schema validation
      const docPlan: DocPlan = { envelope, payload };
      const schemaValidation = this.validateSchema(docPlan);
      if (!schemaValidation.valid) {
        return Err([{
          code: 'E-M1-SCHEMA-DOCPLAN',
          module: 'M1',
          data: schemaValidation.errors,
          correlationId
        }]);
      }

      return Ok(docPlan);

    } catch (error) {
      return Err([{
        code: 'E-M1-GENERATION-FAILED',
        module: 'M1',
        data: { error: error instanceof Error ? error.message : String(error) },
        correlationId
      }]);
    }
  }

  /**
   * Generate plan content (mock implementation - replace with LLM integration)
   */
  private async generatePlanContent(request: PlanRequest): Promise<DocPlanPayload> {
    // Mock implementation - in production this would call LLM API
    const beats = this.generateMockBeats(request);

    return {
      meta: {
        title: request.title,
        subject: request.subject,
        grade: request.grade,
        difficulty: request.difficulty
      },
      learning_objectives: [
        "Understand fundamental concepts and principles",
        "Apply theoretical knowledge to practical problems",
        "Analyze and interpret experimental results"
      ],
      beats,
      glossary_seed: ["term1", "term2", "term3"],
      misconceptions: ["common error 1", "common error 2"],
      assessment_outline: ["quiz 1", "assignment 1", "final exam"]
    };
  }

  /**
   * Generate mock beats with proper dependency structure
   */
  private generateMockBeats(request: PlanRequest) {
    const baseBeats = [
      {
        id: "beat-introduction",
        headline: "Introduction and Basic Concepts",
        prereqs: [],
        outcomes: ["Define key terms", "Identify core principles"],
        assets_suggested: ["eq:basic-formula", "diagram:concept-map"]
      },
      {
        id: "beat-fundamentals",
        headline: "Fundamental Laws and Equations",
        prereqs: ["beat-introduction"],
        outcomes: ["Apply fundamental equations", "Solve basic problems"],
        assets_suggested: ["eq:main-law", "plot:relationship-graph"]
      },
      {
        id: "beat-applications",
        headline: "Real-World Applications",
        prereqs: ["beat-fundamentals"],
        outcomes: ["Connect theory to practice", "Solve complex problems"],
        assets_suggested: ["widget:parameter-explorer", "chem:molecule-example"]
      },
      {
        id: "beat-advanced",
        headline: "Advanced Topics and Extensions",
        prereqs: ["beat-applications"],
        outcomes: ["Explore advanced concepts", "Prepare for next level"],
        assets_suggested: ["diagram:advanced-system", "plot:complex-relationship"]
      },
      {
        id: "beat-synthesis",
        headline: "Integration and Review",
        prereqs: ["beat-advanced"],
        outcomes: ["Synthesize knowledge", "Apply to novel situations"],
        assets_suggested: ["widget:comprehensive-tool"]
      },
      {
        id: "beat-assessment",
        headline: "Assessment and Evaluation",
        prereqs: ["beat-synthesis"],
        outcomes: ["Demonstrate mastery", "Self-evaluate understanding"],
        assets_suggested: ["eq:challenge-problem"]
      }
    ];

    return baseBeats;
  }

  /**
   * Run validation gates G1-G3 for M1
   */
  private async validatePlan(payload: DocPlanPayload, correlationId: string): Promise<ValidationResult & { errors?: ModuleError[] }> {
    const errors: ModuleError[] = [];

    // G2: Beat dependency graph validation
    const beatValidation = BeatValidator.validateDependencyGraph(payload.beats);
    if (!beatValidation.valid) {
      errors.push({
        code: 'E-M1-BEAT-CYCLES',
        module: 'M1',
        data: beatValidation.data,
        correlationId
      });
    }

    // G3: Asset suggestion format validation
    const assetValidation = BeatValidator.validateAssetSuggestions(payload.beats);
    if (!assetValidation.valid) {
      errors.push({
        code: 'E-M1-ASSET-FORMAT',
        module: 'M1',
        data: assetValidation.data,
        correlationId
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Create versioned envelope with content hash
   */
  private createEnvelope(payload: DocPlanPayload, correlationId: string) {
    const contentHash = this.generateContentHash(payload);

    return {
      version: "1.0.0",
      producer: "M1-PlanGenerator",
      timestamp: new Date().toISOString(),
      correlationId,
      contentHash,
      compatible: ["1.0.0"]
    };
  }

  /**
   * Generate SHA256 content hash for deterministic caching
   */
  private generateContentHash(payload: DocPlanPayload): string {
    const normalized = this.normalizeObject(payload);
    const content = JSON.stringify(normalized);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Normalize object for consistent hashing
   */
  private normalizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return obj.normalize('NFC').replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.normalizeObject(item));
    }
    if (obj && typeof obj === 'object') {
      const sorted: Record<string, any> = {};
      Object.keys(obj).sort().forEach(key => {
        sorted[key] = this.normalizeObject(obj[key]);
      });
      return sorted;
    }
    return obj;
  }

  /**
   * Validate final DocPlan against schema (G1)
   */
  private validateSchema(docPlan: DocPlan): ValidationResult {
    const validate = this.ajv.getSchema('docplan.v1.schema.json');
    if (!validate) {
      return {
        valid: false,
        errors: ['Schema not found']
      };
    }

    const valid = validate(docPlan);
    if (!valid) {
      return {
        valid: false,
        errors: validate.errors
      };
    }

    return { valid: true };
  }
}