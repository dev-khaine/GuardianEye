import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGuardianStore } from './stores/guardianStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useCamera } from './hooks/useCamera';
import { useAudio } from './hooks/useAudio';
import { Viewfinder } from './components/Viewfinder';
import { TranscriptLog } from './components/TranscriptLog';
import { StatusBar } from './components/StatusBar';
import { SpatialOverlay } from './components/SpatialOverlay';
import { EmergencyStop } from './components/EmergencyStop';
import { ControlBar } from './components/ControlBar';
import './styles/globals.css';

export default function App() {
  const { status, sessionId, isConnected } = useGuardianStore();
  const { connect, disconnect, sendText, interrupt } = useWebSocket();
  const { videoRef, startCamera, stopCamera, captureFrame, isCameraActive } = useCamera();
  const { startRecording, stopRecording, isRecording } = useAudio();

  const frameIntervalRef = useRef<ReturnType<typeof setInterval>>();

  const handleStart = useCallback(async () => {
    await connect();
    await startCamera();
    await startRecording();

    // Stream frames at 1fps for analysis (higher rate for context is handled in WS hook)
    frameIntervalRef.current = setInterval(() => {
      const frame = captureFrame();
      if (frame) {
        useGuardianStore.getState().sendFrame(frame);
      }
    }, 1000);
  }, [connect, startCamera, startRecording, captureFrame]);

  const handleStop = useCallback(async () => {
    clearInterval(frameIntervalRef.current);
    stopRecording();
    stopCamera();
    disconnect();
  }, [stopRecording, stopCamera, disconnect]);

  const handleEmergencyStop = useCallback(() => {
    interrupt();
    useGuardianStore.getState().addTranscript({
      role: 'system',
      text: '⏹ Agent stopped by user.',
      timestamp: Date.now(),
    });
  }, [interrupt]);

  return (
    <div className="guardian-app">
      {/* Ambient background */}
      <div className="bg-atmosphere" />

      <header className="guardian-header">
        <div className="logo-mark">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path d="M14 2L3 7v8c0 6.075 4.477 11.742 11 13 6.523-1.258 11-6.925 11-13V7L14 2z"
              fill="url(#shieldGrad)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5"/>
            <circle cx="14" cy="13" r="4" fill="rgba(255,255,255,0.9)"/>
            <circle cx="14" cy="13" r="2" fill="url(#eyeGrad)"/>
            <defs>
              <linearGradient id="shieldGrad" x1="3" y1="2" x2="25" y2="22">
                <stop offset="0%" stopColor="#00d4ff"/>
                <stop offset="100%" stopColor="#0066ff"/>
              </linearGradient>
              <linearGradient id="eyeGrad" x1="12" y1="11" x2="16" y2="15">
                <stop offset="0%" stopColor="#001529"/>
                <stop offset="100%" stopColor="#003d7a"/>
              </linearGradient>
            </defs>
          </svg>
          <span className="logo-text">GuardianEye <span className="logo-live">LIVE</span></span>
        </div>
        <StatusBar />
      </header>

      <main className="guardian-main">
        {/* Left: Live Viewfinder */}
        <section className="viewfinder-panel">
          <div className="viewfinder-wrapper">
            <Viewfinder videoRef={videoRef} isActive={isCameraActive} />
            <SpatialOverlay />
            {/* Scanline effect */}
            <div className="scanline-overlay" />
          </div>

          {/* Camera controls */}
          <ControlBar
            isActive={isConnected}
            isRecording={isRecording}
            isCameraActive={isCameraActive}
            onStart={handleStart}
            onStop={handleStop}
            onTextInput={sendText}
          />
        </section>

        {/* Right: Transcript + Info */}
        <section className="transcript-panel">
          <TranscriptLog />
        </section>
      </main>

      {/* Emergency Stop — always visible when connected */}
      <AnimatePresence>
        {isConnected && (
          <EmergencyStop onStop={handleEmergencyStop} />
        )}
      </AnimatePresence>
    </div>
  );
}
