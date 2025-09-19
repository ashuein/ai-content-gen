import { Beat, ModuleError, ValidationResult } from './types.js';

/**
 * Validates beat dependency graph for cycles and referential integrity
 */
export class BeatValidator {

  /**
   * Validates that beat dependencies form a DAG (no cycles)
   */
  static validateDependencyGraph(beats: Beat[]): ValidationResult {
    const beatIds = new Set(beats.map(b => b.id));
    const errors: string[] = [];

    // Check all prereq references exist
    for (const beat of beats) {
      for (const prereq of beat.prereqs) {
        if (!beatIds.has(prereq)) {
          errors.push(`Beat ${beat.id} references non-existent prereq: ${prereq}`);
        }
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        data: { invalidReferences: errors }
      };
    }

    // Check for cycles using DFS
    const cycleResult = this.detectCycles(beats);
    if (!cycleResult.valid) {
      return cycleResult;
    }

    return { valid: true };
  }

  /**
   * Detects cycles in the beat dependency graph using DFS
   */
  private static detectCycles(beats: Beat[]): ValidationResult {
    const beatMap = new Map<string, Beat>();
    beats.forEach(beat => beatMap.set(beat.id, beat));

    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (beatId: string, path: string[]): string[] | null => {
      if (recursionStack.has(beatId)) {
        // Found cycle - return the cycle path
        const cycleStart = path.indexOf(beatId);
        return path.slice(cycleStart).concat([beatId]);
      }

      if (visited.has(beatId)) {
        return null; // Already processed this subtree
      }

      visited.add(beatId);
      recursionStack.add(beatId);

      const beat = beatMap.get(beatId);
      if (!beat) return null;

      for (const prereq of beat.prereqs) {
        const cycle = dfs(prereq, [...path, beatId]);
        if (cycle) return cycle;
      }

      recursionStack.delete(beatId);
      return null;
    };

    // Check each beat as potential cycle entry point
    for (const beat of beats) {
      if (!visited.has(beat.id)) {
        const cycle = dfs(beat.id, []);
        if (cycle) {
          return {
            valid: false,
            errors: [`Circular dependency detected: ${cycle.join(' → ')}`],
            data: { cycle }
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Validates asset suggestion format
   */
  static validateAssetSuggestions(beats: Beat[]): ValidationResult {
    const errors: string[] = [];
    const validAssetPattern = /^(eq|plot|diagram|widget|chem):[a-z0-9_-]+$/;

    for (const beat of beats) {
      for (const asset of beat.assets_suggested) {
        if (!validAssetPattern.test(asset)) {
          errors.push(`Beat ${beat.id} has invalid asset suggestion format: ${asset}`);
        }
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        data: { invalidAssets: errors }
      };
    }

    return { valid: true };
  }
}