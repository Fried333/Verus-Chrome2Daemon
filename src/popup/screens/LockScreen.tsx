import React, { useState } from 'react';

interface Props {
  isNewUser: boolean;
  onUnlock: () => void;
}

export function LockScreen({ isNewUser, onUnlock }: Props) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (isNewUser) {
      if (password.length < 8) { setError('Password must be at least 8 characters'); setLoading(false); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); setLoading(false); return; }
      chrome.runtime.sendMessage({ type: 'SET_PASSWORD', password }, (resp) => {
        setLoading(false);
        resp?.ok ? onUnlock() : setError(resp?.error || 'Failed');
      });
    } else {
      chrome.runtime.sendMessage({ type: 'UNLOCK', password }, (resp) => {
        setLoading(false);
        if (resp?.ok) onUnlock();
        else { setError('Wrong password'); setPassword(''); }
      });
    }
  }

  return (
    <div className="screen" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
      <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <span style={{ color: 'white', fontSize: 28, fontWeight: 700 }}>V</span>
      </div>

      <h2>{isNewUser ? 'Create Password' : 'Verus Wallet'}</h2>
      <p className="subtitle" style={{ marginBottom: 20 }}>
        {isNewUser ? 'Set a password to protect your wallet session.' : 'Enter your password to unlock'}
      </p>

      <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isNewUser ? 'Create password (8+ chars)' : 'Enter password'}
          autoFocus
          style={{ width: '100%' }}
        />

        {isNewUser && (
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            style={{ width: '100%' }}
          />
        )}

        {error && <p className="error">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={loading || !password} style={{ width: '100%' }}>
          {loading ? 'Please wait...' : isNewUser ? 'Create Password' : 'Unlock'}
        </button>
      </form>

      <p style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 20 }}>
        Your keys are stored in the Verus daemon, not in this extension.
      </p>
    </div>
  );
}
