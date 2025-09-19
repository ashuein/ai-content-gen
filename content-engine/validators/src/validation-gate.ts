// Core validation gate interface and implementations

export interface ValidationResult {
  valid: boolean;
  errors?: any[];
  data?: any;
}

export interface ValidationGate {
  readonly name: string;
  readonly gateNumber: string; // G1, G2, etc.
  readonly description: string;

  validate(input: any): Promise<ValidationResult>;
}

export interface RepairStrategy {
  readonly name: string;
  readonly maxAttempts: number;

  canRepair(error: any): boolean;
  attemptRepair(input: any, error: any): Promise<{ repaired: any; success: boolean }>;
}

/**
 * Base class for all validation gates
 */
export abstract class BaseValidationGate implements ValidationGate {
  abstract readonly name: string;
  abstract readonly gateNumber: string;
  abstract readonly description: string;

  abstract validate(input: any): Promise<ValidationResult>;

  protected createError(code: string, message: string, data?: any): ValidationResult {
    return {
      valid: false,
      errors: [{ code, message, data }]
    };
  }

  protected createSuccess(data?: any): ValidationResult {
    return {
      valid: true,
      data
    };
  }
}