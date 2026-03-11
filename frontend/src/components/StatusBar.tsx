import { useGuardianStore } from '../stores/guardianStore';

export function StatusBar() {
  const { status, isConnected, sessionId } = useGuardianStore();

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
