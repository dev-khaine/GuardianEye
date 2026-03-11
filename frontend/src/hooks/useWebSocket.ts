import { useRef, useCallback } from 'react';
import { useGuardianStore } from '../stores/guardianStore';
import { useAudioPlayer } from './useAudioPlayer';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/live';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const { playAudioChunk } = useAudioPlayer();
  const store = useGuardianStore();

  const connect = useCallback(async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      store.setStatus('connecting');

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        const sessionId = crypto.randomUUID();
        ws.send(JSON.stringify({
          type: 'START_SESSION',
          sessionId,
          payload: { userId: localStorage.getItem('guardian_user_id') || undefined },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string);
          handleServerMessage(message, store, playAudioChunk, resolve);
        } catch (err) {
          console.error('WS message parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        store.setStatus('error');
        reject(err);
      };

      ws.onclose = () => {
        store.setConnected(false);
        store.setStatus('idle');
        wsRef.current = null;
      };

      // Register frame sender
      store.setSendFrame((frameData: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'VIDEO_FRAME',
            payload: { data: frameData, mimeType: 'image/jpeg' },
          }));
        }
      });
    });
  }, [store, playAudioChunk]);

  const disconnect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'END_SESSION' }));
      wsRef.current.close(1000);
    }
    store.reset();
  }, [store]);

  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      store.addTranscript({ role: 'user', text, timestamp: Date.now() });
      wsRef.current.send(JSON.stringify({
        type: 'USER_TEXT',
        payload: { text },
      }));
      store.setStatus('thinking');
    }
  }, [store]);

  const sendAudioChunk = useCallback((audioData: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'AUDIO_CHUNK',
        payload: { data: audioData },
      }));
    }
  }, []);

  const interrupt = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'INTERRUPT' }));
    }
  }, []);

  return { connect, disconnect, sendText, sendAudioChunk, interrupt };
}

// ── Message Handler ───────────────────────────────────────────────────────────

function handleServerMessage(
  message: { type: string; sessionId: string; payload: Record<string, unknown>; timestamp: number },
  store: ReturnType<typeof useGuardianStore.getState>,
  playAudioChunk: (data: string, mimeType: string) => void,
  onReady: () => void
): void {
  switch (message.type) {
    case 'SESSION_READY':
      store.setSessionId(message.sessionId);
      store.setConnected(true);
      store.setStatus('listening');
      onReady();
      break;

    case 'AGENT_AUDIO':
      store.setStatus('speaking');
      playAudioChunk(
        message.payload.audioData as string,
        (message.payload.mimeType as string) || 'audio/pcm'
      );
      break;

    case 'AGENT_TEXT':
      store.setStatus('speaking');
      store.appendAgentText(message.payload.text as string);
      break;

    case 'TRANSCRIPT_UPDATE':
      if (message.payload.isFinal) {
        store.finalizeAgentTurn();
      }
      break;

    case 'SPATIAL_ANNOTATION':
      store.setSpatialAnnotations(
        (message.payload.annotations as ReturnType<typeof store.spatialAnnotations>) || []
      );
      break;

    case 'SAFETY_ALERT':
      store.addTranscript({
        role: 'system',
        text: `🚨 SAFETY ALERT: ${message.payload.message}`,
        timestamp: message.timestamp,
      });
      store.setStatus('speaking');
      break;

    case 'AGENT_INTERRUPTED':
      store.setStatus('listening');
      store.finalizeAgentTurn();
      break;

    case 'ERROR':
      store.addTranscript({
        role: 'system',
        text: `Error: ${message.payload.message}`,
        timestamp: message.timestamp,
      });
      store.setStatus('error');
      break;

    case 'SESSION_ENDED':
      store.reset();
      break;
  }
}
