/**
 * WebSocket Handler — Multimodal Live API Integration
 *
 * Architecture:
 *   Browser ──WS──► This Server ──WS──► Gemini Multimodal Live API
 *                        │
 *                        ▼
 *                   GuardianEye Orchestrator (ADK)
 *
 * Features:
 *   - Full-duplex audio streaming with Voice Activity Detection (VAD)
 *   - Barge-in support: user can interrupt agent mid-sentence
 *   - Real-time video frame processing (1 fps for analysis, stream for context)
 *   - Session-aware conversation history via Firestore
 *   - Graceful error recovery with automatic reconnect signaling
 */

import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { GuardianEyeOrchestrator } from '../agents/orchestrator';
import { SessionStore } from '../utils/sessionStore';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

type ClientMessageType =
  | 'START_SESSION'
  | 'AUDIO_CHUNK'
  | 'VIDEO_FRAME'
  | 'USER_TEXT'
  | 'INTERRUPT'
  | 'END_SESSION';

type ServerMessageType =
  | 'SESSION_READY'
  | 'AGENT_AUDIO'
  | 'AGENT_TEXT'
  | 'TRANSCRIPT_UPDATE'
  | 'SPATIAL_ANNOTATION'
  | 'SAFETY_ALERT'
  | 'AGENT_INTERRUPTED'
  | 'SESSION_ENDED'
  | 'ERROR';

interface ClientMessage {
  type: ClientMessageType;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

interface ServerMessage {
  type: ServerMessageType;
  sessionId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

interface SessionState {
  sessionId: string;
  userId?: string;
  orchestrator: GuardianEyeOrchestrator;
  geminiWs?: WebSocket;
  isAgentSpeaking: boolean;
  lastFrameData?: string;
  lastFrameMime: 'image/jpeg' | 'image/webp';
  frameBuffer: string[];
  interruptRequested: boolean;
  turnId: string;
  analysisThrottleMs: number;
  lastAnalysisTime: number;
}

// Interrupt keywords — expanding this list improves barge-in UX
const INTERRUPT_PHRASES = [
  'stop', 'wait', 'pause', 'hold on', 'hold up', 'hang on',
  'enough', 'ok stop', 'okay stop', 'that\'s enough',
];

// ── Gemini Live API Config ────────────────────────────────────────────────────

const GEMINI_LIVE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

const GEMINI_SESSION_CONFIG = {
  model: 'models/gemini-2.0-flash-exp',
  generationConfig: {
    responseModalities: ['AUDIO', 'TEXT'],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Aoede',  // Clear, calm voice for medical/technical guidance
        },
      },
    },
    temperature: 0.2,
  },
  systemInstruction: {
    parts: [{
      text: `You are GuardianEye, a calm and expert real-time assistant helping users with 
      hands-free technical and medical tasks. You can see through their camera.
      Be concise — users have their hands full. One instruction at a time.
      Always describe component locations precisely using spatial terms (top-right, bottom-left, etc).
      If a user says stop, wait, or pause — immediately stop speaking.`,
    }],
  },
};

// ── WebSocket Server Initialization ──────────────────────────────────────────

export function initializeWebSocketServer(httpServer: HTTPServer): void {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/live',
    perMessageDeflate: {
      zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      concurrencyLimit: 10,
      threshold: 1024,
    },
  });

  const sessions = new Map<WebSocket, SessionState>();
  const sessionStore = new SessionStore();

  wss.on('connection', (clientWs: WebSocket, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    logger.info(`New WebSocket connection from ${clientIp}`);

    clientWs.on('message', async (rawData: Buffer) => {
      try {
        const message: ClientMessage = JSON.parse(rawData.toString());
        await handleClientMessage(clientWs, message, sessions, sessionStore);
      } catch (error) {
        logger.error('Failed to parse client message:', error);
        sendToClient(clientWs, 'ERROR', 'unknown', {
          code: 'PARSE_ERROR',
          message: 'Invalid message format',
        });
      }
    });

    clientWs.on('close', (code, reason) => {
      const session = sessions.get(clientWs);
      if (session) {
        logger.info(`Session ${session.sessionId} closed: ${code} ${reason}`);
        teardownSession(session);
        sessions.delete(clientWs);
      }
    });

    clientWs.on('error', (error) => {
      logger.error('Client WebSocket error:', error);
    });
  });

  logger.info('WebSocket server initialized on /live');
}

