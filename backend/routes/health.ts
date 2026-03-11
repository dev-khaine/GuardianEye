/**
 * Health Route — Liveness & readiness probe for Cloud Run
 * GET /health → returns service status and config checks
 */

import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'GuardianEye Live',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    checks: {
      geminiApiKey: Boolean(process.env.GEMINI_API_KEY),
      vertexSearch: Boolean(process.env.VERTEX_SEARCH_DATASTORE_ID),
      firestoreProject: Boolean(process.env.GOOGLE_CLOUD_PROJECT),
    },
  });
});
