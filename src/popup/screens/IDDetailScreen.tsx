import React, { useState } from 'react';
import { IconBack } from '../components/Icons';

interface IdentityInfo {
  name: string;
  friendlyName: string;
  iAddress: string;
  primaryAddress: string;
  revocationAuthority: string;
  recoveryAuthority: string;
  version: number;
  flags: number;
  privateAddress: string;
  contentMultimap: Record<string, any>;
}

interface Props {
  identity: IdentityInfo;
  canUpdate: boolean;
  canRevoke: boolean;
  canRecover: boolean;
  onBack: () => void;
  onRefresh: () => void;
}

function rpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_RPC', method, params: params || {} }, (r) => resolve(r));
  });
}

type Action = null | 'edit' | 'contentmultimap' | 'revoke';

export function IDDetailScreen({ identity: id, canUpdate, canRevoke, canRecover, onBack, onRefresh }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [actionInput, setActionInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState('');

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 1500);
  }

  // Edit form state
  const [editPrimary, setEditPrimary] = useState('');
  const [editRevoke, setEditRevoke] = useState('');
  const [editRecovery, setEditRecovery] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);

  function startAction(type: Action) {
    setAction(type);
    setActionInput('');
    setError('');
    setSuccess('');
    setConfirmStep(false);
    if (type === 'edit') {
      setEditPrimary(id.primaryAddress);
      setEditRevoke(id.revocationAuthority);
      setEditRecovery(id.recoveryAuthority);
    }
    if (type === 'contentmultimap') {
      setActionInput(Object.keys(id.contentMultimap).length > 0 ? JSON.stringify(id.contentMultimap, null, 2) : '{\n  \n}');
    }
  }

  async function executeAction() {
    if (!action || (action !== 'revoke' && action !== 'edit' && !actionInput.trim())) return;
    setLoading(true);
    setError('');

    // Check primary address has funds for the fee
    const balResp = await rpc('getBalance', { address: id.primaryAddress });
    const vrscBal = balResp?.result?.currencybalance?.['i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV'] || 0;
    if (Number(vrscBal) < 0.0001) {
      setError(`Insufficient funds at primary address (${id.primaryAddress.slice(0, 8)}...) — need at least 0.0001 VRSC for the transaction fee`);
      setLoading(false);
      return;
    }

    // Fetch the full current identity object — daemon needs all fields for sub-IDs
    const fullResp = await rpc('getIdentity', { nameOrId: id.iAddress });
    if (fullResp?.error || !fullResp?.result?.identity) {
      setError('Failed to fetch identity');
      setLoading(false);
      return;
    }
    const identityUpdate = { ...fullResp.result.identity };

    switch (action) {
      case 'edit':
        if (editPrimary.trim()) identityUpdate.primaryaddresses = [editPrimary.trim()];
        if (editRevoke.trim()) identityUpdate.revocationauthority = editRevoke.trim();
        if (editRecovery.trim()) identityUpdate.recoveryauthority = editRecovery.trim();
        break;
      case 'contentmultimap':
        try {
          const parsed = JSON.parse(actionInput);
          if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            setError('Content multimap must be a JSON object');
            setLoading(false);
            return;
          }
          identityUpdate.contentmultimap = parsed;
        } catch {
          setError('Invalid JSON');
          setLoading(false);
          return;
        }
        break;
      case 'revoke':
        identityUpdate.flags = identityUpdate.flags | 2;
        break;
    }

    const resp = await rpc('updateIdentity', { identity: identityUpdate });
    setLoading(false);
    if (resp?.error) {
      setError(resp.error);
    } else {
      setSuccess('Identity updated! Transaction submitted.');
      setAction(null);
      setActionInput('');
      setTimeout(() => { setSuccess(''); onRefresh(); }, 2000);
    }
  }

  const ACTION_LABELS: Record<string, { placeholder: string; inputType: 'text' | 'textarea' }> = {
    contentmultimap: { placeholder: '{ "vdxfkey": "value" }', inputType: 'textarea' },
  };

  function renderInlineAction(type: string) {
    if (action !== type) return null;
    const info = ACTION_LABELS[type];
    if (!info) return null;
    return (
      <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {info.inputType === 'textarea' ? (
          <textarea value={actionInput} onChange={(e) => setActionInput(e.target.value)}
            placeholder={info.placeholder} autoFocus
            style={{ width: '100%', minHeight: 80, fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', resize: 'vertical' }} />
        ) : (
          <input type="text" value={actionInput} onChange={(e) => setActionInput(e.target.value)}
            placeholder={info.placeholder} autoFocus
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
        )}
        {error && <p className="error" style={{ margin: 0, fontSize: 11 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => { setAction(null); setError(''); }} style={{ flex: 1, padding: '6px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-primary)' }}>Cancel</button>
          <button onClick={executeAction} disabled={loading || !actionInput.trim()}
            style={{ flex: 1, padding: '6px', fontSize: 12, borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'white', cursor: 'pointer', opacity: loading || !actionInput.trim() ? 0.5 : 1 }}>
            {loading ? 'Updating...' : 'Update'}
          </button>
        </div>
      </div>
    );
  }

  // Main detail view
  return (
    <div className="screen" style={{ gap: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <button className="btn-back" onClick={onBack} style={{ marginBottom: 8 }}><IconBack size={16} /> Back</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'linear-gradient(135deg, #10b981, #059669)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: 'white', flexShrink: 0,
          }}>ID</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{id.friendlyName}</div>
          </div>
        </div>
      </div>

      {success && (
        <div style={{ padding: '8px 16px', background: 'var(--success)', color: 'white', fontSize: 12, textAlign: 'center' }}>
          {success}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {/* Info rows */}
        <InfoRow label="i-Address" value={id.iAddress} copied={copied === 'iaddr'} onCopy={() => copy(id.iAddress, 'iaddr')} />
        <InfoRow label="Primary Address" value={id.primaryAddress} copied={copied === 'primary'} onCopy={() => copy(id.primaryAddress, 'primary')} />
        <InfoRow label="Revocation Authority" value={id.revocationAuthority} copied={copied === 'revoke'} onCopy={() => copy(id.revocationAuthority, 'revoke')} />
        <InfoRow label="Recovery Authority" value={id.recoveryAuthority} copied={copied === 'recover'} onCopy={() => copy(id.recoveryAuthority, 'recover')} />
        {id.privateAddress && <InfoRow label="Private Address" value={id.privateAddress} copied={copied === 'zaddr'} onCopy={() => copy(id.privateAddress, 'zaddr')} />}

        {/* Actions */}
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Manage Identity</div>

          {canUpdate && (
            <>
              <ActionBtn label="Edit Identity" onClick={() => startAction('edit')} active={action === 'edit'} />
              {action === 'edit' && (
                <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-subtle)', display: 'block', marginBottom: 2 }}>Primary Address</label>
                    <input type="text" value={editPrimary} onChange={(e) => setEditPrimary(e.target.value)}
                      style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-subtle)', display: 'block', marginBottom: 2 }}>Revocation Authority</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input type="text" value={editRevoke} onChange={(e) => setEditRevoke(e.target.value)}
                        style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, minWidth: 0 }} />
                      <button onClick={() => setEditRevoke(id.iAddress)}
                        style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: editRevoke === id.iAddress ? 'var(--accent)' : 'var(--bg-tertiary)', color: editRevoke === id.iAddress ? 'white' : 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Self
                      </button>
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-subtle)', display: 'block', marginBottom: 2 }}>Recovery Authority</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input type="text" value={editRecovery} onChange={(e) => setEditRecovery(e.target.value)}
                        style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, minWidth: 0 }} />
                      <button onClick={() => setEditRecovery(id.iAddress)}
                        style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: editRecovery === id.iAddress ? 'var(--accent)' : 'var(--bg-tertiary)', color: editRecovery === id.iAddress ? 'white' : 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Self
                      </button>
                    </div>
                  </div>
                  {error && <p className="error" style={{ margin: 0, fontSize: 11 }}>{error}</p>}

                  {!confirmStep ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => { setAction(null); setError(''); setConfirmStep(false); }} style={{ flex: 1, padding: '8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-primary)' }}>Cancel</button>
                      <button onClick={() => setConfirmStep(true)} disabled={editPrimary === id.primaryAddress && editRevoke === id.revocationAuthority && editRecovery === id.recoveryAuthority}
                        style={{ flex: 1, padding: '8px', fontSize: 12, borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'white', cursor: 'pointer', opacity: (editPrimary === id.primaryAddress && editRevoke === id.revocationAuthority && editRecovery === id.recoveryAuthority) ? 0.5 : 1 }}>
                        Review Changes
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)' }}>Confirm Changes</div>
                      <div style={{ fontSize: 11, background: 'var(--bg-tertiary)', padding: 10, borderRadius: 6, border: '1px solid var(--warning)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {editPrimary !== id.primaryAddress && (
                          <div style={{ marginBottom: 4 }}>
                            <div style={{ color: 'var(--text-subtle)' }}>Primary Address</div>
                            <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--error)', wordBreak: 'break-all' }}>- {id.primaryAddress}</div>
                            <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--success)', wordBreak: 'break-all' }}>+ {editPrimary}</div>
                          </div>
                        )}
                        {editRevoke !== id.revocationAuthority && (
                          <div style={{ marginBottom: 4 }}>
                            <div style={{ color: 'var(--text-subtle)' }}>Revocation Authority</div>
                            <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--error)', wordBreak: 'break-all' }}>- {id.revocationAuthority}</div>
                            <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--success)', wordBreak: 'break-all' }}>+ {editRevoke}</div>
                          </div>
                        )}
                        {editRecovery !== id.recoveryAuthority && (
                          <div style={{ marginBottom: 4 }}>
                            <div style={{ color: 'var(--text-subtle)' }}>Recovery Authority</div>
                            <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--error)', wordBreak: 'break-all' }}>- {id.recoveryAuthority}</div>
                            <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--success)', wordBreak: 'break-all' }}>+ {editRecovery}</div>
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--error)', padding: '4px 0' }}>
                        These changes cannot be undone without the appropriate authority.
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => setConfirmStep(false)} style={{ flex: 1, padding: '8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-primary)' }}>Back</button>
                        <button onClick={executeAction} disabled={loading}
                          style={{ flex: 1, padding: '8px', fontSize: 12, borderRadius: 6, border: 'none', background: 'var(--error)', color: 'white', cursor: 'pointer', opacity: loading ? 0.5 : 1 }}>
                          {loading ? 'Updating...' : 'Confirm Update'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <ActionBtn label="Update Content Multimap" onClick={() => startAction('contentmultimap')} active={action === 'contentmultimap'} />
              {renderInlineAction('contentmultimap')}
            </>
          )}
          {!canUpdate && (
            <p style={{ fontSize: 12, color: 'var(--text-subtle)', padding: '8px 0' }}>
              You don't own the primary address — cannot update this identity.
            </p>
          )}

          {canRevoke && (
            <>
              <ActionBtn label="Revoke Identity" onClick={() => startAction('revoke')} danger active={action === 'revoke'} />
              {action === 'revoke' && (
                <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12, color: 'var(--error)', background: 'var(--bg-tertiary)', padding: 8, borderRadius: 6, border: '1px solid var(--error)' }}>
                    This will revoke the identity. Only the recovery authority can restore it.
                  </div>
                  {error && <p className="error" style={{ margin: 0, fontSize: 11 }}>{error}</p>}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setAction(null); setError(''); }} style={{ flex: 1, padding: '6px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-primary)' }}>Cancel</button>
                    <button onClick={executeAction} disabled={loading}
                      style={{ flex: 1, padding: '6px', fontSize: 12, borderRadius: 6, border: 'none', background: 'var(--error)', color: 'white', cursor: 'pointer', opacity: loading ? 0.5 : 1 }}>
                      {loading ? 'Revoking...' : 'Confirm Revoke'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {canRecover && !canUpdate && (
            <>
              <ActionBtn label="Recover Identity" onClick={() => startAction('recovery')} active={action === 'recovery'} />
              {renderInlineAction('recovery')}
            </>
          )}
        </div>

        {/* Advanced */}
        <div style={{ marginTop: 16 }}>
          <button onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {showAdvanced ? 'Hide advanced ▲' : 'Show advanced ▼'}
          </button>

          {showAdvanced && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 16 }}>
                <div><span style={{ fontSize: 10, color: 'var(--text-subtle)' }}>Version</span><div style={{ fontSize: 12 }}>{id.version}</div></div>
                <div><span style={{ fontSize: 10, color: 'var(--text-subtle)' }}>Flags</span><div style={{ fontSize: 12 }}>{id.flags}</div></div>
              </div>

              <div>
                <span style={{ fontSize: 10, color: 'var(--text-subtle)' }}>Content Multimap</span>
                <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', marginTop: 4, background: 'var(--bg-secondary)', padding: 8, borderRadius: 6, maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', border: '1px solid var(--border)' }}>
                  {Object.keys(id.contentMultimap).length > 0 ? JSON.stringify(id.contentMultimap, null, 2) : '(empty)'}
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', cursor: 'pointer', color: 'var(--accent)' }}
        onClick={onCopy}>
        {value} {copied ? '(copied!)' : ''}
      </div>
    </div>
  );
}

function ActionBtn({ label, onClick, danger, active }: { label: string; onClick: () => void; danger?: boolean; active?: boolean }) {
  return (
    <button onClick={onClick}
      style={{
        width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500,
        border: active ? '1px solid var(--accent)' : '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
        background: danger ? (active ? '#b91c1c' : 'var(--error)') : active ? 'var(--accent)' : 'var(--bg-secondary)',
        color: (danger || active) ? 'white' : 'var(--text-primary)',
      }}>
      {label}
    </button>
  );
}
