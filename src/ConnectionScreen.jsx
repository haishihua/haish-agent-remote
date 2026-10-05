import React from 'react';
import { CircleAlert, Laptop, LockKeyhole, RefreshCw, Smartphone } from 'lucide-react';
import penguinLogo from './assets/penguin_logo_user.png';

// Startup presentation only: pairing, timeout and retry behavior stay in App.
export default function ConnectionScreen({ error, retrying, onRetry }) {
  const failed = Boolean(error);
  return (
    <main className={`connection-screen ${failed ? 'failed' : ''}`}>
      <div className="connection-brand">
        <img src={penguinLogo} alt="" draggable="false" />
        <span>Haish</span>
      </div>
      <section className="connection-panel" aria-labelledby="connection-title" aria-busy={!failed || retrying}>
        <div className="connection-visual" aria-hidden="true">
          <div className="connection-endpoint">
            <span className="connection-device"><Laptop strokeWidth={1.4} /></span>
          </div>
          <span className="connection-route"><i /><b>{failed ? <CircleAlert size={18} /> : <span />}</b><i /></span>
          <div className="connection-endpoint">
            <span className="connection-device phone"><Smartphone strokeWidth={1.4} /></span>
            <span className="connection-device-label">This iPhone</span>
          </div>
        </div>
        <h1 id="connection-title">{failed ? 'Can’t reach your computer' : 'Connecting to Haish'}</h1>
        <p>{failed
          ? 'Keep Haish open on your computer and check that this device has internet access.'
          : 'Waking your remote workspace and syncing your tasks…'}</p>
        <div className="connection-status" role="status" aria-live="polite">
          {!failed || retrying ? <span className="connection-spinner" aria-hidden="true" /> : null}
          <span>{failed ? (retrying ? 'Trying again…' : 'Connection paused') : 'Connecting…'}</span>
        </div>
        {failed ? <button type="button" className="connection-retry" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={retrying ? 'spin' : ''} size={19} aria-hidden="true" />
          {retrying ? 'Trying again…' : 'Try again'}
        </button> : null}
      </section>
      {/* HTTPS protects transport; do not claim end-to-end encryption through the proxy. */}
      <p className="connection-security"><LockKeyhole size={16} aria-hidden="true" /> Encrypted connection</p>
    </main>
  );
}
