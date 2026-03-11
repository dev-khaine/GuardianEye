// useAudio.ts — Microphone capture with VAD
import { useRef, useState, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';

export function useAudio() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const { sendAudioChunk } = useWebSocket();

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 16000,
      });

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          // Convert blob to base64 for WebSocket transmission
          const buffer = await event.data.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
          sendAudioChunk(base64);
        }
      };

      // 100ms chunks for low-latency streaming
      mediaRecorder.start(100);
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
    } catch (err) {
      console.error('Microphone access denied:', err);
      throw err;
    }
  }, [sendAudioChunk]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
    mediaRecorderRef.current = null;
    setIsRecording(false);
  }, []);

  return { startRecording, stopRecording, isRecording };
}
