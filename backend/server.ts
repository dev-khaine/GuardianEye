import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { initializeWebSocketServer } from './routes/websocket';
import { sessionRouter } from './routes/session';
import { knowledgeRouter } from './routes/knowledge';
import { healthRouter } from './routes/health';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// ── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimiter);

// ── REST Routes ──────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/api/sessions', sessionRouter);
app.use('/api/knowledge', knowledgeRouter);

// ── Error Handling ───────────────────────────────────────────────────────────
app.use(errorHandler);

// ── WebSocket Server (Multimodal Live API proxy) ─────────────────────────────
initializeWebSocketServer(httpServer);

const PORT = parseInt(process.env.PORT || '8080', 10);

httpServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`🛡️  GuardianEye Live server running on port ${PORT}`);
  logger.info(`🔌 WebSocket endpoint: ws://localhost:${PORT}/live`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export { app, httpServer };
