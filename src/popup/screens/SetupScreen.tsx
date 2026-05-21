import React, { useState } from 'react';

interface Props {
  onConnected: () => void;
}

export function SetupScreen({ onConnected }: Props) {
  const [step, setStep] = useState<'paste' | 'manual'>('paste');
  const [pastedConf, setPastedConf] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('27486');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const COPY_CMD = 'cat ~/.komodo/VRSC/VRSC.conf | grep -E "rpcuser|rpcpassword|rpcport"';

  function copyCommand() {
    navigator.clipboard.writeText(COPY_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function parseConf(text: string) {
    let u = '', p = '', pt = '27486';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('rpcuser=')) u = t.split('=')[1].trim();
      if (t.startsWith('rpcpassword=')) p = t.split('=')[1].trim();
      if (t.startsWith('rpcport=')) pt = t.split('=')[1].trim();
    }
    return { user: u, pass: p, port: pt };
  }

  function handlePaste() {
    const parsed = parseConf(pastedConf);
    if (!parsed.user || !parsed.pass) {
      setError('Could not find rpcuser and rpcpassword in the pasted text.');
      return;
    }
    setUser(parsed.user);
    setPass(parsed.pass);
    setPort(parsed.port);
    setError('');
    testConnection(parsed.user, parsed.pass, parsed.port);
  }

  function testConnection(u?: string, p?: string, pt?: string) {
    setTesting(true);
    setError('');
    chrome.runtime.sendMessage({
      type: 'SAVE_RPC_CONFIG',
      host, port: pt || port, user: u || user, password: p || pass,
    });
    setTimeout(() => {
      chrome.runtime.sendMessage(
        { type: 'POPUP_RPC', method: 'getInfo', params: {} },
        (resp) => {
          setTesting(false);
          if (resp?.error) setError(resp.error);
          else if (resp?.result) onConnected();
          else setError('No response from daemon. Is verusd running?');
        }
      );
    }, 100);
  }

  return (
    <div className="screen">
      <h2>Connect to Verus</h2>
      <p className="subtitle">Enter your daemon RPC credentials</p>

      {step === 'paste' ? (
        <>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>1. Run this in a terminal:</p>
            <div style={{ background: 'var(--bg-tertiary)', borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-secondary)' }}>{COPY_CMD}</code>
              <button className="btn-text" onClick={copyCommand} style={{ fontSize: 11, flexShrink: 0, padding: '2px 6px' }}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>2. Paste the output:</p>
            <textarea
              value={pastedConf}
              onChange={(e) => setPastedConf(e.target.value)}
              placeholder={'rpcuser=...\nrpcpassword=...\nrpcport=27486'}
              rows={4}
              style={{ width: '100%', resize: 'none', fontFamily: 'monospace', fontSize: 12 }}
            />
          </div>

          {error && <p className="error">{error}</p>}

          <button className="btn-text" onClick={() => setStep('manual')} style={{ fontSize: 12 }}>
            Enter manually instead →
          </button>
        </>
      ) : (
        <>
          <label className="input-label">Host</label>
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" style={{ width: '100%' }} />

          <label className="input-label">Port</label>
          <input type="text" value={port} onChange={(e) => setPort(e.target.value)} placeholder="27486" style={{ width: '100%' }} />

          <label className="input-label">RPC User</label>
          <input type="text" value={user} onChange={(e) => setUser(e.target.value)} placeholder="from VRSC.conf" style={{ width: '100%', fontFamily: 'monospace' }} />

          <label className="input-label">RPC Password</label>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="from VRSC.conf" style={{ width: '100%', fontFamily: 'monospace' }} />

          {error && <p className="error">{error}</p>}

          <button className="btn-text" onClick={() => setStep('paste')} style={{ fontSize: 12 }}>
            ← Back to paste method
          </button>
        </>
      )}

      <button className="btn btn-primary" onClick={() => step === 'paste' ? handlePaste() : testConnection()}
        disabled={testing || (step === 'paste' ? !pastedConf.trim() : !user || !pass)}
        style={{ width: '100%', marginTop: 'auto' }}>
        {testing ? 'Connecting...' : 'Connect'}
      </button>

      <p style={{ fontSize: 10, color: 'var(--text-subtle)', textAlign: 'center' }}>
        Credentials stay local — only used to talk to your own daemon.
      </p>
    </div>
  );
}
