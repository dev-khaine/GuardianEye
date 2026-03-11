import { motion } from 'framer-motion';

interface EmergencyStopProps {
  onStop: () => void;
}

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
