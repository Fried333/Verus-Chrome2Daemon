import React, { useState, useEffect } from 'react';

interface Props {
  onConnected: () => void;
  onBack?: () => void;
}

interface ChainCreds {
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
}

type OsKey = 'linux' | 'mac' | 'win';

// Default port hints per known chain.
const CHAIN_PRESETS: Record<string, { port: string }> = {
  VRSC:  { port: '27486' },
  vDEX:  { port: '21778' },
  vARRR: { port: '20778' },
  CHIPS: { port: '22778' },
};

// PBaaS subdir name = hash160 of reversed system_id, deterministic per chain.
const PBAAS_HASH: Record<string, string> = {
  vDEX:  '53fe39eea8c06bba32f1a4e20db67e5524f0309d',
  vARRR: 'e9e10955b7d16031e3d6f55d9c908a038e3ae47d',
  CHIPS: 'f315367528394674d45277e369629605a1c3ce9f',
};

const CONF_PATHS: Record<string, Record<OsKey, string>> = {
  VRSC: {
    linux: '~/.komodo/VRSC/VRSC.conf',
    mac:   '~/Library/Application Support/Komodo/VRSC/VRSC.conf',
    win:   '%APPDATA%\\Komodo\\VRSC\\VRSC.conf',
  },
  vDEX: {
    linux: `~/.verus/pbaas/${PBAAS_HASH.vDEX}/${PBAAS_HASH.vDEX}.conf`,
    mac:   `~/Library/Application Support/Verus/pbaas/${PBAAS_HASH.vDEX}/${PBAAS_HASH.vDEX}.conf`,
    win:   `%APPDATA%\\Verus\\pbaas\\${PBAAS_HASH.vDEX}\\${PBAAS_HASH.vDEX}.conf`,
  },
  vARRR: {
    linux: `~/.verus/pbaas/${PBAAS_HASH.vARRR}/${PBAAS_HASH.vARRR}.conf`,
    mac:   `~/Library/Application Support/Verus/pbaas/${PBAAS_HASH.vARRR}/${PBAAS_HASH.vARRR}.conf`,
    win:   `%APPDATA%\\Verus\\pbaas\\${PBAAS_HASH.vARRR}\\${PBAAS_HASH.vARRR}.conf`,
  },
  CHIPS: {
    linux: `~/.verus/pbaas/${PBAAS_HASH.CHIPS}/${PBAAS_HASH.CHIPS}.conf`,
    mac:   `~/Library/Application Support/Verus/pbaas/${PBAAS_HASH.CHIPS}/${PBAAS_HASH.CHIPS}.conf`,
    win:   `%APPDATA%\\Verus\\pbaas\\${PBAAS_HASH.CHIPS}\\${PBAAS_HASH.CHIPS}.conf`,
  },
};

function osFromPlatform(os: string | undefined): OsKey {
  if (os === 'win') return 'win';
  if (os === 'mac') return 'mac';
  return 'linux';
}

function parseConf(text: string, defaultPort: string) {
  let u = '', p = '', pt = defaultPort;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('rpcuser=')) u = t.split('=').slice(1).join('=').trim();
    if (t.startsWith('rpcpassword=')) p = t.split('=').slice(1).join('=').trim();
    if (t.startsWith('rpcport=')) pt = t.split('=').slice(1).join('=').trim();
  }
  return { user: u, pass: p, port: pt };
}