// ── Message Router ────────────────────────────────────────────────────────────

async function handleClientMessage(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>,
  sessionStore: SessionStore
): Promise<void> {
  switch (message.type) {
    case 'START_SESSION':
      await handleStartSession(clientWs, message, sessions, sessionStore);
      break;

    case 'AUDIO_CHUNK':
      await handleAudioChunk(clientWs, message, sessions);
      break;

    case 'VIDEO_FRAME':
      await handleVideoFrame(clientWs, message, sessions);
      break;

    case 'USER_TEXT':
      await handleUserText(clientWs, message, sessions);
      break;

    case 'INTERRUPT':
      await handleInterrupt(clientWs, message, sessions);
      break;

    case 'END_SESSION':
      await handleEndSession(clientWs, message, sessions, sessionStore);
      break;

    default:
      logger.warn(`Unknown message type: ${(message as ClientMessage).type}`);
  }
}

// ── Session Lifecycle ─────────────────────────────────────────────────────────

async function handleStartSession(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>,
  sessionStore: SessionStore
): Promise<void> {
  const sessionId = message.sessionId || uuidv4();
  const userId = message.payload?.userId as string | undefined;

  const orchestrator = new GuardianEyeOrchestrator({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || '',
    location: process.env.VERTEX_LOCATION || 'us-central1',
    sessionId,
    userId,
  });

  const session: SessionState = {
    sessionId,
    userId,
    orchestrator,
    isAgentSpeaking: false,
    lastFrameMime: 'image/jpeg',
    frameBuffer: [],
    interruptRequested: false,
    turnId: uuidv4(),
    analysisThrottleMs: 2000,  // Max 1 full analysis per 2 seconds
    lastAnalysisTime: 0,
  };

  sessions.set(clientWs, session);

  // Persist session to Firestore
  await sessionStore.createSession(sessionId, {
    userId,
    startedAt: new Date(),
    status: 'active',
  });

  // Connect to Gemini Multimodal Live API
  await connectToGeminiLive(clientWs, session, sessions);

  sendToClient(clientWs, 'SESSION_READY', sessionId, {
    sessionId,
    message: 'GuardianEye is ready. Camera and microphone active.',
  });

  logger.info(`Session ${sessionId} started for user ${userId || 'anonymous'}`);
}

// ── Gemini Live API Connection ────────────────────────────────────────────────

async function connectToGeminiLive(
  clientWs: WebSocket,
  session: SessionState,
  sessions: Map<WebSocket, SessionState>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const geminiWs = new WebSocket(GEMINI_LIVE_WS_URL);
    session.geminiWs = geminiWs;

    geminiWs.on('open', () => {
      logger.debug(`Gemini Live WS connected for session ${session.sessionId}`);

      // Send initial BidiGenerateContent setup message
      geminiWs.send(JSON.stringify({
        setup: GEMINI_SESSION_CONFIG,
      }));
    });

    geminiWs.on('message', async (rawData: Buffer) => {
      try {
        const data = JSON.parse(rawData.toString());

        if (data.setupComplete) {
          logger.info(`Gemini Live session ready: ${session.sessionId}`);
          resolve();
          return;
        }

        await handleGeminiMessage(clientWs, session, data);

      } catch (error) {
        logger.error('Failed to handle Gemini message:', error);
      }
    });

    geminiWs.on('error', (error) => {
      logger.error(`Gemini Live WS error for session ${session.sessionId}:`, error);
      sendToClient(clientWs, 'ERROR', session.sessionId, {
        code: 'GEMINI_CONNECTION_ERROR',
        message: 'Lost connection to AI engine. Reconnecting...',
      });
      reject(error);
    });

    geminiWs.on('close', () => {
      logger.info(`Gemini Live WS closed for session ${session.sessionId}`);
    });

    // Timeout if setup takes too long
    setTimeout(() => reject(new Error('Gemini Live setup timeout')), 10000);
  });
}

// ── Gemini Response Handler ───────────────────────────────────────────────────

