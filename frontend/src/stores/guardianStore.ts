import { create } from 'zustand';

export type AgentStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error';

export interface TranscriptEntry {
  id?: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  timestamp: number;
  sources?: string[];
  confidence?: number;
}

export interface SpatialAnnotation {
  label: string;
  position: string;
  boundingBox?: { x: number; y: number; w: number; h: number };
}

interface GuardianState {
  // Session
  sessionId: string | null;
  isConnected: boolean;
  status: AgentStatus;

  // Transcript
  transcript: TranscriptEntry[];
  currentAgentText: string;

  // Spatial
  spatialAnnotations: SpatialAnnotation[];

  // Audio
  audioQueue: ArrayBuffer[];

  // WebSocket reference (set by hook)
  _sendFrame: ((frameData: string) => void) | null;

  // Actions
  setSessionId: (id: string) => void;
  setConnected: (connected: boolean) => void;
  setStatus: (status: AgentStatus) => void;
  addTranscript: (entry: TranscriptEntry) => void;
  appendAgentText: (text: string) => void;
  finalizeAgentTurn: () => void;
  setSpatialAnnotations: (annotations: SpatialAnnotation[]) => void;
  enqueueAudio: (buffer: ArrayBuffer) => void;
  dequeueAudio: () => ArrayBuffer | undefined;
  setSendFrame: (fn: (frameData: string) => void) => void;
  sendFrame: (frameData: string) => void;
  reset: () => void;
}

export const useGuardianStore = create<GuardianState>((set, get) => ({
  sessionId: null,
  isConnected: false,
  status: 'idle',
  transcript: [],
  currentAgentText: '',
  spatialAnnotations: [],
  audioQueue: [],
  _sendFrame: null,

  setSessionId: (id) => set({ sessionId: id }),
  setConnected: (connected) => set({ isConnected: connected }),
  setStatus: (status) => set({ status }),

  addTranscript: (entry) =>
    set((state) => ({
      transcript: [
        ...state.transcript,
        { ...entry, id: `${entry.role}-${Date.now()}-${Math.random()}` },
      ].slice(-100), // Keep last 100 entries
    })),

  appendAgentText: (text) =>
    set((state) => ({ currentAgentText: state.currentAgentText + text })),

  finalizeAgentTurn: () => {
    const { currentAgentText, addTranscript } = get();
    if (currentAgentText.trim()) {
      addTranscript({
        role: 'agent',
        text: currentAgentText,
        timestamp: Date.now(),
      });
    }
    set({ currentAgentText: '', status: 'listening' });
  },

  setSpatialAnnotations: (annotations) => set({ spatialAnnotations: annotations }),

  enqueueAudio: (buffer) =>
    set((state) => ({ audioQueue: [...state.audioQueue, buffer] })),

  dequeueAudio: () => {
    const queue = get().audioQueue;
    if (queue.length === 0) return undefined;
    set({ audioQueue: queue.slice(1) });
    return queue[0];
  },

  setSendFrame: (fn) => set({ _sendFrame: fn }),

  sendFrame: (frameData) => {
    const fn = get()._sendFrame;
    if (fn) fn(frameData);
  },

  reset: () => set({
    sessionId: null,
    isConnected: false,
    status: 'idle',
    transcript: [],
    currentAgentText: '',
    spatialAnnotations: [],
    audioQueue: [],
  }),
}));
