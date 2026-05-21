import React, { useState } from 'react';

interface PendingRequest {
  id: string;
  method: string;
  params: any;
  origin: string;
  context?: any;
}

interface Props {
  request: PendingRequest;
  remaining: number;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

const METHOD_LABELS: Record<string, string> = {
  sendCurrency: 'Send Currency',
  signMessage: 'Sign Message',
  updateIdentity: 'Update VerusID',
};

export function ApproveScreen({ request, remaining, onApprove, onReject }: Props) {
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const label = METHOD_LABELS[request.method] || request.method;

  function handleApprove() {
    if (!password) return;
    setVerifying(true);
    setError('');
    chrome.runtime.sendMessage({ type: 'VERIFY_PASSWORD', password }, (resp) => {
      setVerifying(false);
      if (resp?.ok) {
        onApprove(request.id);
      } else {
        setError('Wrong password');
        setPassword('');
      }
    });
  }

  // Method-specific renderers. If a method ends up here without a body, the
  // user is being asked to approve an opaque request — we MUST refuse to render
  // an approval button. Adding a new APPROVAL_REQUIRED method without an entry
  // here is a security regression, so we hard-fail loud.
  const KNOWN_METHODS = new Set(['sendCurrency', 'signMessage', 'updateIdentity']);
  if (!KNOWN_METHODS.has(request.method)) {
    return (
      <div className="w-full h-screen bg-gray-50 flex flex-col">
        <div className="bg-red-600 text-white px-4 py-3 font-semibold text-sm">Unsupported request</div>
        <div className="p-4 text-sm text-gray-700">
          <p className="mb-2">
            The site <strong>{request.origin}</strong> is requesting <code>{request.method}</code>,
            which this wallet cannot display safely.
          </p>
          <p className="text-xs text-gray-500">
            The wallet refuses to sign requests whose parameters it cannot render to you for review.
          </p>
        </div>
        <div className="px-4 py-3 mt-auto border-t border-gray-200 bg-white">
          <button
            onClick={() => onReject(request.id)}
            className="w-full h-10 rounded-lg bg-gray-800 text-sm font-medium text-white"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-amber-500 text-white px-4 py-3 flex items-center justify-between">
        <span className="font-semibold text-sm">Approval Required</span>
        {remaining > 0 && (
          <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
            +{remaining} more
          </span>
        )}
      </div>

      {/* Origin */}
      <div className="px-4 pt-4 pb-2">
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">Requesting Site</div>
          <div className="text-sm font-medium text-gray-800 mt-0.5 truncate">{request.origin}</div>
        </div>
      </div>

      {/* Action */}
      <div className="px-4 py-2 flex-1 overflow-y-auto">
        <div className="bg-white border border-amber-200 rounded-xl p-4">
          <div className="text-center mb-3">
            <span className="inline-block bg-amber-100 text-amber-700 text-xs font-semibold px-3 py-1 rounded-full">
              {label}
            </span>
          </div>

          {request.method === 'sendCurrency' && (
            <div className="space-y-2">
              <ParamRow label="To" value={request.params.to} mono />
              <ParamRow label="Amount" value={`${request.params.amount} ${request.params.currency || 'VRSC'}`} />
              {request.params.convertto && (
                <ParamRow label="Convert to" value={request.params.convertto} />
              )}
              {request.params.via && (
                <ParamRow label="Via" value={request.params.via} />
              )}
              {request.params.memo && (
                <ParamRow label="Memo" value={request.params.memo} />
              )}
            </div>
          )}

          {request.method === 'signMessage' && (
            <div className="space-y-2">
              {request.params.identity && (
                <ParamRow label="Identity" value={request.params.identity} />
              )}
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium mb-1">Message</div>
                <div className="bg-gray-50 rounded-lg p-2 text-xs text-gray-700 font-mono break-all max-h-24 overflow-y-auto">
                  {request.params.message}
                </div>
              </div>
            </div>
          )}

          {request.method === 'updateIdentity' && (
            <UpdateIdentityDiff
              proposed={request.params.identity}
              current={request.context?.currentIdentity}
              contextError={request.context?.contextError}
            />
          )}
        </div>
      </div>

      {/* Password confirmation */}
      <div className="px-4 py-2">
        <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium mb-1">Enter password to confirm</div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleApprove()}
          placeholder="Wallet password"
          autoFocus
          className="w-full h-9 px-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
        />
        {error && <div className="text-xs text-red-500 mt-1">{error}</div>}
      </div>

      {/* Warning */}
      <div className="px-4 py-2">
        <div className="bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-[11px] text-red-600">
          Only approve transactions from sites you trust. This action will be signed by your local Verus wallet.
        </div>
      </div>

      {/* Buttons */}
      <div className="px-4 py-3 border-t border-gray-200 bg-white flex gap-3">
        <button
          onClick={() => onReject(request.id)}
          className="flex-1 h-10 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Reject
        </button>
        <button
          onClick={handleApprove}
          disabled={!password || verifying}
          className="flex-1 h-10 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {verifying ? 'Verifying...' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

function ParamRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">{label}</span>
      <span className={`text-sm text-gray-800 ${mono ? 'font-mono text-xs' : ''} max-w-[200px] truncate`}>
        {value}
      </span>
    </div>
  );
}

function arrayEq(a: any, b: any): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a.length !== b.length) return false;
  return a.every((v, i) => JSON.stringify(v) === JSON.stringify(b[i]));
}

