import React, { useState, useEffect, useMemo, useRef } from 'react';
import currencyMap from '../../data/currency-map.json';
import { nativeFor } from '../../data/chains';

interface Props {
  address: string;
  defaultFromCurrency?: string;
  onComplete?: () => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

// Catalog shape we pass around the screen. Source is the active chain's
// runtime listcurrencies (via the LIST_CURRENCIES handler). The static
// currency-map.json is used as a fallback only — it ships with the
// extension so the screen renders something on first activation before
// the cache populates.
type Catalog = {
  currencies: Record<string, string>;
  baskets: Record<string, { id: string; reserves: string[] }>;
};

const STATIC_CATALOG: Catalog = {
  currencies: currencyMap.currencies as Record<string, string>,
  baskets: currencyMap.baskets as Record<string, { id: string; reserves: string[] }>,
};

function nameToId(name: string, cat: Catalog): string | undefined {
  return Object.entries(cat.currencies).find(([, n]) => n === name)?.[0];
}

function findBaskets(from: string, to: string, cat: Catalog): { name: string; id: string; direct: boolean }[] {
  const { baskets } = cat;
  // Direct: "to" is a basket with "from" as reserve (buying basket tokens)
  if (baskets[to] && baskets[to].reserves.includes(from)) {
    return [{ name: to, id: baskets[to].id, direct: true }];
  }
  // Direct: "from" is a basket with "to" as reserve (selling basket tokens)
  if (baskets[from] && baskets[from].reserves.includes(to)) {
    return [{ name: from, id: baskets[from].id, direct: true }];
  }
  // Reserve-to-reserve: baskets containing both
  return Object.entries(baskets)
    .filter(([, b]) => b.reserves.includes(from) && b.reserves.includes(to))
    .map(([name, b]) => ({ name, id: b.id, direct: false }));
}

function getSwappableCurrencies(from: string, cat: Catalog): string[] {
  const targets = new Set<string>();
  for (const [name, b] of Object.entries(cat.baskets)) {
    // "from" is a reserve of this basket — can swap to other reserves and to the basket itself
    if (b.reserves.includes(from)) {
      for (const r of b.reserves) if (r !== from) targets.add(r);
      if (name !== from) targets.add(name);
    }
    // "from" IS the basket — can swap to any of its reserves
    if (name === from) {
      for (const r of b.reserves) targets.add(r);
    }
  }
  return Array.from(targets).sort();
}

interface EstimateResult {
  converter: string;
  converterId: string;
  output: number;
  netInput: number;
  rate: number;
  direct: boolean;
}

type Step = 'input' | 'confirm' | 'result';

export function SwapScreen({ address, defaultFromCurrency, onComplete }: Props) {
  const [nativeName, setNativeName] = useState<string>('VRSC');
  const [fromCurrency, setFromCurrency] = useState(defaultFromCurrency || 'VRSC');
  const [toCurrency, setToCurrency] = useState('');
  const [amount, setAmount] = useState('');
  const [estimates, setEstimates] = useState<EstimateResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [txid, setTxid] = useState('');
  const [balances, setBalances] = useState<Record<string, number>>({});
  // Runtime catalog. Starts from the shipped static map so first render
  // isn't blank, then gets overwritten by the active chain's
  // listcurrencies result via LIST_CURRENCIES (cache or fresh).
  const [catalog, setCatalog] = useState<Catalog>(STATIC_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const quoteId = useRef(0);

  useEffect(() => {
    chrome.storage.local.get(['activeChain'], ({ activeChain }) => {
      const n = nativeFor(activeChain || null).name;
      setNativeName(n);
      if (!defaultFromCurrency) setFromCurrency(n);
    });
  }, [defaultFromCurrency]);

  // Fetch the runtime currency catalog for the active chain. Re-runs on
  // chain switch (via the nativeName change which is set in the first
  // effect after reading activeChain).
  useEffect(() => {
    setCatalogLoading(true);
    chrome.runtime.sendMessage({ type: 'LIST_CURRENCIES' }, (resp: any) => {
      setCatalogLoading(false);
      if (resp?.ok && resp.currencies && resp.baskets) {
        setCatalog({ currencies: resp.currencies, baskets: resp.baskets });
      }
      // On error or unknown chain, leave the static fallback in place so
      // the screen still renders (degraded but functional).
    });
  }, [nativeName]);

  // Update from currency when prop changes
  useEffect(() => {
    if (defaultFromCurrency) {
      setFromCurrency(defaultFromCurrency);
      setToCurrency('');
      setEstimates([]);
    }
  }, [defaultFromCurrency]);

  // Load balances
  useEffect(() => {
    rpc('getBalance', { address }).then(resp => {
      if (resp?.result?.currencybalance && resp?.result?.currencynames) {
        const bals: Record<string, number> = {};
        const names = resp.result.currencynames;
        for (const [iAddr, amt] of Object.entries(resp.result.currencybalance)) {
          const name = names[iAddr];
          if (name) bals[name] = amt as number;
        }
        setBalances(bals);
      }
    });
  }, [address]);

  const heldCurrencies = useMemo(() => {
    const held = new Set<string>([nativeName]);
    for (const [name, bal] of Object.entries(balances)) {
      if (bal > 0) held.add(name);
    }
    return Array.from(held).sort();
  }, [balances, nativeName]);

  const toCurrencies = useMemo(() => getSwappableCurrencies(fromCurrency, catalog), [fromCurrency, catalog]);

  // Auto-estimate when inputs change
  useEffect(() => {
    const amt = parseFloat(amount);
    if (!fromCurrency || !toCurrency || !amt || amt <= 0) {
      setEstimates([]);
      return;
    }
    const fromId = nameToId(fromCurrency, catalog);
    const toId = nameToId(toCurrency, catalog);
    if (!fromId || !toId) return;

    const paths = findBaskets(fromCurrency, toCurrency, catalog);
    if (paths.length === 0) { setError('No conversion path found'); return; }

    const id = ++quoteId.current;
    setLoading(true);
    setEstimates([]);
    setError('');

    (async () => {
      const results: EstimateResult[] = [];
      for (const path of paths) {
        if (quoteId.current !== id) return;
        const params: any = { from: fromId, to: toId, amount: amt };
        if (!path.direct) params.via = path.id;
        const resp = await rpc('estimateConversion', params);
        if (resp?.result?.estimatedcurrencyout) {
          results.push({
            converter: path.name,
            converterId: path.id,
            output: resp.result.estimatedcurrencyout,
            netInput: resp.result.netinputamount || amt,
            rate: resp.result.estimatedcurrencyout / (resp.result.netinputamount || amt),
            direct: path.direct,
          });
        }
      }
      if (quoteId.current !== id) return;
      if (results.length === 0) setError('Estimation failed');
      else results.sort((a, b) => b.output - a.output);
      setEstimates(results);
      setLoading(false);
    })();

    return () => { quoteId.current++; };
  }, [fromCurrency, toCurrency, amount]);

  const best = estimates[0];
  const fromBalance = balances[fromCurrency] ?? 0;

  async function handleSwap() {
    if (!best) return;
    setError('');
    setSending(true);

    const fromId = nameToId(fromCurrency, catalog);
    const toId = nameToId(toCurrency, catalog);
    const params: any = {
      from: address, to: address, amount: parseFloat(amount),
      currency: fromCurrency, convertto: toCurrency,
    };
    if (!best.direct) params.via = best.converter;

    const resp = await rpc('sendCurrency', params);
    setSending(false);
    if (resp?.error) {
      setError(resp.error);
    } else {
      setTxid(resp.result?.txid || resp.result?.opid || '');
      chrome.runtime.sendMessage({
        type: 'ADD_PENDING_TX', address,
        tx: {
          txid: resp.result?.txid || resp.result?.opid || '',
          type: 'swap-out', value: -parseFloat(amount),
          otherAddr: '', confirmations: 0,
          time: Math.floor(Date.now() / 1000), currencyTransfers: [],
        },
      });
      setStep('result');
    }
  }

  if (step === 'result') {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <svg width={32} height={32} fill="none" stroke="white" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        </div>
        <h2>Swap Submitted!</h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0' }}>
          {parseFloat(amount).toFixed(8)} {fromCurrency} → {toCurrency}
        </p>
        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-subtle)', wordBreak: 'break-all', margin: '4px 0 20px' }}>{txid}</p>
        <button className="btn btn-primary" onClick={() => { if (onComplete) onComplete(); else { setStep('input'); setAmount(''); setEstimates([]); setToCurrency(''); } }} style={{ width: '100%' }}>View Activity</button>
      </div>
    );
  }

