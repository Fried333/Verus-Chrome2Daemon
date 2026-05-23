import React, { useState, useEffect } from 'react';
import { IconBack, IconCheck, IconPlus } from '../components/Icons';
import { nativeFor } from '../../data/chains';

interface Props {
  currentAddress: string;
  onBack: () => void;
  onSelect: (address: string, name: string) => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

interface Account {
  address: string;
  vrsc: number;
  name: string;
  type: 'address' | 'identity';
  currencyCount: number;
}

export function AccountSelectorScreen({ currentAddress, onBack, onSelect }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [pinnedAddresses, setPinnedAddresses] = useState<Set<string>>(new Set());

  useEffect(() => { loadAccounts(); }, []);

  async function loadAccounts() {
    setLoading(true);
    const resp = await rpc('getAddress');
    if (!resp?.result || !Array.isArray(resp.result)) { setLoading(false); return; }

    const addrs: string[] = resp.result;

    // Resolve the active chain key once; pinned + accountName storage is
    // chain-prefixed because the same R-address only lives in one daemon's
    // wallet anyway, and i-addresses can carry different state per chain.
    const { activeChain } = await chrome.storage.local.get(['activeChain']);
    const chainKey: string = activeChain || 'VRSC';

    // Load pinned addresses for this chain
    const pinData: Record<string, boolean> = await new Promise(resolve => {
      chrome.storage.local.get([`pinnedAddresses:${chainKey}`], (data) => resolve(data[`pinnedAddresses:${chainKey}`] || {}));
    });
    const pinned = new Set(Object.keys(pinData).filter(k => pinData[k]));
    setPinnedAddresses(pinned);

    // Load saved names (chain-prefixed)
    const nameKeys = addrs.map(a => `accountName:${chainKey}:${a}`);
    const savedNames: Record<string, string> = await new Promise(resolve => {
      chrome.storage.local.get(nameKeys, (data) => resolve(data));
    });

    // Get identities — listidentities is chain-local, so this is already
    // filtered to IDs that exist on the active daemon. We additionally
    // require a clean getidentity resolve, so a partially-replicated entry
    // doesn't get surfaced as a usable account.
    const idResp = await rpc('listIdentities');
    const identities: Array<{ name: string; friendlyName: string; iAddress: string; primaryAddress: string }> = [];
    if (idResp?.result && Array.isArray(idResp.result)) {
      for (const idObj of idResp.result) {
        const ident = idObj.identity || {};
        if (ident.name?.startsWith('3965555_')) continue;
        const iAddr = ident.identityaddress || '';
        const fullResp = await rpc('getIdentity', { nameOrId: iAddr });
        if (!fullResp?.result?.identity) continue;
        identities.push({
          name: ident.name,
          friendlyName: fullResp?.result?.friendlyname || (ident.name + '@'),
          iAddress: iAddr,
          primaryAddress: (ident.primaryaddresses || [])[0] || '',
        });
      }
    }

    const accts: Account[] = [];

    const native = nativeFor(chainKey);

    // Fetch R-address balances. The "headline" balance is the active chain's
    // native currency; on a non-native chain this column is the chain's own
    // coin (e.g. vARRR on vARRR), not VRSC.
    for (let i = 0; i < addrs.length; i++) {
      const addr = addrs[i];
      const br = await rpc('getBalance', { address: addr });
      const nativeBal = (native.iaddress && br?.result?.currencybalance?.[native.iaddress]) || 0;
      const currCount = br?.result?.currencybalance ? Object.values(br.result.currencybalance).filter((v: any) => Number(v) > 0).length : 0;
      const hasBalance = currCount > 0;
      const hasId = identities.some(id => id.primaryAddress === addr);

      // Show if: has balance, has identity, is current, or is pinned
      if (hasBalance || hasId || addr === currentAddress || pinned.has(addr)) {
        accts.push({
          address: addr,
          vrsc: Number(nativeBal),
          name: savedNames[`accountName:${chainKey}:${addr}`] || `Account ${i + 1}`,
          type: 'address',
          currencyCount: currCount,
        });
      }
    }

    // Fetch identity balances — only show IDs with holdings
    for (const id of identities) {
      const br = await rpc('getBalance', { address: id.iAddress });
      const nativeBal = (native.iaddress && br?.result?.currencybalance?.[native.iaddress]) || 0;
      const currCount = br?.result?.currencybalance ? Object.values(br.result.currencybalance).filter((v: any) => Number(v) > 0).length : 0;

      if (currCount === 0 && id.iAddress !== currentAddress) continue;

      accts.push({
        address: id.iAddress,
        vrsc: Number(nativeBal),
        name: id.friendlyName,
        type: 'identity',
        currencyCount: currCount,
      });
    }

    // Deduplicate
    const seen = new Set<string>();
    setAccounts(accts.filter(a => { if (seen.has(a.address)) return false; seen.add(a.address); return true; }));
    setLoading(false);
  }

  async function addAddress() {
    setAdding(true);
    const resp = await rpc('newAddress');
    if (resp?.error) {
      alert(resp.error);
      setAdding(false);
    } else if (resp?.result) {
      // Pin the new address so it stays visible
      togglePin(resp.result, true);
      onSelect(resp.result, 'New Address');
    } else {
      setAdding(false);
    }
  }

  function togglePin(addr: string, force?: boolean) {
    const newPinned = new Set(pinnedAddresses);
    const shouldPin = force !== undefined ? force : !newPinned.has(addr);
    if (shouldPin) newPinned.add(addr);
    else newPinned.delete(addr);
    setPinnedAddresses(newPinned);
    const pinObj: Record<string, boolean> = {};
    newPinned.forEach(a => pinObj[a] = true);
    chrome.storage.local.get(['activeChain'], ({ activeChain }) => {
      const chainKey: string = activeChain || 'VRSC';
      chrome.storage.local.set({ [`pinnedAddresses:${chainKey}`]: pinObj });
    });
  }

  const rAddresses = accounts.filter(a => a.type === 'address');
  const idAccounts = accounts.filter(a => a.type === 'identity');

  return (
    <div className="screen account-selector-screen">
      <button className="btn-back" onClick={onBack}><IconBack size={16} /> Back</button>
      <h2>Accounts</h2>

      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1, overflowY: 'auto' }}>
          {/* R-Addresses */}
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 0 4px' }}>Addresses</div>
          {rAddresses.map(acc => (
            <AccountRow key={acc.address} account={acc} isActive={acc.address === currentAddress}
              isPinned={pinnedAddresses.has(acc.address)}
              onPin={() => togglePin(acc.address)}
              onClick={() => onSelect(acc.address, acc.name)} />
          ))}

