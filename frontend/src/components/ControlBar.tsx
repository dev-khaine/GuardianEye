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

export function ControlBar({
  isActive,
  isRecording,
  isCameraActive,
  onStart,
  onStop,
  onTextInput,
}: ControlBarProps) {
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
          <button
            className="btn-send"
            onClick={handleSubmit}
            disabled={!inputText.trim()}
          >
            <Send size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