  if (step === 'confirm' && best) {
    return (
      <div className="screen">
        <h2>Confirm Swap</h2>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Row label="You send" value={`${parseFloat(amount).toFixed(8)} ${fromCurrency}`} />
          <Row label="You receive (est.)" value={`≈ ${best.output.toFixed(8)} ${toCurrency}`} highlight />
          <Row label="Rate" value={`1 ${fromCurrency} = ${best.rate.toFixed(8)} ${toCurrency}`} />
          <Row label="Via" value={best.converter} />
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <Row label="Balance before" value={`${fromBalance.toFixed(8)} ${fromCurrency}`} />
            <Row label="Balance after (est.)" value={`${(fromBalance - parseFloat(amount)).toFixed(8)} ${fromCurrency}`} />
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="action-buttons" style={{ marginTop: 'auto' }}>
          <button className="btn btn-secondary" onClick={() => { setStep('input'); setError(''); }}>Back</button>
          <button className="btn btn-primary" onClick={handleSwap} disabled={sending}>
            {sending ? 'Swapping...' : 'Confirm Swap'}
          </button>
        </div>
      </div>
    );
  }

  // Input view
  return (
    <div className="screen" style={{ gap: 0 }}>
      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Swap</h2>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-subtle)' }}>
          {address.slice(0, 8)}...{address.slice(-6)}
        </div>
      </div>

