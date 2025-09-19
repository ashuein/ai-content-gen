// Core types for M4-Assembler module

export interface Envelope<T> {
  version: string;
  producer: string;
  timestamp: string;
  correlationId: string;
  contentHash: string;
  compatible?: string[];
}

export interface SectionDoc {
  envelope: Envelope<SectionDocPayload>;
  payload: SectionDocPayload;
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
  updatedRunningState: any;
}

export interface ContentBlock {
  type: "prose" | "equation" | "plot" | "diagram" | "chemistry" | "widget";
  id: string;
  [key: string]: any;
}

export interface GeneratedAsset {
  id: string;
  type: "plot" | "diagram" | "widget" | "chemistry";
  specPath: string;
  contentHash: string;
  spec?: any;
  compiledSvg?: string;
}

export interface ValidationReport {
  gatesPassed: string[];
  gatesFailed: string[];
  warnings?: string[];
  repairActions?: string[];
  processingTime?: number;
}

// Reader DocJSON Types (CRITICAL: Must match reader.v1.schema.json exactly)
export interface ReaderDocJSON {
  meta: {
    title: string;
    grade: string;
    subject: string;
    version: string;
  };
  sections: ReaderSection[];
}

export type ReaderSection =
  | ReaderParagraphSection
  | ReaderEquationSection
  | ReaderPlotSection
  | ReaderChemSection
  | ReaderDiagramSection
  | ReaderWidgetSection;

export interface ReaderParagraphSection {
  id: string;
  type: "paragraph";
  md: string;
}

export interface ReaderEquationSection {
  id: string;
  type: "equation";
  tex: string;
  check: {
    vars: Record<string, number>;
    expr: string;
    expect: number;
    tol: number;
  };
}

export interface ReaderPlotSection {
  id: string;
  type: "plot";
  specRef: string;
}

export interface ReaderChemSection {
  id: string;
  type: "chem";
  smiles: string;
  caption?: string;
}

export interface ReaderDiagramSection {
  id: string;
  type: "diagram";
  specRef: string;
}

export interface ReaderWidgetSection {
  id: string;
  type: "widget";
  widget: {
    kind: "formula-playground";
    expr: string;
    params: Array<{
      name: string;
      min: number;
      max: number;
      step: number;
      default: number;
    }>;
    display?: {
      latex?: string;
    };
  };
}

// Assembly Output Types
export interface AssemblyResult {
  readerDocJSON: ReaderDocJSON;
  assetFiles: AssetFile[];
  validationReport: AssemblyValidationReport;
}

export interface AssetFile {
  path: string;
  content: any;
  contentHash: string;
  type: "plot" | "diagram" | "widget" | "chemistry" | "svg";
}

export interface AssemblyValidationReport {
  readerSchemaValid: boolean;
  crossReferencesValid: boolean;
  filePathsValid: boolean;
  gatesPassed: string[];
  gatesFailed: string[];
  errors?: any[];
  warnings?: string[];
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