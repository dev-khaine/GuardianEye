import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGuardianStore } from '../stores/guardianStore';

export function TranscriptLog() {
  const { transcript, currentAgentText } = useGuardianStore();
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
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
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

        {/* Streaming agent text — live typewriter effect */}
        {currentAgentText && (
          <motion.div
            className="transcript-entry agent streaming"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <div className="entry-meta">
              <span className="entry-role">🛡️ GUARDIAN</span>
              <span className="streaming-indicator">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </span>
            </div>
            <p className="entry-text">
              {currentAgentText}
              <span className="cursor" />
            </p>
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
