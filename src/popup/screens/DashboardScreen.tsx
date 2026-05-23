import React, { useState, useEffect, useCallback } from 'react';
import { IconSettings, IconSend, IconReceive, IconUser } from '../components/Icons';
import { nativeFor } from '../../data/chains';

interface Props {
  address: string;
  accountName: string;
  defaultSubTab?: 'currencies' | 'activity';
  onSend: (currency?: string) => void;
  onSwap: (currency?: string) => void;
  onReceive: () => void;
  onSettings: () => void;
  onAccountSelector: () => void;
  onAccountNameChange: (name: string) => void;
}

function timeAgo(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

interface TxEntry {
  txid: string;
  type: 'send' | 'receive' | 'swap-out' | 'swap-in' | 'id-update' | 'id-revoke' | 'id-recover';
  value: number;
  otherAddr: string;
  confirmations: number;
  time: number;
  currencyTransfers: Array<{ currency: string; amount: number }>;
}

export function DashboardScreen({ address, accountName, defaultSubTab, onSend, onSwap, onReceive, onSettings, onAccountSelector, onAccountNameChange }: Props) {
  const [balanceData, setBalanceData] = useState<any>(null);
  const [networkInfo, setNetworkInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'currencies' | 'activity'>(defaultSubTab || 'currencies');
  const [txs, setTxs] = useState<TxEntry[]>([]);
  const [expandedTx, setExpandedTx] = useState<string | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [activeChain, setActiveChain] = useState<string | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (s) => {
      if (s?.activeChain) setActiveChain(s.activeChain);
    });
  }, []);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(accountName);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [balResp, infoResp] = await Promise.all([
      rpc('getBalance', { address }),
      rpc('getInfo'),
    ]);
    if (balResp?.result) setBalanceData(balResp.result);
    if (infoResp?.result) setNetworkInfo(infoResp.result);
    setLoading(false);
  }, [address]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Load account name from storage
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_NAME', address }, (resp) => {
      if (resp?.name) {
        setNameInput(resp.name);
        onAccountNameChange(resp.name);
      }
    });
  }, [address]);

  // Load activity when tab switches to activity
  useEffect(() => {
    if (tab === 'activity' && !txLoading) {
      loadActivity();
    }
  }, [tab, address]);

  async function loadActivity() {
    setTxLoading(true);
    try {
      // Get confirmed txids for this address
      const txidResp = await rpc('getAddressTxids', { address });
      const confirmedTxids = (txidResp?.result && Array.isArray(txidResp.result)) ? txidResp.result as string[] : [];

      // Get pending txs stored locally
      const pendingResp = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_PENDING_TXS', address }, resolve);
      });
      const pendingTxs: TxEntry[] = (pendingResp?.txs || []) as TxEntry[];

      // Remove pending txs that are confirmed OR older than 10 minutes
      const confirmedSet = new Set(confirmedTxids);
      const now = Math.floor(Date.now() / 1000);
      const stillPending = pendingTxs.filter(tx => !confirmedSet.has(tx.txid) && (now - tx.time) < 600);
      if (stillPending.length < pendingTxs.length) {
        chrome.runtime.sendMessage({
          type: 'CLEAR_CONFIRMED_PENDING',
          address,
          confirmedTxids,
        });
      }

      // Decode most recent 20 confirmed
      const uniqueTxids = [...new Set(confirmedTxids)].reverse().slice(0, 20);
      const decoded: TxEntry[] = [];
      for (const txid of uniqueTxids) {
        try {
          const txResp = await rpc('getRawTransaction', { txid });
          if (txResp?.result) {
            const entry = parseTx(txResp.result, address);
            // Resolve currency i-addresses to friendly names
            for (const ct of entry.currencyTransfers) {
              if (currNames[ct.currency]) ct.currency = currNames[ct.currency];
            }
            decoded.push(entry);
          }
        } catch {}
      }

      // Prepend pending txs at the top
      setTxs([...stillPending, ...decoded]);
    } catch {}
    setTxLoading(false);
  }

  function parseTx(tx: any, myAddr: string): TxEntry {
    const weAreSpending = (tx.vin || []).some((v: any) => v.address === myAddr);
    const allVinEmpty = (tx.vin || []).every((v: any) => !v.address && !v.coinbase);

    let vrscToUs = 0;
    let vrscToOthers = 0;
    let recipientAddr = '';
    let senderAddr = '';
    const currencyTransfers: Array<{ currency: string; amount: number }> = [];
    let hasConvert = false;
    let idOperation: string | null = null;

    // Get sender from first vin with an address
    for (const vin of (tx.vin || [])) {
      if (vin.address && vin.address !== myAddr) { senderAddr = vin.address; break; }
    }

    for (const vout of (tx.vout || [])) {
      const sp = vout.scriptPubKey || {};
      const addrs = sp.addresses || [];
      const isOurs = addrs.includes(myAddr);
      const vrscVal = vout.value || 0;

      if (isOurs) {
        vrscToUs += vrscVal;
      } else {
        vrscToOthers += vrscVal;
        if (addrs[0] && !recipientAddr) recipientAddr = addrs[0];
      }

      // Currency amounts from reserve_balance
      const rb = sp.reserve_balance;
      if (rb) {
        for (const [name, amount] of Object.entries(rb)) {
          if (isOurs && !weAreSpending) {
            currencyTransfers.push({ currency: name, amount: amount as number });
          } else if (!isOurs && weAreSpending) {
            currencyTransfers.push({ currency: name, amount: -(amount as number) });
          }
        }
      }

      if (sp.reservetransfer) hasConvert = true;

      // Identity operations
      if (sp.identityprimary) idOperation = 'id-update';
      if (sp.identityrevoke) idOperation = 'id-revoke';
      if (sp.identityrecover) idOperation = 'id-recover';
    }

    const value = weAreSpending ? -vrscToOthers : vrscToUs;
    const hasCurrencyToUs = currencyTransfers.some(ct => ct.amount > 0);

    // Type detection
    let type: TxEntry['type'] = 'receive';
    if (idOperation) type = idOperation as TxEntry['type'];
    else if (weAreSpending && hasConvert) type = 'swap-out';
    else if (!weAreSpending && allVinEmpty && (hasCurrencyToUs || vrscToUs > 0)) type = 'swap-in';
    else if (weAreSpending) type = 'send';

    // Show sender on receives, recipient on sends
    const displayAddr = (type === 'send' || type === 'swap-out') ? recipientAddr : senderAddr;

    return {
      txid: tx.txid,
      type,
      value,
      otherAddr: displayAddr,
      confirmations: tx.confirmations || 0,
      time: tx.time || 0,
      currencyTransfers: currencyTransfers.filter(ct => ct.amount !== 0),
    };
  }

  function copyAddress() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function saveName() {
    const name = nameInput.trim();
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT_NAME', address, name });
    onAccountNameChange(name);
    setEditingName(false);
  }

  const native = nativeFor(activeChain);
  const nativeBal = (native.iaddress && balanceData?.currencybalance?.[native.iaddress]) ?? 0;
  const currencies = Object.entries(balanceData?.currencybalance || {}).filter(([, a]) => Number(a) > 0);
  const currNames = balanceData?.currencynames || {};

  const TYPE_LABELS: Record<string, { label: string; color: string }> = {
    'send': { label: 'Sent', color: 'var(--error)' },
    'receive': { label: 'Received', color: 'var(--success)' },
    'swap-out': { label: 'Swap Out', color: '#8250df' },
    'swap-in': { label: 'Swap In', color: '#0969da' },
    'id-update': { label: 'ID Update', color: '#059669' },
    'id-revoke': { label: 'ID Revoked', color: '#dc2626' },
    'id-recover': { label: 'ID Recovered', color: '#0891b2' },
  };

  return (
    <div className="screen dashboard-screen">
      <div className="dashboard-top">
        <button className="btn-icon account-selector-btn" onClick={onAccountSelector} title="Accounts">
          <IconUser size={20} />
        </button>
        <button onClick={onSettings} title="Click to switch chain"
          style={{
            fontFamily: 'monospace', fontSize: 11, fontWeight: 600,
            padding: '4px 10px', borderRadius: 999,
            border: '1px solid var(--border)', background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
          {activeChain || '—'}
        </button>
        <button className="btn-icon settings-btn" onClick={onSettings} title="Settings">
          <IconSettings size={20} />
        </button>
      </div>

      <div className="balance-section">
        {editingName ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
            <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
              autoFocus style={{ width: 140, fontSize: 12, padding: '3px 6px', textAlign: 'center' }} />
            <button onClick={saveName} style={{ fontSize: 11, padding: '2px 8px' }}>Save</button>
            <button onClick={() => setEditingName(false)} style={{ fontSize: 11, padding: '2px 8px' }}>Cancel</button>
          </div>
        ) : (
          <p className="account-name-label" onClick={() => { setNameInput(accountName || 'Account 1'); setEditingName(true); }}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} title="Click to edit">
            {address.startsWith('i') && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: '#059669', color: 'white' }}>ID</span>}
            {accountName || 'Account 1'}
          </p>
        )}
        <p className="balance-label">Balance</p>
        {loading ? (
          <p className="balance-amount">Loading...</p>
        ) : (
          <p className="balance-amount">{Number(nativeBal).toFixed(8)} {native.name}</p>
        )}
        {networkInfo && (
          <p className="balance-pending" style={{ color: 'var(--text-subtle)', fontSize: '11px' }}>
            Block {networkInfo.blocks?.toLocaleString()}
          </p>
        )}
      </div>

      <div className={`address-bar${copied ? ' address-bar-copied' : ''}`} onClick={copyAddress}>
        <span className="address-text">{copied ? 'Copied!' : address}</span>
      </div>

      <div className="action-buttons">
        <button className="btn btn-primary action-btn-with-icon" onClick={() => onSend()}>
          <IconSend size={16} /> Send
        </button>
        <button className="btn btn-secondary action-btn-with-icon" onClick={onReceive}>
          <IconReceive size={16} /> Receive
        </button>
      </div>

      <div className="dashboard-tabs">
        <button className={`dashboard-tab${tab === 'currencies' ? ' dashboard-tab-active' : ''}`} onClick={() => setTab('currencies')}>
          Currencies
        </button>
        <button className={`dashboard-tab${tab === 'activity' ? ' dashboard-tab-active' : ''}`} onClick={() => setTab('activity')}>
          Activity
        </button>
      </div>

      <div className="tab-content" style={{ overflowY: 'auto', flex: 1 }}>
        {tab === 'currencies' ? (
          <div className="currency-list">
            {currencies.map(([cid, amt]) => {
              const name = currNames[cid] || cid;
              const isVrsc = cid === native.iaddress;
              return (
                <div key={cid} className="currency-row currency-row-clickable"
                  onClick={() => setSelectedCurrency(name as string)}>
                  <div className="currency-info">
                    <div className="currency-icon" style={!isVrsc ? { background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)' } : undefined}>
                      {(name as string).slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="currency-name">{name as string}</div>
                    </div>
                  </div>
                  <div className="currency-balance">
                    <span className="currency-amount">{Number(amt).toFixed(8)}</span>
                  </div>
                </div>
              );
            })}
            {currencies.length === 0 && !loading && (
              <p style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-subtle)', fontSize: '13px' }}>
                No balances found
              </p>
            )}
          </div>
        ) : (
          <div className="currency-list">
            {txLoading && (
              <p style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-subtle)', fontSize: '13px' }}>
                Loading transactions...
              </p>
            )}
            {txs.map((tx) => {
              const info = TYPE_LABELS[tx.type] || { label: tx.type, color: 'var(--text-primary)' };
              const timeStr = tx.time ? timeAgo(tx.time) : '';
              const isExpanded = expandedTx === tx.txid;
              return (
                <div key={tx.txid}>
                  <div className="currency-row" style={{ cursor: 'pointer' }}
                    onClick={() => setExpandedTx(isExpanded ? null : tx.txid)}>
                    <div className="currency-info" style={{ gap: 10 }}>
                      <div className="currency-icon" style={{ background: info.color, fontSize: 9, width: 32, height: 32, flexShrink: 0 }}>
                        {tx.type === 'send' ? 'OUT' : tx.type === 'receive' ? 'IN' : tx.type === 'swap-out' ? 'S/O' : tx.type === 'swap-in' ? 'S/I' : 'ID'}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: info.color }}>{info.label}</div>
                        {tx.otherAddr && (
                          <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tx.otherAddr.slice(0, 10)}...{tx.otherAddr.slice(-6)}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: 'var(--text-subtle)' }}>
                          {timeStr} {tx.confirmations > 0 ? '' : '(pending)'}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      {tx.currencyTransfers.length > 0 ? (
                        tx.currencyTransfers.map((ct, i) => (
                          <div key={i} style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 500, color: ct.amount >= 0 ? 'var(--success)' : 'var(--error)' }}>
                            {ct.amount >= 0 ? '+' : ''}{ct.amount.toFixed(8)} {ct.currency}
                          </div>
                        ))
                      ) : null}
                      {tx.value !== 0 && (
                        <div style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 500, color: tx.value >= 0 ? 'var(--success)' : 'var(--error)' }}>
                          {tx.value >= 0 ? '+' : ''}{tx.value.toFixed(8)} {native.name}
                        </div>
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '0 0 8px 8px', marginTop: -2, padding: '8px 12px', fontSize: 11 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: 'var(--text-subtle)' }}>Confirmations</span>
                        <span>{tx.confirmations > 0 ? tx.confirmations : 'Pending'}</span>
                      </div>
                      {tx.otherAddr && (
                        <div style={{ marginBottom: 4 }}>
                          <span style={{ color: 'var(--text-subtle)' }}>{tx.type === 'send' || tx.type === 'swap-out' ? 'To' : 'From'}</span>
                          <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', marginTop: 2 }}>{tx.otherAddr}</div>
                        </div>
                      )}
                      <div>
                        <span style={{ color: 'var(--text-subtle)' }}>Transaction ID</span>
                        <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', marginTop: 2, cursor: 'pointer', color: 'var(--accent)' }}
                          onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(tx.txid); }}>
                          {tx.txid} (click to copy)
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!txLoading && txs.length === 0 && (
              <p style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-subtle)', fontSize: '13px' }}>
                No transactions found
              </p>
            )}
          </div>
        )}
      </div>

      {/* Currency action popup */}
      {selectedCurrency && (
        <div onClick={() => setSelectedCurrency(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 100,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'var(--bg-primary)', borderRadius: '16px 16px 0 0', padding: '20px 16px',
            width: '100%', maxWidth: 420,
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{selectedCurrency}</div>
            <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 16 }}>
              {(() => { const amt = currencies.find(([cid]) => (currNames[cid] || cid) === selectedCurrency); return amt ? Number(amt[1]).toFixed(8) : ''; })()}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }}
                onClick={() => { setSelectedCurrency(null); onSend(selectedCurrency); }}>
                Send
              </button>
              <button className="btn btn-secondary" style={{ flex: 1 }}
                onClick={() => { setSelectedCurrency(null); onSwap(selectedCurrency); }}>
                Swap
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
