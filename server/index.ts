/**
 * Production API Server
 * Serves compilation endpoints and static assets
 */

const express = require('express');
const cors = require('cors');
import { resolve } from 'path';
import { PATHS } from '../config/paths.js';
import { compileAsset, batchCompileAssets, getAssetInfo } from './api/compile.js';
import { buildWithInjector, getPipelineStatus, listPipelineStatuses } from './api/pipeline.js';
import { healthEndpoints } from './monitoring/health-endpoints.js';
import { securityMiddleware } from './security/middleware.js';
import { idempotencyStore } from './idempotency/store.js';
import { lockManager } from './concurrency/lock-manager.js';
import { tempFileManager } from './cleanup/temp-file-manager.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize infrastructure components
async function initializeInfrastructure() {
  await idempotencyStore.initialize();
  await lockManager.initialize();
  console.log('Infrastructure components initialized');
}

// Security middleware (applied globally)
app.use(securityMiddleware.securityMiddleware());
app.use(securityMiddleware.createRateLimit());

// CORS and body parsing
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static file serving
app.use('/assets', express.static(resolve(PATHS.ROOT_DIR, PATHS.ASSETS_DIR)));
app.use('/rendered', express.static(resolve(PATHS.ROOT_DIR, PATHS.PUBLIC_DIR)));

// API routes
app.post('/api/compile', compileAsset);
app.post('/api/compile/batch', batchCompileAssets);
app.get('/api/assets/:identifier/:format?', getAssetInfo);

// Pipeline routes
app.post('/api/injector/build', buildWithInjector);
app.get('/api/status/:promptId', getPipelineStatus);
app.get('/api/pipeline/statuses', listPipelineStatuses);

// Health and monitoring endpoints
app.get('/health', healthEndpoints.health);
app.get('/status', healthEndpoints.status);
app.get('/metrics', healthEndpoints.metrics);
app.get('/ready', healthEndpoints.ready);
app.get('/live', healthEndpoints.live);

// Error handling
app.use((err: Error, req: any, res: any, next: any) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server with initialization
async function startServer() {
  try {
    await initializeInfrastructure();

    app.listen(PORT, () => {
      console.log(`🚀 Production API server running on http://localhost:${PORT}`);
      console.log(`📁 Assets served from: ${resolve(PATHS.ROOT_DIR, PATHS.ASSETS_DIR)}`);
      console.log(`📖 Rendered content served from: ${resolve(PATHS.ROOT_DIR, PATHS.PUBLIC_DIR)}`);
      console.log(`💓 Health endpoints: /health, /status, /metrics, /ready, /live`);
      console.log(`🔒 Security middleware: enabled`);
      console.log(`⚡ Cache, locks, idempotency, cleanup: active`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;