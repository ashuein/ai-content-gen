// Core types for M2-Scaffold module

import { DocPlan, DocPlanPayload } from '@content-engine/m1-plan';

export interface Envelope<T> {
  version: string;
  producer: string;
  timestamp: string;
  correlationId: string;
  contentHash: string;
  compatible?: string[];
}

export interface ScaffoldSection {
  id: string;
  title: string;
  beatIds: string[];
  where_assets_go: string[];
  transitions: {
    in: string;
    out: string;
  };
  concept_sequence: string[];
  estimated_length?: number;
}

export interface ScaffoldPayload {
  meta: {
    title: string;
    subject: "Physics" | "Chemistry" | "Mathematics";
    grade: string;
    difficulty: "comfort" | "hustle" | "advanced";
    chapterSlug: string;
  };
  sections: ScaffoldSection[];
  global_context?: {
    learning_objectives?: string[];
    prerequisite_knowledge?: string[];
    common_misconceptions?: string[];
    assessment_strategy?: string;
  };
}

export interface Scaffold {
  envelope: Envelope<ScaffoldPayload>;
  payload: ScaffoldPayload;
}

export interface SectionContextPayload {
  context: {
    chapterId: string;
    sectionId: string;
    sectionTitle: string;
    difficulty: "comfort" | "hustle" | "advanced";
    subject: "Physics" | "Chemistry" | "Mathematics";
    assetMarkers: string[];
    transitions: {
      in: string;
      out: string;
    };
    conceptSequence: string[];
  };
  runningState: {
    recap_150w: string;
    introduced_terms?: string[];
    used_assets?: Array<{
      id: string;
      type: "eq" | "plot" | "diagram" | "widget" | "chem";
      contentHash: string;
    }>;
    open_threads?: string[];
    style_guard: {
      difficulty: "comfort" | "hustle" | "advanced";
      tone?: string;
    };
  };
}

export interface SectionContext {
  envelope: Envelope<SectionContextPayload>;
  payload: SectionContextPayload;
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