// M1-Plan module exports

export { PlanGenerator } from './plan-generator.js';
export { BeatValidator } from './beat-validator.js';
export {
  PlanRequest,
  DocPlan,
  DocPlanPayload,
  Beat,
  Envelope,
  ModuleError,
  ValidationResult,
  Result,
  Ok,
  Err
} from './types.js';

// Module interface implementation
export interface ModuleBase<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  readonly compatibleVersions: string[];

  canHandle(envelope: Envelope<TInput>): boolean;
  process(input: Envelope<TInput>): Promise<Result<Envelope<TOutput>, ModuleError[]>>;
  validate(output: Envelope<TOutput>): Promise<ValidationResult>;
}

export interface M1PlanGenerator extends ModuleBase<any, DocPlanPayload> {
  generatePlan(request: any): Promise<Result<DocPlan, ModuleError[]>>;
}

// Default export for the module
export default class M1PlanModule implements M1PlanGenerator {
  readonly name = "M1-PlanGenerator";
  readonly version = "1.0.0";
  readonly compatibleVersions = ["1.0.0"];

  private generator: PlanGenerator;

  constructor() {
    this.generator = new PlanGenerator();
  }

  canHandle(envelope: any): boolean {
    // M1 accepts raw PlanRequest, not enveloped input
    return true;
  }

  async process(input: any): Promise<Result<any, ModuleError[]>> {
    // For M1, input is PlanRequest directly
    const correlationId = this.generateCorrelationId();
    return this.generator.generatePlan(input, correlationId);
  }

  async validate(output: any): Promise<ValidationResult> {
    return { valid: true }; // Validation already done in process()
  }

  async generatePlan(request: any): Promise<Result<DocPlan, ModuleError[]>> {
    const correlationId = this.generateCorrelationId();
    return this.generator.generatePlan(request, correlationId);
  }

  private generateCorrelationId(): string {
    return `ch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}