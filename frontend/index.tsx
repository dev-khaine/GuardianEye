// TranscriptLog.tsx
import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGuardianStore } from '../stores/guardianStore';

export function TranscriptLog() {
  const { transcript, currentAgentText, status } = useGuardianStore();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, currentAgentText]);

  return (
    <div className="transcript-container">
      <div className="transcript-header">
        <span className="transcript-title">CONVERSATION LOG</span>
        <span className="transcript-count">{transcript.length} turns</span>
      </div>

      <div className="transcript-scroll">
        <AnimatePresence initial={false}>
          {transcript.map((entry) => (
            <motion.div
              key={entry.id}
              className={`transcript-entry ${entry.role}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="entry-meta">
                <span className="entry-role">
                  {entry.role === 'user' ? '👤 YOU' : entry.role === 'agent' ? '🛡️ GUARDIAN' : '⚙️ SYSTEM'}
                </span>
                <span className="entry-time">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
              <p className="entry-text">{entry.text}</p>
              {entry.sources && entry.sources.length > 0 && (
                <div className="entry-sources">
                  <span className="sources-label">📚 Sources:</span>
                  {entry.sources.map((s, i) => (
                    <span key={i} className="source-tag">{s}</span>
                  ))}
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Streaming agent text */}
        {currentAgentText && (
          <motion.div
            className="transcript-entry agent streaming"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <div className="entry-meta">
              <span className="entry-role">🛡️ GUARDIAN</span>
              <span className="streaming-indicator">
                <span className="dot" /><span className="dot" /><span className="dot" />
              </span>
            </div>
            <p className="entry-text">{currentAgentText}<span className="cursor" /></p>
          </motion.div>
        )}

        {/* Empty state */}
        {transcript.length === 0 && !currentAgentText && (
          <div className="transcript-empty">
            <p>Conversation will appear here.</p>
            <p className="empty-hint">Start a session and speak, or type a question below.</p>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// StatusBar.tsx
import { useGuardianStore as useStore } from '../stores/guardianStore';

export function StatusBar() {
  const { status, isConnected, sessionId } = useStore();

  return (
    <div className="status-bar">
      <div className={`connection-pill ${isConnected ? 'connected' : 'disconnected'}`}>
        <span className="pill-dot" />
        {isConnected ? 'CONNECTED' : 'OFFLINE'}
      </div>
      {sessionId && (
        <span className="session-id">
          SID: {sessionId.slice(0, 8)}…
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// SpatialOverlay.tsx
import { useGuardianStore as useSpatialStore } from '../stores/guardianStore';

const POSITION_STYLES: Record<string, React.CSSProperties> = {
  'top-left':      { top: '8%', left: '8%' },
  'top-center':    { top: '8%', left: '50%', transform: 'translateX(-50%)' },
  'top-right':     { top: '8%', right: '8%' },
  'center-left':   { top: '50%', left: '8%', transform: 'translateY(-50%)' },
  'center':        { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
  'center-right':  { top: '50%', right: '8%', transform: 'translateY(-50%)' },
  'bottom-left':   { bottom: '8%', left: '8%' },
  'bottom-center': { bottom: '8%', left: '50%', transform: 'translateX(-50%)' },
  'bottom-right':  { bottom: '8%', right: '8%' },
};

export function SpatialOverlay() {
  const annotations = useSpatialStore(s => s.spatialAnnotations);

  return (
    <div className="spatial-overlay" aria-hidden="true">
      <AnimatePresence>
        {annotations.map((ann, i) => (
          <motion.div
            key={`${ann.label}-${i}`}
            className="spatial-tag"
            style={POSITION_STYLES[ann.position] || { top: '50%', left: '50%' }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.3, delay: i * 0.08 }}
          >
            <span className="spatial-dot" />
            <span className="spatial-label">{ann.label}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// EmergencyStop.tsx
interface EmergencyStopProps { onStop: () => void; }

export function EmergencyStop({ onStop }: EmergencyStopProps) {
  return (
    <motion.div
      className="emergency-stop-wrapper"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
    >
      <button
        className="emergency-stop-btn"
        onClick={onStop}
        aria-label="Emergency stop — interrupt agent immediately"
        title="Say 'stop' or click to interrupt the agent"
      >
        <span className="stop-icon">⏹</span>
        <span className="stop-text">STOP</span>
        <span className="stop-hint">or say "stop"</span>
      </button>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ControlBar.tsx
import { useState } from 'react';
import { Mic, MicOff, Camera, CameraOff, Send, Play, Square } from 'lucide-react';

interface ControlBarProps {
  isActive: boolean;
  isRecording: boolean;
  isCameraActive: boolean;
  onStart: () => void;
  onStop: () => void;
  onTextInput: (text: string) => void;
}

export function ControlBar({ isActive, isRecording, isCameraActive, onStart, onStop, onTextInput }: ControlBarProps) {
  const [inputText, setInputText] = useState('');

  const handleSubmit = () => {
    if (!inputText.trim()) return;
    onTextInput(inputText.trim());
    setInputText('');
  };

  return (
    <div className="control-bar">
      {/* Main action */}
      {!isActive ? (
        <button className="btn-start" onClick={onStart}>
          <Play size={18} />
          START SESSION
        </button>
      ) : (
        <button className="btn-end" onClick={onStop}>
          <Square size={18} />
          END SESSION
        </button>
      )}

      {/* Status indicators */}
      <div className="indicator-group">
        <div className={`indicator ${isRecording ? 'active' : ''}`}>
          {isRecording ? <Mic size={14} /> : <MicOff size={14} />}
          <span>{isRecording ? 'MIC ON' : 'MIC OFF'}</span>
        </div>
        <div className={`indicator ${isCameraActive ? 'active' : ''}`}>
          {isCameraActive ? <Camera size={14} /> : <CameraOff size={14} />}
          <span>{isCameraActive ? 'CAM ON' : 'CAM OFF'}</span>
        </div>
      </div>

      {/* Text input */}
      {isActive && (
        <div className="text-input-group">
          <input
            className="text-input"
            type="text"
            placeholder="Type a question or command..."
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          />
          <button className="btn-send" onClick={handleSubmit} disabled={!inputText.trim()}>
            <Send size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