      <div style={{ padding: '12px 16px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* From */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>You send</span>
            <span onClick={() => { const fee = fromCurrency === nativeName ? 0.0002 : 0; setAmount(String(Math.max(0, fromBalance - fee).toFixed(8))); }}
              style={{ fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>
              Bal: {fromBalance.toFixed(4)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', overflow: 'hidden' }}>
            <input type="text" value={amount} onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value); }}
              placeholder="0.00" style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 22, fontWeight: 700, border: 'none', background: 'transparent', padding: 0, outline: 'none', color: 'var(--text-primary)' }} />
            <select value={fromCurrency} onChange={(e) => { setFromCurrency(e.target.value); setToCurrency(''); setEstimates([]); }}
              style={{ fontWeight: 600, fontSize: 13, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', flexShrink: 0 }}>
              {heldCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Arrow */}
        <div style={{ textAlign: 'center', padding: '2px 0', fontSize: 16, color: 'var(--text-subtle)' }}>↓</div>

        {/* To */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>You receive</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', overflow: 'hidden' }}>
            <div style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 22, fontWeight: 700, color: best ? 'var(--success)' : 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {loading ? '...' : best ? `≈ ${best.output.toFixed(8)}` : '—'}
            </div>
            <select value={toCurrency} onChange={(e) => { setToCurrency(e.target.value); setEstimates([]); setError(''); }}
              style={{ fontWeight: 600, fontSize: 13, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', flexShrink: 0 }}>
              <option value="">Select...</option>
              {toCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Rate info */}
        {best && !loading && (
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: 'var(--text-subtle)' }}>Via</span>
              <span style={{ fontWeight: 600 }}>{best.converter}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: 'var(--text-subtle)' }}>Rate</span>
              <span style={{ fontFamily: 'monospace' }}>1 {fromCurrency} ≈ {best.rate.toFixed(8)} {toCurrency}</span>
            </div>
            {estimates.length > 1 && (
              <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>
                Best of {estimates.length} paths
              </div>
            )}
          </div>
        )}

        {error && <p className="error" style={{ margin: '4px 0' }}>{error}</p>}

        <button className="btn btn-primary" onClick={() => { if (best) setStep('confirm'); }}
          disabled={!best || loading}
          style={{ width: '100%', marginTop: 'auto', padding: 12, fontSize: 14 }}>
          {loading ? 'Finding rates...' : best ? 'Review Swap' : 'Select currencies'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
      <span style={{ color: 'var(--text-subtle)' }}>{label}</span>
      <span style={{ fontWeight: 600, fontFamily: 'monospace', color: highlight ? 'var(--success)' : undefined }}>{value}</span>
    </div>
  );
}
