// M4-Assembler module exports

export { ContentAssembler } from './assembler.ts';
export {
  AssemblyResult,
  ChapterDocument,
  AssemblyMetadata,
  AssemblyStatistics,
  ValidationReport
} from './types.ts';

// Re-export for default import compatibility
import { ContentAssembler } from './assembler.ts';
export default ContentAssembler;