import React, { useState, useEffect } from 'react';
import { IconBack } from '../components/Icons';
import { nativeFor } from '../../data/chains';

interface Props {
  address: string;
  defaultCurrency?: string;
  onBack: () => void;
  onSent: () => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

type Step = 'input' | 'confirm' | 'result';

export function SendScreen({ address, defaultCurrency, onBack, onSent }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [nativeName, setNativeName] = useState<string>('VRSC');
  const [currency, setCurrency] = useState(defaultCurrency || 'VRSC');
  const [memo, setMemo] = useState('');
  const isZAddress = recipient.trim().startsWith('zs') || recipient.trim().startsWith('zc');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [txid, setTxid] = useState('');
  const [resolvedAddr, setResolvedAddr] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [myAddresses, setMyAddresses] = useState<Array<{ address: string; name: string }>>([]);
  const [showAddresses, setShowAddresses] = useState(false);
  const [requirePassword, setRequirePassword] = useState(true);

  useEffect(() => {
    chrome.storage.local.get(['requirePasswordOnSend', 'activeChain'], (data) => {
      if (data.requirePasswordOnSend === false) setRequirePassword(false);
      const n = nativeFor(data.activeChain || null).name;
      setNativeName(n);
      // If the caller didn't override the default, use the active chain's
      // native instead of a hardcoded VRSC.
      if (!defaultCurrency) setCurrency(n);
    });
  }, [defaultCurrency]);

  // Load own addresses + IDs (same filter as account selector)
  useEffect(() => {
    (async () => {
      const resp = await rpc('getAddress');
      if (!resp?.result || !Array.isArray(resp.result)) return;
      const addrs = resp.result as string[];

      const { activeChain } = await chrome.storage.local.get(['activeChain']);
      const chainKey: string = activeChain || 'VRSC';
      const nameKeys = addrs.map((a: string) => `accountName:${chainKey}:${a}`);
      const stored: Record<string, any> = await new Promise(resolve => {
        chrome.storage.local.get([...nameKeys, `pinnedAddresses:${chainKey}`], (data) => resolve(data));
      });
      const pinnedMap = stored[`pinnedAddresses:${chainKey}`] || {};
      const pinned = new Set(Object.keys(pinnedMap).filter(k => pinnedMap[k]));

      const results: Array<{ address: string; name: string }> = [];

      // R-addresses with balance or pinned
      for (let i = 0; i < addrs.length; i++) {
        const a = addrs[i];
        if (a === address) continue;
        const br = await rpc('getBalance', { address: a });
        const hasBalance = br?.result?.currencybalance && Object.values(br.result.currencybalance).some((v: any) => Number(v) > 0);
        if (hasBalance || pinned.has(a) || i === 0) {
          results.push({ address: a, name: stored[`accountName:${chainKey}:${a}`] || `Account ${i + 1}` });
        }
      }

      // IDs with balance
      const idResp = await rpc('listIdentities');
      if (idResp?.result && Array.isArray(idResp.result)) {
        for (const idObj of idResp.result) {
          const ident = idObj.identity || {};
          if (ident.name?.startsWith('3965555_')) continue;
          const iAddr = ident.identityaddress || '';
          if (iAddr === address) continue;
          const br = await rpc('getBalance', { address: iAddr });
          const hasBalance = br?.result?.currencybalance && Object.values(br.result.currencybalance).some((v: any) => Number(v) > 0);
          if (hasBalance) {
            const fullResp = await rpc('getIdentity', { nameOrId: iAddr });
            results.push({ address: iAddr, name: fullResp?.result?.friendlyname || (ident.name + '@') });
          }
        }
      }

      setMyAddresses(results);
    })();
  }, [address]);

  useEffect(() => {
    rpc('getBalance', { address }).then(resp => {
      if (resp?.result?.currencybalance && resp?.result?.currencynames) {
        const balances = resp.result.currencybalance;
        const names = resp.result.currencynames;
        // Build name -> balance map from i-address keys
        for (const [iAddr, amt] of Object.entries(balances)) {
          const name = names[iAddr];
          if (name && name.toLowerCase() === currency.toLowerCase()) {
            setBalance(String(amt));
            return;
          }
        }
        setBalance(null);
      }
    });
  }, [address, currency]);

  async function resolveRecipient(): Promise<string> {
    const input = recipient.trim();
    if (input.startsWith('R') || input.startsWith('i')) return input;
    const name = input.endsWith('@') ? input : input + '@';
    const resp = await rpc('getIdentity', { nameOrId: name });
    if (resp?.result?.identity?.primaryaddresses?.[0]) {
      const addr = resp.result.identity.primaryaddresses[0];
      setResolvedAddr(addr);
      return addr;
    }
    throw new Error(`Could not resolve VerusID: ${input}`);
  }

  async function handleReview() {
    setError('');
    if (!recipient.trim()) { setError('Enter a recipient'); return; }
    if (!amount.trim() || parseFloat(amount) <= 0) { setError('Enter a valid amount'); return; }
    setLoading(true);
    try { await resolveRecipient(); setStep('confirm'); }
    catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  async function handleSend() {
    if (requirePassword && !confirmPassword) { setError('Enter your password to confirm'); return; }
    setError('');
    setLoading(true);
    if (requirePassword) {
      const pwCheck = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({ type: 'VERIFY_PASSWORD', password: confirmPassword }, resolve);
      });
      if (!pwCheck?.ok) {
        setLoading(false);
        setError('Wrong password');
        setConfirmPassword('');
        return;
      }
    }
    try {
      const params: any = { from: address, to: resolvedAddr || recipient.trim(), amount: parseFloat(amount) };
      if (currency !== nativeName) params.currency = currency;
      if (memo && isZAddress) params.memo = memo;
      const resp = await rpc('sendCurrency', params);
      if (resp?.error) throw new Error(resp.error);
      const resultTxid = resp.result?.txid || '';
      setTxid(resultTxid || resp.result?.opid || JSON.stringify(resp.result));
      // Store as pending tx so activity shows it immediately
      if (resultTxid) {
        chrome.runtime.sendMessage({
          type: 'ADD_PENDING_TX',
          address,
          tx: {
            txid: resultTxid,
            type: 'send',
            value: -parseFloat(amount),
            otherAddr: resolvedAddr || recipient.trim(),
            confirmations: 0,
            time: Math.floor(Date.now() / 1000),
            currencyTransfers: [],
            currency: currency !== nativeName ? currency : undefined,
          },
        });
      }
      setStep('result');
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  if (step === 'result') {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <svg width={32} height={32} fill="none" stroke="white" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        </div>
        <h2>Sent!</h2>
        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', wordBreak: 'break-all', margin: '8px 0 20px' }}>{txid}</p>
        <button className="btn btn-primary" onClick={onSent} style={{ width: '100%' }}>Done</button>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="screen">
        <button className="btn-back" onClick={() => setStep('input')}><IconBack size={16} /> Back</button>
        <h2>Confirm Transaction</h2>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="From" value={address} mono />
          <Field label="To" value={resolvedAddr || recipient} mono />
          {resolvedAddr && <Field label="VerusID" value={recipient} />}
          <Field label="Amount" value={`${amount} ${currency}`} />
          {balance !== null && (
            <>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
                <Field label="Balance before" value={`${parseFloat(balance).toFixed(8)} ${currency}`} />
              </div>
              <Field label="Balance after (est.)" value={`${(parseFloat(balance) - parseFloat(amount)).toFixed(8)} ${currency}`} />
            </>
          )}
        </div>

        <p style={{ fontSize: 12, color: 'var(--error)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '8px 12px' }}>
          Please verify all details. Transactions cannot be reversed.
        </p>

        {requirePassword && (
          <div>
            <label className="input-label">Enter password to confirm</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Wallet password" autoFocus style={{ width: '100%' }} />
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div className="action-buttons" style={{ marginTop: 'auto' }}>
          <button className="btn btn-secondary" onClick={() => setStep('input')}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSend} disabled={loading}>
            {loading ? 'Sending...' : 'Confirm'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <button className="btn-back" onClick={onBack}><IconBack size={16} /> Back</button>
      <h2>Send</h2>

      <label className="input-label">Recipient</label>
      <div style={{ position: 'relative' }}>
        <input type="text" value={recipient} onChange={(e) => { setRecipient(e.target.value); setResolvedAddr(''); setShowAddresses(false); }}
          onFocus={() => { if (!recipient) setShowAddresses(true); }}
          placeholder="R-address, i-address, or name@" style={{ width: '100%' }} />
        {showAddresses && myAddresses.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
            background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: '0 0 8px 8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 160, overflowY: 'auto',
          }}>
            <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--text-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              My addresses
            </div>
            {myAddresses.map(a => (
              <div key={a.address}
                onClick={() => { setRecipient(a.address); setShowAddresses(false); }}
                style={{
                  padding: '8px 10px', cursor: 'pointer', borderTop: '1px solid var(--border)',
                  fontSize: 12,
                }}>
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-subtle)', marginTop: 1 }}>
                  {a.address.slice(0, 12)}...{a.address.slice(-8)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label className="input-label">Amount</label>
        {balance !== null && (
          <span
            onClick={() => { const fee = currency === nativeName ? 0.0001 : 0; setAmount(String(Math.max(0, parseFloat(balance) - fee).toFixed(8))); }}
            style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}
            title="Click to use max amount"
          >
            Balance: {parseFloat(balance).toFixed(8)} {currency}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00000000" style={{ flex: 1, fontFamily: 'monospace' }} />
        <input type="text" value={currency} onChange={(e) => setCurrency(e.target.value)}
          placeholder={nativeName} style={{ width: 80 }} />
      </div>

      {isZAddress && (
        <>
          <label className="input-label">Memo (Z-address only)</label>
          <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)}
            placeholder="Optional encrypted memo" style={{ width: '100%' }} />
        </>
      )}

      {error && <p className="error">{error}</p>}

      <button className="btn btn-primary" onClick={handleReview} disabled={loading || !recipient || !amount}
        style={{ width: '100%', marginTop: 'auto' }}>
        {loading ? 'Resolving...' : 'Review'}
      </button>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, wordBreak: 'break-all', ...(mono ? { fontFamily: 'monospace', fontSize: 11 } : {}) }}>{value}</div>
    </div>
  );
}
