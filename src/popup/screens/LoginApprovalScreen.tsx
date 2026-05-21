import React, { useState, useEffect } from 'react';
import { IconUser } from '../components/Icons';

interface DeeplinkInfo {
  id: string;
  uri: string;
  origin: string;
  responseUri?: string;
  uriType?: 'post' | 'redirect';
  signingIAddress?: string;
  systemId?: string;
}

interface Props {
  deeplink: DeeplinkInfo;
  onDone: () => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

export function LoginApprovalScreen({ deeplink, onDone }: Props) {
  const [identities, setIdentities] = useState<Array<{ name: string; friendlyName: string; iAddress: string }>>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');
  const [requesterName, setRequesterName] = useState<string>('');

  useEffect(() => {
    loadIdentities();
    // Resolve the relying party's friendly name from its i-address.
    if (deeplink.signingIAddress) {
      rpc('getIdentity', { nameOrId: deeplink.signingIAddress }).then(resp => {
        if (resp?.result?.friendlyname) {
          setRequesterName(resp.result.friendlyname);
        }
      });
    }
  }, []);

  async function loadIdentities() {
    const resp = await rpc('listIdentities');
    if (resp?.result && Array.isArray(resp.result)) {
      const ids: Array<{ name: string; friendlyName: string; iAddress: string }> = [];
      for (const idObj of resp.result) {
        const ident = idObj.identity || {};
        if (ident.name?.startsWith('3965555_')) continue; // skip lottery
        const iAddr = ident.identityaddress || '';
        const fullResp = await rpc('getIdentity', { nameOrId: iAddr });
        const friendlyName = fullResp?.result?.friendlyname || (ident.name + '@');
        ids.push({ name: ident.name, friendlyName, iAddress: iAddr });
      }
      setIdentities(ids);
      if (ids.length > 0) setSelectedId(ids[0].friendlyName);
    }
    setLoading(false);
  }

  function handleApprove() {
    if (!selectedId) return;
    setSigning(true);
    setError('');

    chrome.runtime.sendMessage(
      { type: 'DEEPLINK_APPROVE', id: deeplink.id, identity: selectedId },
      (resp) => {

        setSigning(false);
        if (resp?.ok) {
          onDone();
        } else {
          setError(resp?.error || 'Failed to sign');
        }
      }
    );
  }

  function handleReject() {
    chrome.runtime.sendMessage({ type: 'DEEPLINK_REJECT', id: deeplink.id });
    onDone();
  }

  // The origin that invoked the deeplink (e.g. evil.com calling window.verus.requestLogin)
  // can differ from the host that will receive the signed envelope (responseUri host).
  // We surface both so the user understands which site they are actually signing in to.
  const initiatingOrigin = deeplink.origin || '';
  let callbackHost = '';
  try { if (deeplink.responseUri) callbackHost = new URL(deeplink.responseUri).hostname; } catch {}

  const initiatingHost = (() => {
    try { return initiatingOrigin ? new URL(initiatingOrigin).hostname : ''; } catch { return initiatingOrigin; }
  })();
  const hostsDiffer = !!(callbackHost && initiatingHost && callbackHost !== initiatingHost);

  const responseLabel = deeplink.uriType === 'redirect' ? 'Redirects to' : 'Callback URL';

  return (
    <div className="screen">
      <h2>Sign In Request</h2>
      <p className="subtitle">A website wants you to sign in with VerusID</p>

      {/* Request details */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Initiated by</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{initiatingHost || initiatingOrigin || 'Unknown site'}</div>
        </div>
        {callbackHost && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>You will sign in at</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2, color: hostsDiffer ? 'var(--warning)' : undefined }}>
              {callbackHost}
            </div>
            {hostsDiffer && (
              <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4 }}>
                ⚠ This differs from the initiating site. Make sure you intended to sign in at {callbackHost}.
              </div>
            )}
          </div>
        )}
        {(deeplink.signingIAddress || requesterName) && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Challenge signed by (verified)</div>
            <div style={{ fontSize: 13, fontWeight: 500, marginTop: 2, fontFamily: 'monospace' }}>
              {requesterName || deeplink.signingIAddress}
            </div>
          </div>
        )}
        {deeplink.responseUri && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{responseLabel}</div>
            <div style={{ fontSize: 11, marginTop: 2, fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>
              {deeplink.responseUri}
            </div>
          </div>
        )}
      </div>

      {/* Identity selector */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginBottom: 8 }}>Sign in as</div>
        {loading ? (
          <div className="loading">Loading identities...</div>
        ) : identities.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--error)' }}>No identities found in wallet</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {identities.map((id) => (
              <div key={id.iAddress}
                onClick={() => setSelectedId(id.friendlyName)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                  background: selectedId === id.friendlyName ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: selectedId === id.friendlyName ? 'white' : 'var(--text-primary)',
                }}>
                <IconUser size={14} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>{id.friendlyName}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Warning */}
      <div style={{ fontSize: 12, color: 'var(--warning)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '8px 12px' }}>
        Only sign in to sites you trust.
      </div>

      {error && <p className="error">{error}</p>}

      {/* Buttons */}
      <div className="action-buttons" style={{ marginTop: 'auto' }}>
        <button className="btn btn-secondary" onClick={handleReject}>Reject</button>
        <button className="btn btn-primary" onClick={handleApprove} disabled={signing || !selectedId || loading}>
          {signing ? 'Signing...' : 'Approve'}
        </button>
      </div>
    </div>
  );
}
