/**
 * SessionStore — Firestore persistence layer
 * Stores session metadata, conversation turns, and user history.
 */

import { Firestore, Timestamp } from '@google-cloud/firestore';
import { logger } from './logger';

export interface SessionMetadata {
  userId?: string;
  startedAt: Date;
  status: 'active' | 'ended' | 'error';
  endedAt?: Date;
  totalTurns?: number;
}

export interface ConversationTurn {
  userQuery?: string;
  agentResponse: string;
  sourceDocuments: string[];
  latencyMs: number;
  timestamp: Date;
}

export class SessionStore {
  private db: Firestore;
  private readonly SESSIONS_COLLECTION = 'guardianeye_sessions';
  private readonly TURNS_SUBCOLLECTION = 'turns';

  constructor() {
    this.db = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      // In Cloud Run, uses ADC automatically
    });
  }

  async createSession(sessionId: string, metadata: SessionMetadata): Promise<void> {
    try {
      await this.db
        .collection(this.SESSIONS_COLLECTION)
        .doc(sessionId)
        .set({
          ...metadata,
          startedAt: Timestamp.fromDate(metadata.startedAt),
          createdAt: Timestamp.now(),
        });
      logger.debug(`Session created in Firestore: ${sessionId}`);
    } catch (error) {
      logger.error('Firestore createSession error:', error);
      // Non-fatal — don't break the session if Firestore is unavailable
    }
  }

  async saveTurn(sessionId: string, turn: ConversationTurn): Promise<void> {
    try {
      await this.db
        .collection(this.SESSIONS_COLLECTION)
        .doc(sessionId)
        .collection(this.TURNS_SUBCOLLECTION)
        .add({
          ...turn,
          timestamp: Timestamp.fromDate(turn.timestamp),
        });
    } catch (error) {
      logger.error('Firestore saveTurn error:', error);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    try {
      const turnsSnap = await this.db
        .collection(this.SESSIONS_COLLECTION)
        .doc(sessionId)
        .collection(this.TURNS_SUBCOLLECTION)
        .count()
        .get();

      await this.db
        .collection(this.SESSIONS_COLLECTION)
        .doc(sessionId)
        .update({
          status: 'ended',
          endedAt: Timestamp.now(),
          totalTurns: turnsSnap.data().count,
        });
    } catch (error) {
      logger.error('Firestore endSession error:', error);
    }
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    try {
      const doc = await this.db
        .collection(this.SESSIONS_COLLECTION)
        .doc(sessionId)
        .get();

      if (!doc.exists) return null;
      return doc.data() as SessionMetadata;
    } catch (error) {
      logger.error('Firestore getSession error:', error);
      return null;
    }
  }
}
