// M2-Scaffold module exports

export { ScaffoldGenerator } from './scaffold-generator.ts';
export {
  Scaffold,
  SectionContext,
  SectionContextPayload,
  ValidationResult,
  ModuleError,
  ScaffoldMetadata,
  ScaffoldTransition,
  AssetMarker
} from './types.ts';

// Re-export for default import compatibility
import { ScaffoldGenerator } from './scaffold-generator.ts';
export default ScaffoldGenerator;