export function SetupScreen({ onConnected, onBack }: Props) {
  const [chainKey, setChainKey] = useState<string>('VRSC');
  const [os, setOs] = useState<OsKey>('linux');
  const [alive, setAlive] = useState<Record<string, boolean | undefined>>({});
  const [chains, setChains] = useState<Record<string, ChainCreds>>({});
  const [pastedConf, setPastedConf] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(CHAIN_PRESETS.VRSC.port);

  useEffect(() => {
    try {
      chrome.runtime.getPlatformInfo((info) => setOs(osFromPlatform(info?.os)));
    } catch { /* no-op */ }
    chrome.runtime.sendMessage({ type: 'GET_CHAINS' }, (resp) => {
      const map = resp?.chains || {};
      setChains(map);
      // Default to the first chain that ISN'T already configured — this screen
      // is for adding new chains, so we should land on something to add.
      const firstUnconfigured = Object.keys(CHAIN_PRESETS).find((k) => !map[k]);
      if (firstUnconfigured) {
        setChainKey(firstUnconfigured);
        setPort(CHAIN_PRESETS[firstUnconfigured].port);
      }
    });
  }, []);

  const hasAnyConfigured = Object.keys(chains).length > 0;
  const availableKeys = Object.keys(CHAIN_PRESETS).filter((k) => !chains[k]);
  const allConfigured = availableKeys.length === 0;

  // Probe each chain's default port: live daemon answers with 401, dead one
  // fails the fetch. Gives the chain pills a visible alive/dead indicator.
  useEffect(() => {
    Object.entries(CHAIN_PRESETS).forEach(([k, preset]) => {
      chrome.runtime.sendMessage(
        { type: 'PROBE_CHAIN', host, port: preset.port },
        (resp) => setAlive((prev) => ({ ...prev, [k]: !!resp?.alive })),
      );
    });
  }, [host]);

  const confPath = CONF_PATHS[chainKey]?.[os] || CONF_PATHS.VRSC[os];
  const grepCmd = os === 'win'
    ? `type "${confPath}" | findstr /R "rpcuser rpcpassword rpcport"`
    : `cat ${confPath} | grep -E "rpcuser|rpcpassword|rpcport"`;

  function pickChain(next: string) {
    setChainKey(next);
    const preset = CHAIN_PRESETS[next];
    if (preset) setPort(preset.port);
    setPastedConf('');
    setUser('');
    setPass('');
    setError('');
  }

  function copyCmd() {
    navigator.clipboard.writeText(grepCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handlePaste() {
    const parsed = parseConf(pastedConf, CHAIN_PRESETS[chainKey]?.port || '27486');
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
      key: chainKey, name: chainKey,
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
      {onBack && hasAnyConfigured && (
        <button className="btn-back" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← Back</button>
      )}
      <h2>{hasAnyConfigured ? 'Add a chain' : 'Connect to Verus'}</h2>
      {allConfigured ? (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, fontSize: 12 }}>
          All known chains are configured. Switch between them in Settings.
        </div>
      ) : (
        <p className="subtitle">Pick a chain to add — green dot means a daemon is running on its default port.</p>
      )}

      {!allConfigured && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {availableKeys.map((k) => {
            const isActive = chainKey === k;
            const isAlive = alive[k];
            const dot = isAlive === true ? '#16a34a' : isAlive === false ? 'var(--text-subtle)' : 'transparent';
            return (
              <button key={k}
                onClick={() => pickChain(k)}
                title={isAlive === true ? 'Daemon detected' : isAlive === false ? 'No daemon on default port' : 'Probing…'}
                style={{
                  fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
                  background: isActive ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: isActive ? 'white' : 'var(--text-secondary)',
                  cursor: 'pointer', fontFamily: 'monospace',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, display: 'inline-block' }} />
                {k}
              </button>
            );
          })}
        </div>
      )}

      {!allConfigured && (<>
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          1. Run this in a {os === 'win' ? 'Command Prompt' : 'terminal'}:
        </div>
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-secondary)' }}>{grepCmd}</code>
          <button className="btn-text" onClick={copyCmd} style={{ fontSize: 11, flexShrink: 0, padding: '2px 6px' }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>2. Paste the output:</div>
        <textarea
          value={pastedConf}
          onChange={(e) => setPastedConf(e.target.value)}
          placeholder={'rpcuser=...\nrpcpassword=...\nrpcport=...'}
          rows={4}
          style={{ width: '100%', resize: 'none', fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>

      <button className="btn btn-primary" onClick={handlePaste}
        disabled={testing || !pastedConf.trim()}
        style={{ width: '100%' }}>
        {testing ? 'Connecting…' : 'Connect'}
      </button>

      <button className="btn-text" onClick={() => setShowAdvanced((v) => !v)} style={{ fontSize: 12 }}>
        {showAdvanced ? '← Hide' : 'Enter credentials manually →'}
      </button>
      </>)}

      {showAdvanced && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="input-label">RPC User</label>
          <input type="text" value={user} onChange={(e) => setUser(e.target.value)} placeholder={`from ${chainKey}.conf`} style={{ width: '100%', fontFamily: 'monospace' }} />

          <label className="input-label">RPC Password</label>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={`from ${chainKey}.conf`} style={{ width: '100%', fontFamily: 'monospace' }} />

          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 11, color: 'var(--text-subtle)', cursor: 'pointer' }}>Custom host / port</summary>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="input-label">Host</label>
              <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" style={{ width: '100%' }} />

              <label className="input-label">Port</label>
              <input type="text" value={port} onChange={(e) => setPort(e.target.value)} placeholder={CHAIN_PRESETS[chainKey]?.port || '27486'} style={{ width: '100%' }} />
            </div>
          </details>

          <button className="btn btn-primary" onClick={() => testConnection()}
            disabled={testing || !user || !pass}
            style={{ width: '100%', marginTop: 6 }}>
            {testing ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
