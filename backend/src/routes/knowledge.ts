// routes/knowledge.ts — Upload manuals to the knowledge base
import { Router } from 'express';
import multer from 'multer';
import { logger } from '../utils/logger';

export const knowledgeRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

knowledgeRouter.post('/upload', upload.single('manual'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  logger.info(`Manual upload: ${req.file.originalname} (${req.file.size} bytes)`);

  // In production: upload to GCS, then index into Vertex AI Search datastore
  // For now, return success placeholder
  res.json({
    message: 'Manual received. In production, this indexes into Vertex AI Search.',
    filename: req.file.originalname,
    size: req.file.size,
    instructions: 'See README for Vertex AI Search datastore configuration.',
  });
});
