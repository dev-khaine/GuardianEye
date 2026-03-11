import { AnimatePresence, motion } from 'framer-motion';
import { useGuardianStore } from '../stores/guardianStore';

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
  const annotations = useGuardianStore(s => s.spatialAnnotations);

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
