// routes/session.ts
import { Router } from 'express';
import { SessionStore } from '../utils/sessionStore';
import { v4 as uuidv4 } from 'uuid';

export const sessionRouter = Router();
const sessionStore = new SessionStore();

sessionRouter.post('/', async (req, res) => {
  const sessionId = uuidv4();
  const { userId } = req.body;
  await sessionStore.createSession(sessionId, {
    userId,
    startedAt: new Date(),
    status: 'active',
  });
  res.json({ sessionId, message: 'Session pre-created. Connect via WebSocket.' });
});

sessionRouter.get('/:sessionId', async (req, res) => {
  const session = await sessionStore.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});
