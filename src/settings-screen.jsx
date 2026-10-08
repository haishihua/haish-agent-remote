import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleAlert, Laptop, LoaderCircle, LogOut, Monitor, RefreshCw, Settings2, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import { api } from './api.js';
import './settings-screen.css';

function lastSeen(value) {
  const date = new Date(Number(value) * 1000);
  if (!value || !Number.isFinite(date.getTime())) return 'Last seen unavailable';
  return `Last seen ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)}`;
}

function DeviceGlyph({ name = '' }) {
  const Glyph = /ipad|tablet/i.test(name) ? Tablet
    : /iphone|android|phone/i.test(name) ? Smartphone
      : /mac|windows|linux|desktop|computer/i.test(name) ? Laptop : Monitor;
  return <Glyph size={24} strokeWidth={1.7} aria-hidden="true" />;
}

// Decorative only: this is not a preview of an active desktop session.
function ComputerVisual() {
  return <div className="settings-computer-visual" aria-hidden="true">
    <div className="settings-laptop-display">
      <div className="settings-laptop-wallpaper"><span /><i /><b /></div>
      <div className="settings-laptop-camera" />
    </div>
    <div className="settings-laptop-base"><span /></div>
    <div className="settings-laptop-shadow" />
  </div>;
}

const READINESS_FIELDS = [
  ['enabled', 'Desktop access', 'Enabled', 'Disabled'],
  ['supported', 'Desktop capture', 'Supported', 'Unavailable'],
  ['screen_recording', 'Screen Recording', 'Granted', 'Not granted'],
  ['accessibility', 'Accessibility', 'Granted', 'Not granted'],
  ['unlocked', 'Computer unlocked', 'Yes', 'No'],
  ['busy', 'Desktop session', 'In use', 'Not in use'],
  ['turn_configured', 'TURN relay', 'Configured', 'Not configured'],
];

