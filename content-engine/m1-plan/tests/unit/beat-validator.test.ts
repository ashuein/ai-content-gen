import { BeatValidator } from '../../src/beat-validator.js';
import { Beat } from '../../src/types.js';

describe('BeatValidator', () => {
  describe('validateDependencyGraph', () => {
    test('should pass for valid linear dependency chain', () => {
      const beats: Beat[] = [
        {
          id: 'beat-a',
          headline: 'Beat A',
          prereqs: [],
          outcomes: ['outcome 1'],
          assets_suggested: ['eq:example']
        },
        {
          id: 'beat-b',
          headline: 'Beat B',
          prereqs: ['beat-a'],
          outcomes: ['outcome 2'],
          assets_suggested: ['plot:example']
        },
        {
          id: 'beat-c',
          headline: 'Beat C',
          prereqs: ['beat-b'],
          outcomes: ['outcome 3'],
          assets_suggested: ['diagram:example']
        }
      ];

      const result = BeatValidator.validateDependencyGraph(beats);
      expect(result.valid).toBe(true);
    });

    test('should detect circular dependency', () => {
      const beats: Beat[] = [
        {
          id: 'beat-a',
          headline: 'Beat A',
          prereqs: ['beat-c'], // circular dependency
          outcomes: ['outcome 1'],
          assets_suggested: ['eq:example']
        },
        {
          id: 'beat-b',
          headline: 'Beat B',
          prereqs: ['beat-a'],
          outcomes: ['outcome 2'],
          assets_suggested: ['plot:example']
        },
        {
          id: 'beat-c',
          headline: 'Beat C',
          prereqs: ['beat-b'],
          outcomes: ['outcome 3'],
          assets_suggested: ['diagram:example']
        }
      ];

      const result = BeatValidator.validateDependencyGraph(beats);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(expect.stringContaining('Circular dependency detected'));
    });

    test('should detect invalid prereq references', () => {
      const beats: Beat[] = [
        {
          id: 'beat-a',
          headline: 'Beat A',
          prereqs: ['beat-nonexistent'], // invalid reference
          outcomes: ['outcome 1'],
          assets_suggested: ['eq:example']
        }
      ];

      const result = BeatValidator.validateDependencyGraph(beats);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(expect.stringContaining('non-existent prereq'));
    });
  });

  describe('validateAssetSuggestions', () => {
    test('should pass for valid asset formats', () => {
      const beats: Beat[] = [
        {
          id: 'beat-a',
          headline: 'Beat A',
          prereqs: [],
          outcomes: ['outcome 1'],
          assets_suggested: [
            'eq:force-equation',
            'plot:velocity-time',
            'diagram:free-body',
            'widget:parameter-explorer',
            'chem:molecule-structure'
          ]
        }
      ];

      const result = BeatValidator.validateAssetSuggestions(beats);
      expect(result.valid).toBe(true);
    });

    test('should reject invalid asset formats', () => {
      const beats: Beat[] = [
        {
          id: 'beat-a',
          headline: 'Beat A',
          prereqs: [],
          outcomes: ['outcome 1'],
          assets_suggested: [
            'invalid:format',
            'eq:', // missing name
            'unknown_type:name',
            'eq:invalid name with spaces'
          ]
        }
      ];

      const result = BeatValidator.validateAssetSuggestions(beats);
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });
});