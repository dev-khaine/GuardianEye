/**
 * Knowledge Route — Upload & Index PDFs into Vertex AI Search
 *
 * POST /api/knowledge/upload
 *   Accepts a PDF via multipart form-data (field name: 'manual').
 *   Uploads it to GCS, triggers a Vertex AI Search import LRO,
 *   and returns a job ID for polling.
 *
 * GET /api/knowledge/jobs/:jobId
 *   Polls the import LRO status using the operation name stored server-side.
 *   Returns { done, successCount, failureCount } when complete.
 *
 * GET /api/knowledge/list
 *   Returns all jobs submitted in this server process (in-memory store).
 *   In production, persist this to Firestore if you need cross-restart history.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { KnowledgeIndexer, IndexJobResult } from '../utils/knowledgeIndexer';
import { logger } from '../utils/logger';

export const knowledgeRouter = Router();

// 50 MB limit — Vertex AI Search supports up to 200 MB per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Only accept PDF for now — extend to HTML/DOCX/TXT as needed
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are supported'));
    }
  },
});

// In-memory job store: jobId → { operationName, filename, submittedAt }
// Good enough for a challenge demo; swap for Firestore for production durability
const jobStore = new Map<string, { operationName: string; filename: string; submittedAt: Date }>();

const indexer = new KnowledgeIndexer();

// ── POST /api/knowledge/upload ────────────────────────────────────────────────

knowledgeRouter.post('/upload', upload.single('manual'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided. Send a PDF as field "manual".' });
  }

  const { originalname, size, buffer } = req.file;
  logger.info(`Knowledge upload: ${originalname} (${(size / 1024).toFixed(1)} KB)`);

  // Guard: if Vertex AI Search is not configured, return a clear error
  if (!indexer.isConfigured) {
    return res.status(503).json({
      error: 'Knowledge base not configured.',
      instructions:
        'Set GOOGLE_CLOUD_PROJECT and VERTEX_SEARCH_DATASTORE_ID environment variables. ' +
        'See README for Vertex AI Search datastore setup.',
    });
  }

  try {
    const job: IndexJobResult = await indexer.indexPdf(buffer, originalname);

    // Persist operation name for polling
    jobStore.set(job.jobId, {
      operationName: job.operationName,
      filename: job.filename,
      submittedAt: new Date(),
    });

    logger.info(`Knowledge index job started: ${job.jobId} → ${job.operationName}`);

    return res.status(202).json({
      message: 'PDF accepted and indexing has started.',
      jobId: job.jobId,
      filename: job.filename,
      gcsUri: job.gcsUri,
      status: 'indexing',
      pollUrl: `/api/knowledge/jobs/${job.jobId}`,
      note:
        'Vertex AI Search indexing typically takes 1–5 minutes. ' +
        'Poll the pollUrl to check when indexing is complete.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Knowledge upload error:', err);

    return res.status(500).json({
      error: 'Failed to start indexing job.',
      details: process.env.NODE_ENV !== 'production' ? message : undefined,
    });
  }
});

// ── GET /api/knowledge/jobs/:jobId ────────────────────────────────────────────

knowledgeRouter.get('/jobs/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found. It may have been submitted before the last server restart.' });
  }

  try {
    const status = await indexer.getJobStatus(job.operationName);

    return res.json({
      jobId,
      filename: job.filename,
      submittedAt: job.submittedAt,
      operationName: job.operationName,
      done: status.done,
      ...(status.done && !status.error && {
        successCount: status.successCount,
        failureCount: status.failureCount,
        message:
          status.failureCount === 0
            ? `✅ Indexed ${status.successCount} document(s) successfully.`
            : `⚠️ Indexed ${status.successCount} document(s), ${status.failureCount} failed.`,
      }),
      ...(status.error && {
        error: status.error,
      }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Job status check error:', err);
    return res.status(500).json({
      error: 'Failed to check job status.',
      details: process.env.NODE_ENV !== 'production' ? message : undefined,
    });
  }
});

// ── GET /api/knowledge/list ───────────────────────────────────────────────────

knowledgeRouter.get('/list', (_req: Request, res: Response) => {
  const jobs = Array.from(jobStore.entries()).map(([id, job]) => ({
    jobId: id,
    filename: job.filename,
    submittedAt: job.submittedAt,
    pollUrl: `/api/knowledge/jobs/${id}`,
  }));

  res.json({
    total: jobs.length,
    datastoreId: process.env.VERTEX_SEARCH_DATASTORE_ID || '(not configured)',
    jobs,
  });
});