export default function SettingsScreen({ status, onLogout, onBack, onDesktop }) {
  const currentId = status.device?.device_id;
  const currentDevice = useRef(status.device);
  currentDevice.current = status.device;
  const mounted = useRef(false);
  const devicesRequest = useRef(0);
  const desktopRequest = useRef(0);
  const actionPending = useRef(false);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const [desktop, setDesktop] = useState(null);
  const [desktopLoading, setDesktopLoading] = useState(false);
  const [desktopError, setDesktopError] = useState('');
  const online = status.runtime_online === true;
  const connectionLabel = online ? 'Online' : status.runtime_online === false ? 'Offline' : 'Unknown';

  const loadDevices = useCallback(async () => {
    const request = ++devicesRequest.current;
    setLoading(true);
    setListError('');
    try {
      const listed = (await api.devices()).devices || [];
      if (!mounted.current || request !== devicesRequest.current) return;
      const current = currentDevice.current;
      setDevices(current && !listed.some((device) => device.device_id === current.device_id)
        ? [current, ...listed] : listed);
    } catch (error) {
      if (!mounted.current || request !== devicesRequest.current) return;
      setDevices((previous) => previous.length ? previous : currentDevice.current ? [currentDevice.current] : []);
      setListError(error.message || 'Unable to load paired devices.');
    } finally {
      if (mounted.current && request === devicesRequest.current) setLoading(false);
    }
  }, [currentId]);

  useEffect(() => {
    mounted.current = true;
    loadDevices();
    return () => {
      mounted.current = false;
      devicesRequest.current += 1;
      desktopRequest.current += 1;
    };
  }, [loadDevices]);

  async function loadDesktop() {
    const request = ++desktopRequest.current;
    setDesktopLoading(true);
    setDesktopError('');
    setDesktop(null);
    try {
      const result = await api.desktopStatus();
      if (mounted.current && request === desktopRequest.current) setDesktop(result);
    } catch (error) {
      if (mounted.current && request === desktopRequest.current) setDesktopError(error.message || 'Unable to check desktop readiness.');
    } finally {
      if (mounted.current && request === desktopRequest.current) setDesktopLoading(false);
    }
  }

  function toggleManage() {
    setManageOpen(!manageOpen);
    if (!manageOpen) loadDesktop();
  }

  async function confirmAction(device) {
    if (actionPending.current) return;
    const signingOut = !device || device.device_id === currentId;
    const name = device?.name || 'this device';
    const confirmed = window.confirm(signingOut
      ? 'Sign out this device? Its pairing will be removed. You will need a new pairing code to reconnect.'
      : `Revoke access for ${name}? Its active remote desktop session will end, and it will need to pair again to reconnect.`);
    if (!confirmed) return;
    actionPending.current = true;
    setBusy(signingOut ? 'logout' : device.device_id);
    setActionError('');
    setNotice('');
    try {
      if (signingOut) {
        // Keep the app's existing logout/local connection cleanup behavior.
        await onLogout();
      } else {
        await api.revokeDevice(device.device_id);
        if (!mounted.current) return;
        setDevices((previous) => previous.filter((item) => item.device_id !== device.device_id));
        setNotice(`Access revoked for ${name}.`);
        await loadDevices();
      }
    } catch (error) {
      if (mounted.current) setActionError(error.message || 'Unable to complete this action. Please try again.');
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy('');
    }
  }

  return <main className="settings-page">
    <header className="settings-page-header">
      <button type="button" className="settings-back" onClick={onBack} aria-label="Back to conversations" disabled={Boolean(busy)}><ArrowLeft size={23} /></button>
      <h1>Settings</h1>
      <span aria-hidden="true" />
    </header>

    <section className="settings-computer-card" aria-labelledby="settings-computer-name">
      <div className="settings-computer-summary">
        <ComputerVisual />
        <div className="settings-computer-copy">
          <p className="settings-overline">Connected computer</p>
          <h2 id="settings-computer-name">{status.computer_model || 'Computer model unavailable'}</h2>
          <p className={`settings-computer-status ${online ? 'is-online' : ''}`} role="status"><span />{connectionLabel}</p>
          <p className="settings-computer-subtitle">{online ? 'Haish runtime connected.' : status.runtime_online === false ? 'Haish runtime is offline.' : 'Runtime status unavailable.'}</p>
        </div>
      </div>
      <div className="settings-computer-actions">
        <button type="button" className="settings-open-remote" onClick={onDesktop} disabled={!online || Boolean(busy)}><Monitor size={18} />Open Remote<ChevronRight size={16} aria-hidden="true" /></button>
        <button type="button" className="settings-manage" onClick={toggleManage} aria-expanded={manageOpen} aria-controls="settings-desktop-readiness" disabled={Boolean(busy)}><Settings2 size={17} />Manage<ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    </section>
    <p className="settings-remote-note">{status.runtime_online === false ? 'Open Haish on your computer to reconnect.' : 'Desktop access requires local permission.'}</p>

    {manageOpen ? <section className="settings-readiness" id="settings-desktop-readiness" aria-labelledby="settings-readiness-title">
      <div className="settings-panel-heading"><h2 id="settings-readiness-title">Desktop readiness</h2><button type="button" onClick={loadDesktop} disabled={desktopLoading || Boolean(busy)} aria-label="Refresh desktop readiness"><RefreshCw size={17} className={desktopLoading ? 'spin' : ''} /></button></div>
      <p className="settings-readonly"><ShieldCheck size={15} />Read-only · checked on request</p>
      {desktopLoading ? <p className="settings-loading" role="status"><LoaderCircle size={17} className="spin" />Checking computer…</p> : null}
      {desktopError ? <p className="settings-error" role="alert"><CircleAlert size={17} />{desktopError}</p> : null}
      {desktop ? <dl className="settings-readiness-list">{READINESS_FIELDS.map(([key, label, yes, no]) => <div key={key}><dt>{label}</dt><dd className={desktop[key] === true && key !== 'busy' ? 'is-ready' : ''}>{desktop[key] === true ? yes : desktop[key] === false ? no : 'Unknown'}</dd></div>)}</dl> : null}
      <div className="settings-local-guide">
        <h3>Manage on your computer</h3>
        <p>On the Haish computer, open <span className="settings-local-address">http://127.0.0.1:8767</span> in its browser to enable or disable desktop access.</p>
        <p>On a supported Mac, grant Screen Recording and Accessibility in System Settings → Privacy &amp; Security. Keep the Mac awake and unlocked. Permissions may require restarting the adapter.</p>
        <p>This device cannot change those permissions. Readiness does not guarantee a remote connection.</p>
      </div>
    </section> : null}

    <section className="settings-paired-section" aria-labelledby="settings-paired-title">
      <div className="settings-paired-heading">
        <h2 id="settings-paired-title">Paired devices</h2>
        <div className="settings-paired-tools">
          <span className="settings-device-count" aria-label={loading ? 'Loading device count' : listError ? 'Device count unavailable' : `${devices.length} paired devices`}>{loading || listError ? '—' : devices.length} devices</span>
          <button type="button" onClick={loadDevices} disabled={loading || Boolean(busy)} aria-label="Refresh paired devices"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>
      <div className="settings-devices" aria-busy={loading}>
        {loading && !devices.length ? <p className="settings-loading" role="status"><LoaderCircle size={18} className="spin" />Loading paired devices…</p> : null}
        {devices.map((device) => {
          const current = device.device_id === currentId;
          const pending = busy === (current ? 'logout' : device.device_id);
          return <div className="settings-device" key={device.device_id}>
            <span className="settings-device-glyph"><DeviceGlyph name={device.name} /></span>
            <div className="settings-device-copy"><strong>{device.name || 'Unnamed device'}</strong>{current ? <span className="settings-current-device">This device</span> : null}<small>{lastSeen(device.last_seen_at)}</small></div>
            <button type="button" className="settings-revoke" disabled={Boolean(busy) || loading} onClick={() => confirmAction(device)} aria-label={`${current ? 'Sign out' : 'Revoke access for'} ${device.name || 'unnamed device'}`}>
              {pending ? <LoaderCircle size={16} className="spin" /> : null}{current ? 'Sign out' : 'Revoke'}<ChevronRight size={13} aria-hidden="true" />
            </button>
          </div>;
        })}
        {!loading && !listError && !devices.length ? <p className="settings-empty">No paired devices found.</p> : null}
      </div>
      {listError ? <div className="settings-list-failure"><p className="settings-error" role="alert"><CircleAlert size={17} />{listError}</p><p>The full device list is unavailable. Any rows shown are previously known devices.</p><button type="button" onClick={loadDevices} disabled={loading || Boolean(busy)}>Try again</button></div> : null}
    </section>

    {actionError ? <p className="settings-error" role="alert"><CircleAlert size={17} />{actionError}</p> : null}
    {notice ? <p className="settings-notice" role="status"><Check size={17} />{notice}</p> : null}
    <div className="settings-signout-area">
      <button type="button" className="settings-signout" onClick={() => confirmAction()} disabled={Boolean(busy)}>
        <span className="settings-signout-glyph">{busy === 'logout' ? <LoaderCircle size={23} className="spin" /> : <LogOut size={23} />}</span>
        <span><strong>{busy === 'logout' ? 'Signing out…' : 'Sign out this device'}</strong><small>Remove this device’s access to Haish</small></span>
        <ChevronRight size={19} aria-hidden="true" />
      </button>
      <p className="settings-footer"><ShieldCheck size={14} />Only paired devices can access your computer.</p>
    </div>
  </main>;
}
