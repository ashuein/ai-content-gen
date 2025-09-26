// M3-Section module exports

export { ContentGenerator } from './content-generator.ts';
export {
  SectionDoc,
  ProseBlock,
  EquationBlock,
  PlotBlock,
  DiagramBlock,
  WidgetBlock,
  ChemBlock,
  BlockType,
  SectionMetadata,
  SectionStatistics
} from './types.ts';

// Re-export for default import compatibility
import { ContentGenerator } from './content-generator.ts';
export default ContentGenerator;