          {/* VerusIDs */}
          {idAccounts.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#059669', textTransform: 'uppercase', letterSpacing: 0.5, padding: '12px 0 4px' }}>VerusIDs</div>
              {idAccounts.map(acc => (
                <AccountRow key={acc.address} account={acc} isActive={acc.address === currentAddress}
                  onClick={() => onSelect(acc.address, acc.name)} />
              ))}
            </>
          )}
        </div>
      )}

      <button className="btn btn-secondary" onClick={addAddress} disabled={adding}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 }}>
        <IconPlus size={14} /> {adding ? 'Adding...' : 'Add Address'}
      </button>
    </div>
  );
}

function AccountRow({ account, isActive, isPinned, onPin, onClick }: { account: Account; isActive: boolean; isPinned?: boolean; onPin?: () => void; onClick: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: 12, background: isActive ? 'var(--accent)' : 'var(--bg-secondary)',
      border: '1px solid var(--border)', borderRadius: 8,
      color: isActive ? 'white' : 'var(--text-primary)', marginBottom: 4,
    }}>
      <div onClick={onClick} style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {account.type === 'identity' && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: isActive ? 'rgba(255,255,255,0.2)' : '#059669', color: 'white' }}>ID</span>
          )}
          <span style={{ fontSize: 14, fontWeight: 600 }}>{account.name}</span>
        </div>
        <div style={{ fontSize: 10, fontFamily: 'monospace', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
          {account.address}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div onClick={onClick} style={{ cursor: 'pointer' }}>
          {account.vrsc > 0 && <div style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>{account.vrsc.toFixed(4)}</div>}
          {account.vrsc > 0 && account.currencyCount > 1 && <div style={{ fontSize: 10, opacity: 0.7 }}>+{account.currencyCount - 1} currencies</div>}
          {account.vrsc === 0 && account.currencyCount > 0 && <div style={{ fontSize: 10, opacity: 0.7 }}>{account.currencyCount} {account.currencyCount === 1 ? 'currency' : 'currencies'}</div>}
          {isActive && <IconCheck size={14} />}
        </div>
        {onPin && account.type === 'address' && (
          <span onClick={(e) => { e.stopPropagation(); onPin(); }}
            title={isPinned ? 'Unpin address' : 'Pin address (keep visible)'}
            style={{
              cursor: 'pointer', fontSize: 11, padding: '2px 6px', borderRadius: 4,
              background: isPinned ? 'var(--accent)' : 'transparent',
              color: isPinned ? 'white' : 'var(--text-subtle)',
              border: isPinned ? 'none' : '1px solid var(--border)',
            }}>
            {isPinned ? 'Pinned' : 'Pin'}
          </span>
        )}
      </div>
    </div>
  );
}
