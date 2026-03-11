/**
 * useAudioPlayer — Gapless PCM audio playback via Web Audio API
 *
 * Designed for Gemini Live API output: 16-bit little-endian PCM at 24kHz.
 * Uses scheduled buffer playback so chunks queue seamlessly without gaps or clicks.
 */

import { useRef, useCallback } from 'react';

export function useAudioPlayer() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  const getAudioContext = (): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
    // Resume if suspended (browser autoplay policy)
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  /**
   * Play a single audio chunk from Gemini Live output.
   * @param base64Data  Base64-encoded audio bytes
   * @param mimeType    e.g. 'audio/pcm' or 'audio/l16;rate=24000'
   */
  const playAudioChunk = useCallback((base64Data: string, mimeType: string) => {
    try {
      const ctx = getAudioContext();

      // Decode base64 → raw bytes
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // Handle PCM: 16-bit little-endian signed integers
      if (mimeType.includes('pcm') || mimeType.includes('l16') || mimeType.includes('audio/')) {
        const samples = new Int16Array(bytes.buffer);
        const floatSamples = new Float32Array(samples.length);

        // Normalise to [-1.0, 1.0]
        for (let i = 0; i < samples.length; i++) {
          floatSamples[i] = samples[i] / 32768.0;
        }

        const buffer = ctx.createBuffer(1, floatSamples.length, 24000);
        buffer.copyToChannel(floatSamples, 0);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        // Schedule seamlessly after previous chunk (gapless playback)
        const startTime = Math.max(ctx.currentTime + 0.02, nextPlayTimeRef.current);
        source.start(startTime);
        nextPlayTimeRef.current = startTime + buffer.duration;
      }
    } catch (err) {
      console.error('[useAudioPlayer] Playback error:', err);
    }
  }, []);

  /**
   * Stop and flush any scheduled audio (called on interrupt/barge-in).
   */
  const stopPlayback = useCallback(() => {
    if (audioContextRef.current) {
      // Close and null-out — will be re-created on next chunk
      audioContextRef.current.close();
      audioContextRef.current = null;
      nextPlayTimeRef.current = 0;
    }
  }, []);

  return { playAudioChunk, stopPlayback };
}
