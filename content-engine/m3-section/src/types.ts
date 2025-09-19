// Core types for M3-Section module

export interface Envelope<T> {
  version: string;
  producer: string;
  timestamp: string;
  correlationId: string;
  contentHash: string;
  compatible?: string[];
}

export interface SectionContext {
  envelope: Envelope<SectionContextPayload>;
  payload: SectionContextPayload;
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

export interface ContentBlock {
  type: "prose" | "equation" | "plot" | "diagram" | "chemistry" | "widget";
  id: string;
  [key: string]: any;
}

export interface ProseBlock extends ContentBlock {
  type: "prose";
  markdown: string;
  wordCount?: number;
}

export interface EquationBlock extends ContentBlock {
  type: "equation";
  tex: string;
  check: {
    vars: Record<string, number>;
    expr: string;
    expect: number;
    tol: number;
  };
  caption?: string;
}

export interface PlotBlock extends ContentBlock {
  type: "plot";
  specRef: string;
  caption?: string;
}

export interface DiagramBlock extends ContentBlock {
  type: "diagram";
  specRef: string;
  caption?: string;
}

export interface ChemistryBlock extends ContentBlock {
  type: "chemistry";
  smiles: string;
  caption?: string;
}

export interface WidgetBlock extends ContentBlock {
  type: "widget";
  specRef: string;
  caption?: string;
}

export interface GeneratedAsset {
  id: string;
  type: "plot" | "diagram" | "widget" | "chemistry";
  specPath: string;
  contentHash: string;
  spec?: any; // The actual specification object
  compiledSvg?: string; // Compiled SVG content from asset compilers
}

export interface ValidationReport {
  gatesPassed: string[];
  gatesFailed: string[];
  warnings?: string[];
  repairActions?: string[];
  processingTime?: number;
}

export interface SectionDocPayload {
  sectionMeta: {
    sectionId: string;
    title: string;
    chapterId: string;
    difficulty: "comfort" | "hustle" | "advanced";
    subject: "Physics" | "Chemistry" | "Mathematics";
    estimatedReadTime?: number;
  };
  content: ContentBlock[];
  generatedAssets: GeneratedAsset[];
  validationReport: ValidationReport;
  updatedRunningState: {
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

export interface SectionDoc {
  envelope: Envelope<SectionDocPayload>;
  payload: SectionDocPayload;
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