function authorityChanged(proposed: any, current: any, field: 'revocationauthority' | 'recoveryauthority'): boolean {
  if (!current) return true; // can't diff against unknown — treat as changed
  return proposed?.[field] !== current?.[field];
}

function UpdateIdentityDiff({
  proposed,
  current,
  contextError,
}: {
  proposed: any;
  current: any;
  contextError?: string;
}) {
  if (!proposed) return <p className="text-xs text-red-600">No identity payload — refusing to display.</p>;

  const idName = proposed.name && proposed.parent ? `${proposed.name}@` : proposed.identityaddress || '(unknown)';
  const loadingCtx = !current && !contextError;

  if (loadingCtx) {
    return (
      <div className="text-xs text-gray-500">
        Loading current identity state to diff against…
      </div>
    );
  }

  const primaryChanged = !current || !arrayEq(proposed.primaryaddresses, current.primaryaddresses);
  const revokeChanged = authorityChanged(proposed, current, 'revocationauthority');
  const recoverChanged = authorityChanged(proposed, current, 'recoveryauthority');

  // High-stakes fields. If a remote site is changing any of these, surface it
  // prominently — these are the seizure vectors flagged in the audit.
  const dangerous = revokeChanged || recoverChanged;

  // contentmultimap diff: list added / removed top-level keys.
  const currentCmm = current?.contentmultimap || {};
  const proposedCmm = proposed.contentmultimap || {};
  const added = Object.keys(proposedCmm).filter(k => !(k in currentCmm));
  const removed = Object.keys(currentCmm).filter(k => !(k in proposedCmm));
  const modified = Object.keys(proposedCmm).filter(
    k => k in currentCmm && JSON.stringify(proposedCmm[k]) !== JSON.stringify(currentCmm[k])
  );

  return (
    <div className="space-y-3">
      <div className="border-b border-gray-100 pb-2">
        <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">Identity</div>
        <div className="text-sm font-mono mt-0.5 break-all">{idName}</div>
      </div>

      {contextError && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-800">
          {contextError}. Approve only if you trust the requesting site to know what it is changing.
        </div>
      )}

      {dangerous && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-2">
          <div className="text-[11px] font-bold text-red-700 uppercase tracking-wider">
            ⚠ This request changes ownership controls
          </div>
          <div className="text-[11px] text-red-700 mt-1">
            Revoke / recovery authority changes can allow a third party to seize this VerusID.
            Only approve if you set this up intentionally.
          </div>
        </div>
      )}

      {primaryChanged && (
        <DiffBlock
          label="Primary addresses"
          before={current?.primaryaddresses || []}
          after={proposed.primaryaddresses || []}
        />
      )}

      {revokeChanged && (
        <DiffBlock
          label="Revocation authority"
          danger
          before={current?.revocationauthority || '(unknown)'}
          after={proposed.revocationauthority || '(unset)'}
        />
      )}

      {recoverChanged && (
        <DiffBlock
          label="Recovery authority"
          danger
          before={current?.recoveryauthority || '(unknown)'}
          after={proposed.recoveryauthority || '(unset)'}
        />
      )}

      {(added.length > 0 || removed.length > 0 || modified.length > 0) && (
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wider font-medium mb-1">Content multimap</div>
          <ul className="text-[11px] font-mono space-y-0.5">
            {added.map(k => <li key={'a' + k} className="text-green-700">+ {k}</li>)}
            {removed.map(k => <li key={'r' + k} className="text-red-700">− {k}</li>)}
            {modified.map(k => <li key={'m' + k} className="text-amber-700">~ {k}</li>)}
          </ul>
        </div>
      )}

      {!primaryChanged && !revokeChanged && !recoverChanged && added.length === 0 && removed.length === 0 && modified.length === 0 && (
        <div className="text-[11px] text-gray-500">No detectable changes vs. current on-chain state.</div>
      )}
    </div>
  );
}

function DiffBlock({
  label,
  before,
  after,
  danger,
}: {
  label: string;
  before: any;
  after: any;
  danger?: boolean;
}) {
  const renderVal = (v: any) =>
    Array.isArray(v) ? v.join('\n') : (typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <div>
      <div className={`text-[10px] uppercase tracking-wider font-medium mb-1 ${danger ? 'text-red-600' : 'text-gray-400'}`}>{label}</div>
      <div className="bg-red-50 border border-red-100 rounded p-1.5 text-[11px] font-mono text-red-800 whitespace-pre-wrap break-all">
        − {renderVal(before)}
      </div>
      <div className="bg-green-50 border border-green-100 rounded p-1.5 text-[11px] font-mono text-green-800 whitespace-pre-wrap break-all mt-1">
        + {renderVal(after)}
      </div>
    </div>
  );
}
