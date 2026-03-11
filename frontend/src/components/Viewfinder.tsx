import { RefObject } from 'react';
import { motion } from 'framer-motion';
import { useGuardianStore } from '../stores/guardianStore';

interface ViewfinderProps {
  videoRef: RefObject<HTMLVideoElement>;
  isActive: boolean;
}

export function Viewfinder({ videoRef, isActive }: ViewfinderProps) {
  const status = useGuardianStore(s => s.status);

  return (
    <div className="viewfinder">
      {/* Inactive state */}
      {!isActive && (
        <div className="viewfinder-idle">
          <div className="idle-icon">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <path d="M24 4L5 13v14c0 10.5 7.7 20.3 19 23 11.3-2.7 19-12.5 19-23V13L24 4z"
                fill="rgba(0,180,255,0.1)" stroke="rgba(0,180,255,0.4)" strokeWidth="1"/>
              <circle cx="24" cy="22" r="7" stroke="rgba(0,180,255,0.6)" strokeWidth="1.5" fill="none"/>
              <circle cx="24" cy="22" r="3" fill="rgba(0,180,255,0.8)"/>
            </svg>
          </div>
          <p className="idle-text">Camera Inactive</p>
          <p className="idle-subtext">Press START to activate GuardianEye</p>
        </div>
      )}

      {/* Video feed */}
      <video
        ref={videoRef}
        className={`viewfinder-video ${isActive ? 'active' : 'hidden'}`}
        playsInline
        muted
        autoPlay
      />

      {/* Corner brackets — tactical UI */}
      <div className="vf-corners">
        <span className="corner tl" />
        <span className="corner tr" />
        <span className="corner bl" />
        <span className="corner br" />
      </div>

      {/* Status indicator */}
      {isActive && (
        <div className="vf-status-badge">
          <motion.div
            className={`status-dot ${status}`}
            animate={{ opacity: status === 'speaking' ? [1, 0.4, 1] : 1 }}
            transition={{ repeat: Infinity, duration: 0.8 }}
          />
          <span className="status-label">{STATUS_LABELS[status] || status.toUpperCase()}</span>
        </div>
      )}

      {/* Thinking indicator */}
      {status === 'thinking' && (
        <div className="thinking-overlay">
          <div className="thinking-pulse">
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                className="pulse-ring"
                animate={{ scale: [1, 1.8], opacity: [0.6, 0] }}
                transition={{ repeat: Infinity, duration: 1.5, delay: i * 0.4 }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'IDLE',
  connecting: 'CONNECTING',
  listening: '● LIVE',
  thinking: '⟳ ANALYZING',
  speaking: '◆ SPEAKING',
  interrupted: 'PAUSED',
  error: '! ERROR',
};
