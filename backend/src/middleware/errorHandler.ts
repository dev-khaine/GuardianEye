// middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error('Unhandled error:', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV !== 'production' ? err.message : undefined });
}

// middleware/rateLimiter.ts
import { Request, Response, NextFunction } from 'express';

const requests = new Map<string, { count: number; resetAt: number }>();

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 100;

  const record = requests.get(ip);

  if (!record || now > record.resetAt) {
    requests.set(ip, { count: 1, resetAt: now + windowMs });
    next();
    return;
  }

  if (record.count >= maxRequests) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  record.count++;
  next();
}
