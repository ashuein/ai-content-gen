/**
 * Centralized Path Configuration
 * Single source of truth for all file system paths across the entire pipeline
 */

import { resolve, normalize, join, relative, isAbsolute, extname, basename, dirname } from 'path';
import { platform } from 'os';

/**
 * Path configuration with environment variable overrides
 */
export const PATHS = {
  // Base directories
  ROOT_DIR: process.cwd(),

  // Input and temporary storage
  TEMP_DIR: process.env.TEMP_DIR || 'temp',
  UPLOAD_DIR: process.env.UPLOAD_DIR || 'temp/uploads',

  // Processing directories
  CHAPTERS_DIR: process.env.CHAPTERS_DIR || 'chapters',
  ASSETS_DIR: process.env.ASSETS_DIR || 'assets',
  CACHE_DIR: process.env.CACHE_DIR || '.cache',

  // Output directories
  RENDERED_DIR: process.env.RENDERED_DIR || 'CR_rendered',
  PUBLIC_DIR: process.env.PUBLIC_DIR || 'rendered',

  // Asset subdirectories
  PLOTS_DIR: process.env.PLOTS_DIR || 'assets/plots',
  DIAGRAMS_DIR: process.env.DIAGRAMS_DIR || 'assets/diagrams',
  CHEM_DIR: process.env.CHEM_DIR || 'assets/chem',
  WIDGETS_DIR: process.env.WIDGETS_DIR || 'assets/widgets',

  // Reports and logs
  REPORTS_DIR: process.env.REPORTS_DIR || 'artifacts/reports',
  LOGS_DIR: process.env.LOGS_DIR || 'logs',

  // Schema directories
  SCHEMAS_DIR: process.env.SCHEMAS_DIR || 'content-engine/schemas-shared',

  // Compiler cache
  COMPILER_CACHE_DIR: process.env.COMPILER_CACHE_DIR || '.cache/compilers'
} as const;

/**
 * Resolve path relative to project root
 */
export function resolvePath(...segments: string[]): string {
  return resolve(PATHS.ROOT_DIR, ...segments);
}

/**
 * Get absolute paths for all configured directories
 */
export function getAbsolutePaths() {
  const absolutePaths: Record<string, string> = {};

  for (const [key, relativePath] of Object.entries(PATHS)) {
    if (key === 'ROOT_DIR') {
      absolutePaths[key] = relativePath;
    } else {
      absolutePaths[key] = resolvePath(relativePath);
    }
  }

  return absolutePaths;
}

/**
 * Platform-specific path utilities
 */
export const pathUtils = {
  /**
   * Check if running on Windows
   */
  isWindows: platform() === 'win32',

  /**
   * Normalize path separators for current platform
   */
  normalize: (filePath: string): string => normalize(filePath),

  /**
   * Join paths safely across platforms
   */
  join: (...segments: string[]): string => join(...segments),

  /**
   * Get relative path from one location to another
   */
  relative: (from: string, to: string): string => relative(from, to),

  /**
   * Check if path is absolute
   */
  isAbsolute: (filePath: string): boolean => isAbsolute(filePath),

  /**
   * Get file extension
   */
  extname: (filePath: string): string => extname(filePath),

  /**
   * Get filename without extension
   */
  basename: (filePath: string, ext?: string): string => basename(filePath, ext),

  /**
   * Get directory name
   */
  dirname: (filePath: string): string => dirname(filePath)
};

/**
 * Validation utilities for paths
 */
export const pathValidation = {
  /**
   * Check if path is within allowed directory
   */
  isWithinDirectory: (filePath: string, allowedDir: string): boolean => {
    const normalizedPath = normalize(filePath);
    const normalizedDir = normalize(allowedDir);
    const relativePath = relative(normalizedDir, normalizedPath);

    // Path is within directory if relative path doesn't start with '..' or '/'
    return !relativePath.startsWith('..') && !isAbsolute(relativePath);
  },

  /**
   * Sanitize filename for safe file system usage
   */
  sanitizeFilename: (filename: string): string => {
    // Remove or replace dangerous characters
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')  // Replace Windows-forbidden chars
      .replace(/[\x00-\x1f\x7f]/g, '') // Remove control characters
      .replace(/^\.+/, '')             // Remove leading dots
      .substring(0, 255);              // Limit length
  },

  /**
   * Validate file extension against allowlist
   */
  isAllowedExtension: (filename: string, allowedExts: string[]): boolean => {
    const ext = extname(filename).toLowerCase();
    return allowedExts.includes(ext);
  },

  /**
   * Check for path traversal attempts
   */
  hasPathTraversal: (filePath: string): boolean => {
    const normalized = normalize(filePath);
    return normalized.includes('..') || isAbsolute(filePath);
  }
};

/**
 * Configuration validation
 */
export function validatePathConfiguration(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required environment variables if in production
  if (process.env.NODE_ENV === 'production') {
    const requiredEnvVars = ['CHAPTERS_DIR', 'ASSETS_DIR', 'RENDERED_DIR'];
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        errors.push(`Missing required environment variable: ${envVar}`);
      }
    }
  }

  // Validate path formats
  const pathEntries = Object.entries(PATHS);
  for (const [key, pathValue] of pathEntries) {
    if (key !== 'ROOT_DIR' && isAbsolute(pathValue)) {
      errors.push(`Path ${key} should be relative, got: ${pathValue}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Export commonly used absolute paths
 */
export const absolutePaths = getAbsolutePaths();

/**
 * Development helper to log all configured paths
 */
export function logPathConfiguration(): void {
  if (process.env.NODE_ENV !== 'production') {
    console.log('📁 Path Configuration:');
    console.table(getAbsolutePaths());
  }
}