async function handleGeminiMessage(
  clientWs: WebSocket,
  session: SessionState,
  data: Record<string, unknown>
): Promise<void> {

  // ── Audio output chunks ──────────────────────────────────────────────────
  if (data.serverContent) {
    const serverContent = data.serverContent as Record<string, unknown>;

    if (serverContent.interrupted) {
      // Gemini acknowledged the interrupt
      session.isAgentSpeaking = false;
      sendToClient(clientWs, 'AGENT_INTERRUPTED', session.sessionId, {
        turnId: session.turnId,
      });
      return;
    }

    if (serverContent.modelTurn) {
      const modelTurn = serverContent.modelTurn as Record<string, unknown>;
      session.isAgentSpeaking = true;

      const parts = (modelTurn.parts as Array<Record<string, unknown>>) || [];

      for (const part of parts) {
        // Audio chunk — stream immediately for low latency
        if (part.inlineData) {
          const inlineData = part.inlineData as Record<string, unknown>;
          if (session.interruptRequested) break;

          sendToClient(clientWs, 'AGENT_AUDIO', session.sessionId, {
            audioData: inlineData.data,
            mimeType: inlineData.mimeType || 'audio/pcm',
            turnId: session.turnId,
          });
        }

        // Text chunk — update transcript
        if (part.text) {
          sendToClient(clientWs, 'AGENT_TEXT', session.sessionId, {
            text: part.text,
            turnId: session.turnId,
            isFinal: false,
          });
        }
      }
    }

    // Turn complete — agent finished speaking
    if (serverContent.turnComplete) {
      session.isAgentSpeaking = false;
      session.interruptRequested = false;
      session.turnId = uuidv4();

      sendToClient(clientWs, 'TRANSCRIPT_UPDATE', session.sessionId, {
        turnId: session.turnId,
        isFinal: true,
      });
    }
  }

  // ── Voice Activity Detection ──────────────────────────────────────────────
  if ((data as Record<string, unknown>).usageMetadata) {
    // Can be used for analytics/billing tracking
  }
}

// ── Audio Input Handler ───────────────────────────────────────────────────────

async function handleAudioChunk(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>
): Promise<void> {
  const session = sessions.get(clientWs);
  if (!session?.geminiWs || session.geminiWs.readyState !== WebSocket.OPEN) return;

  const audioData = message.payload?.data as string;
  if (!audioData) return;

  // Check for interrupt phrases in real-time (VAD-triggered)
  const transcript = message.payload?.transcript as string | undefined;
  if (transcript && isInterruptPhrase(transcript)) {
    await triggerInterrupt(clientWs, session);
    return;
  }

  // Stream audio directly to Gemini Live
  session.geminiWs.send(JSON.stringify({
    realtimeInput: {
      mediaChunks: [{
        mimeType: 'audio/pcm;rate=16000',
        data: audioData,
      }],
    },
  }));
}

// ── Video Frame Handler ───────────────────────────────────────────────────────

async function handleVideoFrame(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>
): Promise<void> {
  const session = sessions.get(clientWs);
  if (!session) return;

  const frameData = message.payload?.data as string;
  const mimeType = (message.payload?.mimeType as 'image/jpeg' | 'image/webp') || 'image/jpeg';

  if (!frameData) return;

  // Always update the latest frame reference
  session.lastFrameData = frameData;
  session.lastFrameMime = mimeType;

  // Stream frame to Gemini Live API for continuous context
  if (session.geminiWs?.readyState === WebSocket.OPEN) {
    session.geminiWs.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{
          mimeType,
          data: frameData,
        }],
      },
    }));
  }

  // Throttled deep analysis via ADK orchestrator (avoids overloading)
  const now = Date.now();
  if (now - session.lastAnalysisTime > session.analysisThrottleMs && session.lastFrameData) {
    session.lastAnalysisTime = now;
    // Run analysis in background — don't await, don't block frame streaming
    runBackgroundAnalysis(clientWs, session).catch(err =>
      logger.error('Background analysis error:', err)
    );
  }
}

// ── Background ADK Analysis ───────────────────────────────────────────────────

