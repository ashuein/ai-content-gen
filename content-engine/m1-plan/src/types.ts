// Core types for M1-Plan module

export interface PlanRequest {
  title: string;
  subject: "Physics" | "Chemistry" | "Mathematics";
  grade: string;
  difficulty: "comfort" | "hustle" | "advanced";
  chapter_pdf_url?: string;
  reference_materials?: string[];
}

export interface Envelope<T> {
  version: string;
  producer: string;
  timestamp: string;
  correlationId: string;
  contentHash: string;
  compatible?: string[];
}

export interface DocPlanPayload {
  meta: {
    title: string;
    subject: "Physics" | "Chemistry" | "Mathematics";
    grade: string;
    difficulty: "comfort" | "hustle" | "advanced";
  };
  learning_objectives: string[];
  beats: Beat[];
  glossary_seed?: string[];
  misconceptions?: string[];
  assessment_outline?: string[];
}

export interface Beat {
  id: string;
  headline: string;
  prereqs: string[];
  outcomes: string[];
  assets_suggested: string[];
}

export interface DocPlan {
  envelope: Envelope<DocPlanPayload>;
  payload: DocPlanPayload;
}

export type ModuleError = {
  code: string;
  module: string;
  data: any;
  correlationId: string;
};

export type ValidationResult = {
  valid: boolean;
  errors?: any[];
  data?: any;
};

export type Result<T, E> = {
  isSuccess(): this is { value: T };
  isError(): this is { errors: E };
  value?: T;
  errors?: E;
};

export function Ok<T>(value: T): Result<T, never> {
  return {
    isSuccess: () => true,
    isError: () => false,
    value,
  };
}

export function Err<E>(errors: E): Result<never, E> {
  return {
    isSuccess: () => false,
    isError: () => true,
    errors,
  };
}