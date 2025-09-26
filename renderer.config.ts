/**
 * Renderer Configuration
 * Centralized configuration for the chapter renderer with environment variable support
 */

export interface RendererConfig {
  // Input/Output paths
  inputDir: string;
  outputDir: string;
  assetsDir: string;
  schemaDir: string;

  // Compilation settings
  enableCaching: boolean;
  cacheDir: string;

  // Timeouts (in milliseconds)
  texTimeout: number;
  rdkitTimeout: number;
  diagramTimeout: number;

  // Safety settings
  enableSvgSanitization: boolean;
  maxFileSize: number; // bytes
  maxProcessingTime: number; // milliseconds

  // Error handling
  retryAttempts: number;
  errorMode: 'strict' | 'graceful';

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  correlationIdTracking: boolean;
}

export const DEFAULT_CONFIG: RendererConfig = {
  // Paths
  inputDir: process.env.RENDERER_INPUT_DIR || './chapters',
  outputDir: process.env.RENDERER_OUTPUT_DIR || './rendered',
  assetsDir: process.env.RENDERER_ASSETS_DIR || './assets',
  schemaDir: process.env.RENDERER_SCHEMA_DIR || './schema',

  // Caching
  enableCaching: process.env.RENDERER_ENABLE_CACHING !== 'false',
  cacheDir: process.env.RENDERER_CACHE_DIR || './cache/renderer',

  // Timeouts
  texTimeout: parseInt(process.env.RENDERER_TEX_TIMEOUT || '10000'),
  rdkitTimeout: parseInt(process.env.RENDERER_RDKIT_TIMEOUT || '8000'),
  diagramTimeout: parseInt(process.env.RENDERER_DIAGRAM_TIMEOUT || '5000'),

  // Safety
  enableSvgSanitization: process.env.RENDERER_SVG_SANITIZATION !== 'false',
  maxFileSize: parseInt(process.env.RENDERER_MAX_FILE_SIZE || '10485760'), // 10MB
  maxProcessingTime: parseInt(process.env.RENDERER_MAX_PROCESSING_TIME || '30000'), // 30s

  // Error handling
  retryAttempts: parseInt(process.env.RENDERER_RETRY_ATTEMPTS || '2'),
  errorMode: (process.env.RENDERER_ERROR_MODE as 'strict' | 'graceful') || 'graceful',

  // Logging
  logLevel: (process.env.RENDERER_LOG_LEVEL as any) || 'info',
  correlationIdTracking: process.env.RENDERER_CORRELATION_TRACKING !== 'false'
};

/**
 * Load and validate renderer configuration
 */
export function loadRendererConfig(): RendererConfig {
  const config = { ...DEFAULT_CONFIG };

  // Validate configuration
  if (config.texTimeout < 1000 || config.texTimeout > 60000) {
    throw new Error('RENDERER_TEX_TIMEOUT must be between 1000 and 60000 ms');
  }

  if (config.maxFileSize < 1024 || config.maxFileSize > 100 * 1024 * 1024) {
    throw new Error('RENDERER_MAX_FILE_SIZE must be between 1KB and 100MB');
  }

  if (config.retryAttempts < 0 || config.retryAttempts > 5) {
    throw new Error('RENDERER_RETRY_ATTEMPTS must be between 0 and 5');
  }

  return config;
}