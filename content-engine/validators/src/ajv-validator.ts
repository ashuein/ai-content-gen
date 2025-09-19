import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { BaseValidationGate, ValidationResult } from './validation-gate.js';

/**
 * G1: AJV Schema Validation Gate
 * Validates JSON objects against their JSON Schema definitions
 */
export class AjvValidationGate extends BaseValidationGate {
  readonly name = "AJV Schema Validator";
  readonly gateNumber = "G1";
  readonly description = "Validates JSON objects against JSON Schema with strict validation rules";

  private ajv: Ajv;
  private schemas: Map<string, any> = new Map();

  constructor() {
    super();
    this.ajv = new Ajv({
      strict: true,
      allErrors: true,
      removeAdditional: false,
      useDefaults: false,
      coerceTypes: false
    });
    addFormats(this.ajv);
  }

  /**
   * Register a schema for validation
   */
  registerSchema(schemaId: string, schema: any): void {
    this.schemas.set(schemaId, schema);
    this.ajv.addSchema(schema, schemaId);
  }

  /**
   * Validate object against a specific schema
   */
  async validate(input: { data: any; schemaId: string }): Promise<ValidationResult> {
    const { data, schemaId } = input;

    if (!this.schemas.has(schemaId)) {
      return this.createError(
        'E-G1-SCHEMA-NOT-FOUND',
        `Schema not found: ${schemaId}`,
        { schemaId, availableSchemas: Array.from(this.schemas.keys()) }
      );
    }

    const validate = this.ajv.getSchema(schemaId);
    if (!validate) {
      return this.createError(
        'E-G1-VALIDATOR-NOT-FOUND',
        `Validator not compiled for schema: ${schemaId}`,
        { schemaId }
      );
    }

    const valid = validate(data);

    if (!valid) {
      const formattedErrors = this.formatAjvErrors(validate.errors || []);
      return this.createError(
        'E-G1-SCHEMA-VALIDATION',
        'Object does not conform to schema',
        {
          schemaId,
          errors: formattedErrors,
          rawErrors: validate.errors
        }
      );
    }

    return this.createSuccess({
      schemaId,
      message: 'Object validates successfully against schema'
    });
  }

  /**
   * Format AJV errors for better readability
   */
  private formatAjvErrors(errors: any[]): Array<{
    path: string;
    message: string;
    value: any;
    constraint: any;
  }> {
    return errors.map(error => ({
      path: error.instancePath || 'root',
      message: error.message || 'Unknown validation error',
      value: error.data,
      constraint: error.params || {}
    }));
  }

  /**
   * Validate with detailed error context
   */
  async validateWithContext(
    data: any,
    schemaId: string,
    context: { module: string; correlationId: string }
  ): Promise<ValidationResult> {
    const result = await this.validate({ data, schemaId });

    if (!result.valid && result.errors) {
      // Enhance errors with context
      result.errors = result.errors.map(error => ({
        ...error,
        context: {
          module: context.module,
          correlationId: context.correlationId,
          timestamp: new Date().toISOString()
        }
      }));
    }

    return result;
  }

  /**
   * Batch validate multiple objects
   */
  async validateBatch(items: Array<{ data: any; schemaId: string; id?: string }>): Promise<{
    allValid: boolean;
    results: Array<{ id?: string; valid: boolean; errors?: any[] }>;
  }> {
    const results = [];
    let allValid = true;

    for (const item of items) {
      const result = await this.validate(item);
      results.push({
        id: item.id,
        valid: result.valid,
        errors: result.errors
      });

      if (!result.valid) {
        allValid = false;
      }
    }

    return { allValid, results };
  }
}