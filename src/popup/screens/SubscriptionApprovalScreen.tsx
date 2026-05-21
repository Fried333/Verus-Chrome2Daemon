import React, { useState, useEffect } from 'react';

interface Plan {
  planId: string;
  name: string;
  amount: number;
  currency: string;
  periods: number;
  intervalBlocks: number;
  paymentAddress: string;
}

interface Props {
  subscriptionId?: string;
  subscriberId?: string;
  provider: string;
  providerName: string;
  plan: Plan;
  address: string;
  onApprove: (plan: Plan) => void;
  onReject: () => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

export function SubscriptionApprovalScreen({ subscriptionId, subscriberId, provider, providerName, plan, address, onApprove, onReject }: Props) {
  const [step, setStep] = useState<'approve' | 'executing' | 'done' | 'error'>('approve');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [execStatus, setExecStatus] = useState('');
  const [execProgress, setExecProgress] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [balance, setBalance] = useState(0);
  const [payFrom, setPayFrom] = useState(address);
  const [allAddresses, setAllAddresses] = useState<Array<{ address: string; balance: number; name: string }>>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [rawCopied, setRawCopied] = useState(false);

  const currency = plan.currency || 'VRSC';
  const totalCost = plan.amount * plan.periods;
  const txFees = 0.0001 * (plan.periods + 2); // funding tx + identity update + buffer
  const vrscForBroadcast = currency !== 'VRSC' ? 0.0001 * plan.periods : 0; // VRSC per period for broadcast fees
  const totalVrscNeeded = currency === 'VRSC' ? totalCost + txFees : txFees + vrscForBroadcast;
  const totalWithFees = currency === 'VRSC' ? totalCost + txFees : totalCost;
  const intervalBlocks = plan.intervalBlocks || 1;

  function formatDuration(days: number): string {
    if (days >= 1) return `~${Math.round(days)} day${Math.round(days) !== 1 ? 's' : ''}`;
    const hours = days * 24;
    if (hours >= 1) return `~${Math.round(hours)} hour${Math.round(hours) !== 1 ? 's' : ''}`;
    const mins = hours * 60;
    return `~${Math.round(mins)} min${Math.round(mins) !== 1 ? 's' : ''}`;
  }

  const intervalDays = (intervalBlocks * 60) / 86400;
  const totalDays = intervalDays * plan.periods;

  useEffect(() => {
    (async () => {
      const addrResp = await rpc('getAddress');
      if (!addrResp?.result) return;
      const addrs = addrResp.result as string[];
      const nameKeys = addrs.map((a: string) => 'accountName:' + a);
      const savedNames: Record<string, string> = await new Promise(resolve => {
        chrome.storage.local.get(nameKeys, (data) => resolve(data));
      });
      const planCurrency = plan.currency || 'VRSC';
      const results: Array<{ address: string; balance: number; name: string }> = [];
      for (let i = 0; i < addrs.length; i++) {
        const a = addrs[i];
        const br = await rpc('getBalance', { address: a });
        if (!br?.result?.currencybalance || !br?.result?.currencynames) continue;
        // Find balance for the plan's currency
        let currBal = 0;
        for (const [iAddr, amt] of Object.entries(br.result.currencybalance)) {
          if (br.result.currencynames[iAddr] === planCurrency) {
            currBal = Number(amt);
            break;
          }
        }
        // Also need VRSC for fees
        const vrscBal = Number(br.result.currencybalance['i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV'] || 0);
        const hasEnough = planCurrency === 'VRSC' ? currBal >= (totalCost + txFees) : (currBal >= totalCost && vrscBal >= totalVrscNeeded);
        if (hasEnough) {
          results.push({ address: a, balance: currBal, name: savedNames['accountName:' + a] || `Account ${i + 1}` });
        }
      }
      setAllAddresses(results);
      if (results.length > 0) {
        const current = results.find(r => r.address === address);
        if (current) { setPayFrom(current.address); setBalance(current.balance); }
        else { setPayFrom(results[0].address); setBalance(results[0].balance); }
      } else {
        // No address has enough — show current balance for the plan currency
        const br = await rpc('getBalance', { address });
        let bal = 0;
        if (br?.result?.currencybalance && br?.result?.currencynames) {
          for (const [iAddr, amt] of Object.entries(br.result.currencybalance)) {
            if (br.result.currencynames[iAddr] === planCurrency) { bal = Number(amt); break; }
          }
        }
        setBalance(bal);
      }
    })();
  }, [address]);

  async function handleSubscribe() {
    if (!password) return;
    setPwError('');
    const pwCheck = await new Promise<any>((resolve) => {
      chrome.runtime.sendMessage({ type: 'VERIFY_PASSWORD', password }, resolve);
    });
    if (!pwCheck?.ok) { setPwError('Wrong password'); setPassword(''); return; }

    setStep('executing');
    setExecProgress(5);
    setExecStatus('Generating dedicated address...');

    // Generate, name and pin the dedicated address
    const addrResp = await rpc('newAddress');
    const dedAddr = addrResp?.result || '';
    if (dedAddr) {
      const subName = 'Subscription - ' + (providerName || provider).replace(/@$/, '');
      chrome.storage.local.set({ ['accountName:' + dedAddr]: subName });
      chrome.storage.local.get(['pinnedAddresses'], (data) => {
        const pinned = data.pinnedAddresses || {};
        pinned[dedAddr] = true;
        chrome.storage.local.set({ pinnedAddresses: pinned });
      });
    }

    setExecProgress(10);
    setExecStatus('Funding subscription...');

    if (subscriptionId) {
      // Listen for real progress events from the background service worker
      const progressStages: Record<string, number> = {
        'Funding dedicated address...': 15,
        'Waiting for funding confirmation...': 25,
        'Signing time-locked transactions...': 60,
        'Storing subscription on-chain...': 75,
        'Waiting for prior identity update to confirm...': 80,
      };
      const progressListener = (msg: any) => {
        if (msg?.type === 'SUBSCRIPTION_PROGRESS' && msg.status) {
          setExecStatus(msg.status);
          const mapped = progressStages[msg.status];
          if (mapped) setExecProgress(mapped);
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);

      // Wait for real completion — background keeps channel open
      chrome.runtime.sendMessage(
        { type: 'SUBSCRIPTION_APPROVE', id: subscriptionId, dedicatedAddress: dedAddr, from: payFrom, subscriberId },
        (resp) => {
          chrome.runtime.onMessage.removeListener(progressListener);
          if (resp?.ok) {
            setExecProgress(100);
            setResult({ success: true, dedicatedAddress: dedAddr, ...resp.result });
            setStep('done');
          } else {
            setError(resp?.error || 'Subscription failed');
            setStep('error');
          }
        }
      );
    } else {
      try {
        const resp = await rpc('executeSubscription', { provider, plan, from: payFrom, dedicatedAddress: dedAddr, subscriberId });
        if (resp?.error) throw new Error(resp.error);
        setResult({ ...resp.result, dedicatedAddress: dedAddr });
        setStep('done');
      } catch (err: any) {
        setError(err.message || 'Subscription failed');
        setStep('error');
      }
    }
  }

  // === DONE ===
  if (step === 'done') {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
          <svg width={28} height={28} fill="none" stroke="white" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        </div>
        <h2>Subscription Active!</h2>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, margin: '12px 0', width: '100%', textAlign: 'left', fontSize: 11 }}>
          <Row label="Provider" value={providerName} />
          <Row label="Payments" value={`${plan.periods} x ${plan.amount} ${currency}`} />
          <Row label="Duration" value={formatDuration(totalDays)} />
          {result?.dedicatedAddress && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, color: 'var(--text-subtle)' }}>Dedicated Address</div>
              <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', marginTop: 2 }}>{result.dedicatedAddress}</div>
            </div>
          )}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-subtle)', marginBottom: 12 }}>Cancel anytime — unused funds return to you.</p>
        <button className="btn btn-primary" onClick={() => onApprove(plan)} style={{ width: '100%' }}>Done</button>
      </div>
    );
  }

  // === ERROR ===
  if (step === 'error') {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--error)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
          <svg width={28} height={28} fill="none" stroke="white" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </div>
        <h2>Failed</h2>
        <p style={{ fontSize: 12, color: 'var(--error)', margin: '8px 0' }}>{error}</p>
        <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={onReject} style={{ flex: 1 }}>Close</button>
          <button className="btn btn-primary" onClick={() => { setStep('approve'); setError(''); setPassword(''); }} style={{ flex: 1 }}>Retry</button>
        </div>
      </div>
    );
  }

  // === EXECUTING ===
  if (step === 'executing') {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{ width: 44, height: 44, border: '3px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: 12 }} />
        <h2 style={{ fontSize: 16 }}>Setting Up Subscription</h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0' }}>{execStatus}</p>
        <div style={{ width: '100%', height: 5, background: 'var(--bg-tertiary)', borderRadius: 3, margin: '10px 0', overflow: 'hidden' }}>
          <div style={{ width: `${execProgress}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.5s' }} />
        </div>
        <p style={{ fontSize: 10, color: 'var(--text-subtle)', marginTop: 8 }}>Don't close the wallet</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // === APPROVE (single screen) ===
  return (
    <div className="screen">
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Subscribe to {providerName}</h2>
      {subscriberId && (
        <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginBottom: 8 }}>
          Subscribing as <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{subscriberId}</span>
        </div>
      )}

      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12 }}>
        <Row label="Plan" value={plan.name} />
        <Row label="Per period" value={`${plan.amount} ${currency}`} />
        <Row label="Periods" value={`${plan.periods} payments`} />
        <Row label="Interval" value={`${formatDuration(intervalDays)} (${plan.intervalBlocks} blocks)`} />
        <Row label="Total duration" value={formatDuration(totalDays)} />
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
          <Row label="Subscription cost" value={`${totalCost.toFixed(8)} ${currency}`} />
          {currency === 'VRSC' ? (
            <>
              <Row label="TX fees (est.)" value={`~${txFees.toFixed(4)} VRSC`} />
              <Row label="Total" value={`${(totalCost + txFees).toFixed(8)} VRSC`} highlight />
            </>
          ) : (
            <>
              <Row label="Total" value={`${totalCost.toFixed(8)} ${currency}`} highlight />
              <div style={{ borderTop: '1px dashed var(--border)', marginTop: 4, paddingTop: 4 }}>
                <Row label="VRSC for broadcast fees" value={`${vrscForBroadcast.toFixed(4)} VRSC`} />
                <Row label="VRSC for TX fees" value={`~${txFees.toFixed(4)} VRSC`} />
                <Row label="Total VRSC needed" value={`~${totalVrscNeeded.toFixed(4)} VRSC`} />
              </div>
            </>
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
          <span onClick={() => setShowRaw(!showRaw)}
            style={{ fontSize: 10, color: 'var(--accent)', cursor: 'pointer' }}>
            {showRaw ? 'Hide raw terms ▲' : 'Show raw terms ▼'}
          </span>
          {showRaw && (
            <div style={{ marginTop: 6 }}>
              <div onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(plan, null, 2));
                setRawCopied(true);
                setTimeout(() => setRawCopied(false), 1500);
              }}
                style={{
                  fontFamily: 'monospace', fontSize: 9, wordBreak: 'break-all', whiteSpace: 'pre-wrap',
                  background: 'var(--bg-tertiary)', padding: 8, borderRadius: 6, maxHeight: 120, overflowY: 'auto',
                  cursor: 'pointer', border: '1px solid var(--border)',
                }}>
                {JSON.stringify(plan, null, 2)}
              </div>
              <div style={{ fontSize: 9, color: rawCopied ? 'var(--success)' : 'var(--text-subtle)', marginTop: 2 }}>
                {rawCopied ? 'Copied!' : 'Click to copy'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pay from */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12 }}>
        {allAddresses.length > 1 ? (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-subtle)', marginBottom: 4 }}>Pay from</div>
            <select value={payFrom} onChange={(e) => {
              const sel = allAddresses.find(a => a.address === e.target.value);
              if (sel) { setPayFrom(sel.address); setBalance(sel.balance); }
            }} style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}>
              {allAddresses.map(a => (
                <option key={a.address} value={a.address}>{a.name} ({a.balance.toFixed(4)} {currency})</option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10, color: 'var(--text-subtle)' }}>Pay from</div>
            <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', marginTop: 2 }}>{payFrom}</div>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--text-subtle)' }}>Balance</span>
          <span style={{ fontFamily: 'monospace' }}>{balance.toFixed(8)} {currency}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: 'var(--text-subtle)' }}>After</span>
          <span style={{ fontFamily: 'monospace', color: (balance - totalWithFees) < 0 ? 'var(--error)' : undefined }}>{(balance - totalWithFees).toFixed(8)} {currency}</span>
        </div>
      </div>

      {(balance < totalCost || allAddresses.length === 0) && (
        <div style={{ fontSize: 11, color: 'var(--error)', background: 'var(--bg-secondary)', borderRadius: 6, padding: '6px 10px', border: '1px solid var(--error)' }}>
          {allAddresses.length === 0
            ? `No address has both ${totalCost.toFixed(8)} ${currency}${currency !== 'VRSC' ? ` and ~${totalVrscNeeded.toFixed(4)} VRSC for fees` : ''}.`
            : `Insufficient ${currency}. Need ${totalCost.toFixed(8)} ${currency}${currency !== 'VRSC' ? ` + ~${totalVrscNeeded.toFixed(4)} VRSC` : ''}.`
          }
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-subtle)', background: 'var(--bg-secondary)', borderRadius: 6, padding: '6px 10px' }}>
        A dedicated address will be created. {plan.periods} time-locked payments will be signed. Cancel anytime to reclaim unused funds.
      </div>

      {/* Password */}
      <div>
        <label className="input-label">Password to confirm</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubscribe()}
          placeholder="Wallet password" autoFocus style={{ width: '100%' }} />
        {pwError && <div style={{ fontSize: 11, color: 'var(--error)', marginTop: 2 }}>{pwError}</div>}
      </div>

      <div className="action-buttons" style={{ marginTop: 'auto' }}>
        <button className="btn btn-secondary" onClick={onReject}>Reject</button>
        <button className="btn btn-primary" onClick={handleSubscribe} disabled={!password || balance < totalCost || allAddresses.length === 0}>
          Subscribe
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: 'var(--text-subtle)' }}>{label}</span>
      <span style={{ fontWeight: highlight ? 700 : 500, color: highlight ? 'var(--accent)' : undefined, fontFamily: 'monospace', fontSize: 11 }}>{value}</span>
    </div>
  );
}