async function runBackgroundAnalysis(
  clientWs: WebSocket,
  session: SessionState
): Promise<void> {
  if (!session.lastFrameData) return;

  const result = await session.orchestrator.processInput({
    imageData: session.lastFrameData,
    mimeType: session.lastFrameMime,
    timestamp: Date.now(),
  });

  // Send spatial annotations to the UI for overlay rendering
  if (result.spatialAnnotations && result.spatialAnnotations.length > 0) {
    sendToClient(clientWs, 'SPATIAL_ANNOTATION', session.sessionId, {
      annotations: result.spatialAnnotations,
      turnId: session.turnId,
    });
  }

  // Surface safety alerts immediately
  if (result.text?.includes('⚠️ SAFETY ALERT')) {
    sendToClient(clientWs, 'SAFETY_ALERT', session.sessionId, {
      message: result.text,
      severity: 'CRITICAL',
    });
  }
}

// ── User Text Handler ─────────────────────────────────────────────────────────

async function handleUserText(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>
): Promise<void> {
  const session = sessions.get(clientWs);
  if (!session?.geminiWs || session.geminiWs.readyState !== WebSocket.OPEN) return;

  const text = message.payload?.text as string;
  if (!text?.trim()) return;

  // Check for interrupt keywords in text input
  if (isInterruptPhrase(text)) {
    await triggerInterrupt(clientWs, session);
    return;
  }

  // If we have a recent frame, trigger ADK orchestration for grounded response
  if (session.lastFrameData) {
    const result = await session.orchestrator.processInput({
      imageData: session.lastFrameData,
      mimeType: session.lastFrameMime,
      timestamp: Date.now(),
      userQuery: text,
    });

    // Inject the grounded result into Gemini for TTS
    session.geminiWs.send(JSON.stringify({
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text }],
        }, {
          role: 'model',
          parts: [{ text: result.text }],
        }],
        turnComplete: false,
      },
    }));

    // Surface source documents if any
    if (result.sourceDocuments && result.sourceDocuments.length > 0) {
      sendToClient(clientWs, 'TRANSCRIPT_UPDATE', session.sessionId, {
        sources: result.sourceDocuments,
        confidence: result.confidence,
      });
    }
  } else {
    // No frame — send text directly
    session.geminiWs.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }
}

// ── Interrupt Handling (Barge-in) ─────────────────────────────────────────────

async function handleInterrupt(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>
): Promise<void> {
  const session = sessions.get(clientWs);
  if (!session) return;
  await triggerInterrupt(clientWs, session);
}

async function triggerInterrupt(clientWs: WebSocket, session: SessionState): Promise<void> {
  if (!session.isAgentSpeaking) return;

  logger.info(`Barge-in interrupt triggered for session ${session.sessionId}`);
  session.interruptRequested = true;

  // Signal Gemini to stop generation
  if (session.geminiWs?.readyState === WebSocket.OPEN) {
    // Send empty client content to trigger model interruption
    session.geminiWs.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: '' }] }],
        turnComplete: true,
      },
    }));
  }

  sendToClient(clientWs, 'AGENT_INTERRUPTED', session.sessionId, {
    turnId: session.turnId,
    message: 'Paused. What would you like to do?',
  });
}

function isInterruptPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return INTERRUPT_PHRASES.some(phrase => lower.includes(phrase));
}

// ── Session Teardown ──────────────────────────────────────────────────────────

async function handleEndSession(
  clientWs: WebSocket,
  message: ClientMessage,
  sessions: Map<WebSocket, SessionState>,
  sessionStore: SessionStore
): Promise<void> {
  const session = sessions.get(clientWs);
  if (!session) return;

  teardownSession(session);
  await sessionStore.endSession(session.sessionId);
  sessions.delete(clientWs);

  sendToClient(clientWs, 'SESSION_ENDED', session.sessionId, {
    sessionId: session.sessionId,
    totalTurns: session.orchestrator.turnCount,
  });

  clientWs.close(1000, 'Session ended normally');
}

function teardownSession(session: SessionState): void {
  if (session.geminiWs?.readyState === WebSocket.OPEN) {
    session.geminiWs.close(1000, 'Session ended');
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sendToClient(
  ws: WebSocket,
  type: ServerMessageType,
  sessionId: string,
  payload: Record<string, unknown>
): void {
  if (ws.readyState !== WebSocket.OPEN) return;

  const message: ServerMessage = {
    type,
    sessionId,
    payload,
    timestamp: Date.now(),
  };

  ws.send(JSON.stringify(message));
}
