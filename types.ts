export type Section =
  | { id: string; type: 'paragraph'; md: string }
  | { id: string; type: 'equation'; tex: string; check: EqCheck }
  | { id: string; type: 'plot'; specRef: string }
  | { id: string; type: 'chem'; smiles: string; caption?: string }
  | { id: string; type: 'diagram'; specRef: string }
  | { id: string; type: 'widget'; widget: FormulaWidgetSpec };

export interface DocJSON {
  meta: { title: string; grade: string; subject: string; version: string };
  sections: Section[];
}

export interface EqCheck {
  vars: Record<string, number>;
  expr: string;
  expect: number;
  tol: number;
}

export interface PlotSpec {
  kind: 'pgfplot';
  title?: string;
  x: { min: number; max: number; ticks: number; label?: string };
  y: { min: number; max: number; ticks: number; label?: string };
  expr: string;
  params?: Record<string, number>;
  style?: { grid?: boolean; samples?: number };
}

export interface DiagramSpec {
  canvas: { width: number; height: number; grid: number; snap?: boolean };
  nodes: Array<
    | { id: string; kind: 'point'; x: number; y: number; label?: string }
    | { id: string; kind: 'arrow'; from: [number, number]; to: [number, number]; label?: string }
  >;
  labels?: Array<{ of: string; pos: 'mid' | 'start' | 'end'; text: string; dx?: number; dy?: number }>;
  rules?: { requiredNodes?: string[]; forbidEdgeCrossings?: boolean };
}

export interface FormulaWidgetSpec {
  kind: 'formula-playground';
  expr: string;
  params: Array<{ name: string; min: number; max: number; step: number; default: number }>;
  display?: { latex?: string };
}
