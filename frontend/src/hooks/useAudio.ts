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

// useAudioPlayer.ts — PCM audio playback via Web Audio API
export function useAudioPlayer() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  const getAudioContext = (): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
    return audioContextRef.current;
  };

  const playAudioChunk = useCallback((base64Data: string, mimeType: string) => {
    try {
      const ctx = getAudioContext();
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // Handle PCM audio from Gemini (16-bit little-endian at 24kHz)
      if (mimeType.includes('pcm') || mimeType.includes('audio/l16')) {
        const samples = new Int16Array(bytes.buffer);
        const floatSamples = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          floatSamples[i] = samples[i] / 32768.0;
        }

        const buffer = ctx.createBuffer(1, floatSamples.length, 24000);
        buffer.copyToChannel(floatSamples, 0);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        // Schedule seamless playback (gapless audio)
        const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
        source.start(startTime);
        nextPlayTimeRef.current = startTime + buffer.duration;
      }
    } catch (err) {
      console.error('Audio playback error:', err);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    audioContextRef.current?.suspend();
    nextPlayTimeRef.current = 0;
  }, []);

  return { playAudioChunk, stopPlayback };
}
