import React, { useState, useEffect } from 'react';
import { IconBack, IconLock } from '../components/Icons';

interface Props {
  address: string | null;
  onBack: () => void;
  onLock: () => void;
  onReconfigure: () => void;
}

const TIMEOUT_OPTIONS = [
  { label: '1 minute', value: 60_000 },
  { label: '2 minutes', value: 120_000 },
  { label: '5 minutes', value: 300_000 },
  { label: '10 minutes', value: 600_000 },
  { label: '30 minutes', value: 1_800_000 },
];

export function SettingsScreen({ address, onBack, onLock, onReconfigure }: Props) {
  const [rpcHost, setRpcHost] = useState('');
  const [rpcPort, setRpcPort] = useState('');
  const [lockTimeout, setLockTimeout] = useState(300_000);
  const [requirePasswordOnSend, setRequirePasswordOnSend] = useState(true);
  const [pwPrompt, setPwPrompt] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState('');

  useEffect(() => {
    chrome.storage.local.get(['rpcHost', 'rpcPort', 'requirePasswordOnSend'], (data) => {
      setRpcHost(data.rpcHost || '127.0.0.1');
      setRpcPort(data.rpcPort || '27486');
      if (data.requirePasswordOnSend === false) setRequirePasswordOnSend(false);
    });
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      if (state?.lockTimeout) setLockTimeout(state.lockTimeout);
    });
  }, []);

  function handleTimeoutChange(value: number) {
    setLockTimeout(value);
    chrome.runtime.sendMessage({ type: 'SET_LOCK_TIMEOUT', timeout: value });
  }

  const timeoutLabel = TIMEOUT_OPTIONS.find(o => o.value === lockTimeout)?.label || `${lockTimeout / 60000} min`;

  return (
    <div className="screen">
      <button className="btn-back" onClick={onBack}><IconBack size={16} /> Back</button>
      <h2>Settings</h2>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Daemon Connection</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Host</span><span style={{ fontFamily: 'monospace' }}>{rpcHost}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Port</span><span style={{ fontFamily: 'monospace' }}>{rpcPort}</span></div>
        </div>
        <button className="btn-text" onClick={onReconfigure} style={{ fontSize: 12, marginTop: 6, padding: 0 }}>
          Reconfigure →
        </button>
      </div>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Auto-lock Timer</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TIMEOUT_OPTIONS.map(opt => (
            <button key={opt.value}
              onClick={() => handleTimeoutChange(opt.value)}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
                background: lockTimeout === opt.value ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: lockTimeout === opt.value ? 'white' : 'var(--text-secondary)',
                cursor: 'pointer',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Transaction Security</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12 }}>Password on send</div>
            <div style={{ fontSize: 10, color: 'var(--text-subtle)' }}>Require password for every send transaction</div>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22, cursor: 'pointer' }}>
            <input type="checkbox" checked={requirePasswordOnSend}
              onChange={(e) => {
                if (e.target.checked) {
                  // Turning ON — no password needed
                  setRequirePasswordOnSend(true);
                  chrome.storage.local.set({ requirePasswordOnSend: true });
                } else {
                  // Turning OFF — require password first
                  setPwPrompt(true);
                  setPwInput('');
                  setPwError('');
                }
              }}
              style={{ opacity: 0, width: 0, height: 0 }} />
            <span style={{
              position: 'absolute', inset: 0, borderRadius: 11,
              background: requirePasswordOnSend ? 'var(--accent)' : 'var(--border)',
              transition: '0.2s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: requirePasswordOnSend ? 20 : 2,
                width: 18, height: 18, borderRadius: '50%', background: 'white',
                transition: '0.2s',
              }} />
            </span>
          </label>
        </div>
        {pwPrompt && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--warning)' }}>Enter password to disable send protection</div>
            <input type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pwInput) {
                  chrome.runtime.sendMessage({ type: 'VERIFY_PASSWORD', password: pwInput }, (resp) => {
                    if (resp?.ok) {
                      setRequirePasswordOnSend(false);
                      chrome.storage.local.set({ requirePasswordOnSend: false });
                      setPwPrompt(false);
                    } else {
                      setPwError('Wrong password');
                      setPwInput('');
                    }
                  });
                }
              }}
              placeholder="Wallet password" autoFocus style={{ width: '100%', fontSize: 12 }} />
            {pwError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{pwError}</div>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setPwPrompt(false)}
                style={{ flex: 1, padding: '6px', fontSize: 11, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', cursor: 'pointer', color: 'var(--text-primary)' }}>Cancel</button>
              <button onClick={() => {
                chrome.runtime.sendMessage({ type: 'VERIFY_PASSWORD', password: pwInput }, (resp) => {
                  if (resp?.ok) {
                    setRequirePasswordOnSend(false);
                    chrome.storage.local.set({ requirePasswordOnSend: false });
                    setPwPrompt(false);
                  } else {
                    setPwError('Wrong password');
                    setPwInput('');
                  }
                });
              }} disabled={!pwInput}
                style={{ flex: 1, padding: '6px', fontSize: 11, borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'white', cursor: 'pointer', opacity: pwInput ? 1 : 0.5 }}>Confirm</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Active Address</div>
        <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{address || 'Not set'}</div>
      </div>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--success)' }}>Security</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div>Private keys never leave your machine</div>
          <div>All signing done by Verus daemon</div>
          <div>Password required for every transaction</div>
          <div>Only safe RPC methods allowed</div>
          <div>Auto-locks after {timeoutLabel}</div>
        </div>
      </div>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>About</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Version</span><span style={{ fontFamily: 'monospace' }}>0.1.0</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Architecture</span><span>Direct RPC</span></div>
        </div>
      </div>

      <button className="btn btn-danger" onClick={onLock} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 'auto' }}>
        <IconLock size={14} /> Lock Wallet
      </button>
    </div>
  );
}
