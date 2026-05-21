import React, { useState, useEffect } from 'react';

interface Props {
  address: string;
  onSelectId: (id: any, walletAddrs: Set<string>) => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

export function IDsScreen({ address, onSelectId }: Props) {
  const [identities, setIdentities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [walletAddresses, setWalletAddresses] = useState<Set<string>>(new Set());

  useEffect(() => { loadIdentities(); }, [address]);

  async function loadIdentities() {
    setLoading(true);

    const addrResp = await rpc('getAddress');
    const walletAddrs = new Set<string>(addrResp?.result || []);

    const resp = await rpc('listIdentities');
    if (resp?.result && Array.isArray(resp.result)) {
      // Add all i-addresses to wallet set
      for (const idObj of resp.result) {
        const iAddr = idObj.identity?.identityaddress;
        if (iAddr) walletAddrs.add(iAddr);
      }
      setWalletAddresses(walletAddrs);

      const ids: any[] = [];
      for (const idObj of resp.result) {
        const ident = idObj.identity || {};
        if (ident.name?.startsWith('3965555_')) continue;
        const primaryAddrs = ident.primaryaddresses || [];
        if (!primaryAddrs.includes(address)) continue;
        const iAddr = ident.identityaddress || '';
        const fullResp = await rpc('getIdentity', { nameOrId: iAddr });
        const fullIdent = fullResp?.result?.identity || ident;
        ids.push({
          name: ident.name,
          friendlyName: fullResp?.result?.friendlyname || fullResp?.result?.fullyqualifiedname || (ident.name + '@'),
          iAddress: iAddr,
          primaryAddress: primaryAddrs[0] || '',
          revocationAuthority: fullIdent.revocationauthority || '',
          recoveryAuthority: fullIdent.recoveryauthority || '',
          version: fullIdent.version || 0,
          flags: fullIdent.flags || 0,
          privateAddress: fullIdent.privateaddress || '',
          contentMultimap: fullIdent.contentmultimap || {},
        });
      }
      setIdentities(ids);
    }
    setLoading(false);
  }

  return (
    <div className="screen" style={{ gap: 0, padding: 0 }}>
      <div style={{ padding: '16px 16px 8px' }}>
        <h2 style={{ margin: 0 }}>VerusIDs</h2>
        <p style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 4 }}>
          Identities linked to this address
        </p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <p style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-subtle)', fontSize: 13 }}>Loading...</p>
        ) : identities.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-subtle)', fontSize: 13 }}>
            No identities for this address
          </p>
        ) : (
          identities.map(id => (
            <div key={id.iAddress}
              onClick={() => onSelectId(id, walletAddresses)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: 'white', flexShrink: 0,
                }}>ID</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{id.friendlyName}</div>
                  <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-subtle)' }}>
                    {id.iAddress.slice(0, 12)}...{id.iAddress.slice(-6)}
                  </div>
                </div>
              </div>
              <span style={{ color: 'var(--text-subtle)', fontSize: 16 }}>›</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
