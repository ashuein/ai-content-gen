/**
 * Unified KaTeX Configuration
 * Ensures consistent math rendering across validators, generators, and renderers
 */

import type { KatexOptions } from 'katex';

/**
 * Common physics/chemistry macros used throughout the content engine
 */
export const MATH_MACROS = {
  // Unit notation
  "\\unit": "\\,\\text{#1}",
  "\\SI": "#1\\,\\text{#2}",

  // Temperature units
  "\\degree": "^\\circ",
  "\\celsius": "^\\circ\\text{C}",
  "\\fahrenheit": "^\\circ\\text{F}",

  // Electrical units
  "\\ohm": "\\Omega",

  // Additional scientific notation
  "\\per": "\\,\\text{per}\\,",
  "\\squared": "^2",
  "\\cubed": "^3"
} as const;

/**
 * Base KaTeX configuration for validation
 * Uses stricter settings to catch errors during validation
 */
export const VALIDATION_KATEX_OPTIONS: KatexOptions = {
  throwOnError: true,
  errorColor: '#cc0000',
  strict: 'warn' as const,
  output: 'mathml' as const,
  displayMode: false,
  trust: false,
  macros: MATH_MACROS
};

/**
 * KaTeX configuration for rendering
 * Uses display mode for better visual presentation
 */
export const RENDERING_KATEX_OPTIONS: KatexOptions = {
  throwOnError: true,
  errorColor: '#cc0000',
  strict: 'error' as const,
  output: 'mathml' as const,
  displayMode: true,
  trust: false,
  macros: MATH_MACROS
};

/**
 * Create KaTeX options with custom overrides
 */
export function createKatexOptions(overrides: Partial<KatexOptions> = {}): KatexOptions {
  return {
    ...RENDERING_KATEX_OPTIONS,
    ...overrides
  };
}