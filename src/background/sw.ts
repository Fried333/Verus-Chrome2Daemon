/**
 * Service worker — the brain of the extension.
 * Makes JSON-RPC calls directly to the local Verus daemon.
 * No native messaging, no external servers.
 */

import { parseDeeplink, signAndDeliverLogin, verifyRequestSignature } from './login-handler';
import type { ParsedLoginRequest } from './login-handler';

// === VerusSub Helpers ===
function hexToUtf8(hex: string): string {
  return new TextDecoder().decode(
    new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)))
  );
}

function utf8ToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// === RPC Method Security Gates ===
// Web pages can ONLY call methods in these two sets. Everything else is rejected.
// All methods require the wallet to be unlocked.
// APPROVAL_REQUIRED methods additionally need explicit user approval via popup.
//
// Dangerous daemon methods (dumpprivkey, z_exportkey, etc.)
// are NOT in either set and cannot be called from any context.

// Methods that require user approval via popup before execution.
//
// signRawTransaction is intentionally NOT here: signing an opaque hex blob
// from a web page is not safely approvable without a full input/output decode
// in the UI. Popup-internal flows (e.g. subscription) call signrawtransaction
// via callRpc directly and bypass this allowlist.
//
// createRawTransaction is also intentionally absent — building a tx is a
// daemon side-effect-free operation but is paired with signing; gating it
// here costs nothing and removes a footprint.
const APPROVAL_REQUIRED = new Set([
  'sendCurrency',          // Sends funds — always needs user approval
  'signMessage',           // Signs arbitrary messages — always needs user approval
  'updateIdentity',        // Changes identity on-chain (primary addr, revoke, recover, contentmultimap)
  'executeSubscription',   // VerusSub: funds and signs the subscription
  'cancelSubscription',    // VerusSub: cancels and sweeps remaining funds
]);

// Read-only methods — require unlock but no approval popup
const READ_ONLY = new Set([
  'getInfo',              // Chain info (block height, version)
  'getBalance',           // Address balance
  'getAddress',           // List wallet addresses
  'getIdentity',          // Look up a VerusID
  'estimateConversion',   // Estimate currency conversion
  'getUtxos',             // Address UTXOs
  'getCurrency',          // Currency info
  'getBlock',             // Current block height
  'getAddressTxids',      // Transaction IDs for an address
  'getRawTransaction',    // Decoded transaction details
]);

interface PendingApproval {
  id: string;
  method: string;
  params: any;
  origin: string;
  // Optional pre-fetched context the popup approval UI can render. Currently
  // used for updateIdentity to diff the requested change against the current
  // on-chain state.
  context?: any;
  resolve: (result: any) => void;
  reject: (error: string) => void;
}

let pendingApprovals: PendingApproval[] = [];
let connectedAddress: string | null = null;
let isUnlocked = false;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let lockTimeoutMs = 5 * 60 * 1000; // Default: 5 minutes

// Load saved lock timeout
chrome.storage.local.get(['lockTimeout'], (data) => {
  if (data.lockTimeout) lockTimeoutMs = data.lockTimeout;
});

// Load saved state
chrome.storage.local.get(['connectedAddress'], (data) => {
  connectedAddress = data.connectedAddress || null;
});

// Open side panel when clicking the extension icon (like MetaMask)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// === Lock / Unlock ===

function broadcastLock() {
  chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }).catch(() => {});
}

function resetLockTimer() {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { isUnlocked = false; broadcastLock(); }, lockTimeoutMs);
}

// OWASP 2024 minimum for PBKDF2-HMAC-SHA256. Old hashes (iterations:100000)
// are migrated to the new cost the first time the user enters the correct
// password.
const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 100_000;

async function deriveHash(password: string, saltBytes: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function verifyPassword(password: string): Promise<boolean> {
  const data = await chrome.storage.local.get(['passwordHash', 'passwordSalt', 'passwordIterations']);
  if (!data.passwordHash || !data.passwordSalt) return false;
  const salt = Uint8Array.from(atob(data.passwordSalt), c => c.charCodeAt(0));
  const storedIter: number = data.passwordIterations || LEGACY_PBKDF2_ITERATIONS;
  const hash = await deriveHash(password, salt, storedIter);
  if (hash !== data.passwordHash) return false;
  // Successful verify against a legacy-iteration hash — re-derive at the new
  // cost and persist. Same salt is fine; we're not rotating, just stretching.
  if (storedIter < PBKDF2_ITERATIONS) {
    try {
      const newHash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
      await chrome.storage.local.set({ passwordHash: newHash, passwordIterations: PBKDF2_ITERATIONS });
    } catch {
      // Migration is best-effort. If it fails the user still has a valid
      // legacy hash and we'll retry on the next unlock.
    }
  }
  return true;
}

async function setPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
  const saltB64 = btoa(String.fromCharCode(...salt));
  await chrome.storage.local.set({
    passwordHash: hash,
    passwordSalt: saltB64,
    passwordIterations: PBKDF2_ITERATIONS,
  });
}

// === RPC Client ===

// Per-chain creds. Each chain has its own daemon — the active chain decides
// which one we talk to. The daemon owns chain-specific concerns (fees,
// currency rules); the extension just routes RPC to the right host.
interface ChainCreds {
  name: string;       // Display label shown in the UI (e.g. "VRSC", "vDEX")
  host: string;
  port: string;
  user: string;
  password: string;
}
type ChainsMap = Record<string, ChainCreds>;

// One-shot migration from the single-chain shape (rpcHost/rpcPort/...) to the
// per-chain shape. Runs once on first read after upgrade and then leaves the
// old keys removed.
async function migrateLegacyRpcConfig(): Promise<void> {
  const data = await chrome.storage.local.get([
    'chains', 'activeChain', 'rpcHost', 'rpcPort', 'rpcUser', 'rpcPassword',
  ]);
  if (data.chains) return;
  if (!data.rpcUser || !data.rpcPassword) return;
  const chains: ChainsMap = {
    VRSC: {
      name: 'VRSC',
      host: data.rpcHost || '127.0.0.1',
      port: data.rpcPort || '27486',
      user: data.rpcUser,
      password: data.rpcPassword,
    },
  };
  await chrome.storage.local.set({ chains, activeChain: 'VRSC' });
  await chrome.storage.local.remove(['rpcHost', 'rpcPort', 'rpcUser', 'rpcPassword']);
}

async function getRpcConfig(): Promise<{ url: string; user: string; pass: string } | null> {
  await migrateLegacyRpcConfig();
  const data = await chrome.storage.local.get(['chains', 'activeChain']);
  const chains: ChainsMap = data.chains || {};
  const activeKey: string | undefined = data.activeChain;
  const chain = activeKey ? chains[activeKey] : undefined;
  if (!chain || !chain.user || !chain.password) return null;
  return {
    url: `http://${chain.host || '127.0.0.1'}:${chain.port || '27486'}`,
    user: chain.user,
    pass: chain.password,
  };
}

async function callRpc(method: string, params: any[] = []): Promise<any> {
  const config = await getRpcConfig();
  if (!config) throw new Error('RPC not configured. Open the extension to set up your connection.');

  const body = JSON.stringify({ jsonrpc: '1.0', id: Date.now(), method, params });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + btoa(`${config.user}:${config.pass}`),
  };

  const response = await fetch(config.url, { method: 'POST', headers, body });
  const json = await response.json();

  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

// === Method Handlers ===
// Each handler maps the extension API to specific RPC calls with safe parameter construction.

async function handleMethod(method: string, params: any): Promise<any> {
  switch (method) {
    case 'getInfo':
      return callRpc('getinfo');

    case 'getBlock':
      return callRpc('getblockcount');

    case 'getAddress': {
      const addresses = await callRpc('getaddressesbyaccount', ['']);
      return Array.isArray(addresses) ? addresses : [];
    }

    case 'getBalance': {
      const addr = params?.address || connectedAddress;
      if (!addr) throw new Error('No address');
      return callRpc('getaddressbalance', [{ addresses: [addr], friendlynames: true }]);
    }

    case 'getIdentity':
      if (!params?.nameOrId) throw new Error('Identity name or ID required');
      return callRpc('getidentity', [params.nameOrId]);

    case 'getCurrency':
      if (!params?.name) throw new Error('Currency name required');
      return callRpc('getcurrency', [params.name]);

    case 'estimateConversion': {
      if (!params?.from || !params?.to || !params?.amount) throw new Error('from, to, and amount required');
      const convParams: any = { currency: params.from, convertto: params.to, amount: params.amount };
      if (params.via) convParams.via = params.via;
      return callRpc('estimateconversion', [convParams]);
    }

    case 'getUtxos': {
      const addr = params?.address || connectedAddress;
      if (!addr) throw new Error('No address');
      return callRpc('getaddressutxos', [{ addresses: [addr] }]);
    }

    case 'sendCurrency': {
      if (!params?.from && !connectedAddress) throw new Error('No from address');
      const fromAddr = params.from || connectedAddress;

      // Page-callable sendCurrency is single-output only. The approval UI
      // renders a fixed set of fields and a sneaky `outputs[]` array could
      // bypass that rendering. Internal flows (executeSubscription) call
      // sendcurrency via callRpc directly and do not enter this branch.
      if (!params?.to || !params?.amount) throw new Error('to and amount required');
      const output: any = { address: params.to, amount: params.amount };
      if (params.currency) output.currency = params.currency;
      if (params.convertto) output.convertto = params.convertto;
      if (params.via) output.via = params.via;
      if (params.memo) output.memo = params.memo;
      const outputs = [output];

      const opid = await callRpc('sendcurrency', [fromAddr, outputs]);
      // Poll for result to get the actual txid
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const ops = await callRpc('z_getoperationresult', [[opid]]);
        if (ops && ops.length > 0) {
          if (ops[0].status === 'success') return { txid: ops[0].result?.txid, opid };
          if (ops[0].status === 'failed') throw new Error(ops[0].error?.message || 'Send failed');
        }
      }
      // If still pending after 30s, return the opid
      return { opid, pending: true };
    }

    case 'signMessage': {
      if (!params?.message) throw new Error('Message required');
      const identity = params.identity || connectedAddress;
      if (!identity) throw new Error('No identity');
      return callRpc('signmessage', [identity, params.message]);
    }

    case 'newAddress':
      return callRpc('getnewaddress');

    case 'listIdentities':
      return callRpc('listidentities');

    case 'updateIdentity': {
      if (!params?.identity) throw new Error('Identity object required');
      // sourceoffunds = primary address of the identity (5th param)
      const sourceAddr = params.sourceoffunds || (params.identity.primaryaddresses?.[0]) || undefined;
      const args: any[] = [params.identity, false, false, 0.0001];
      if (sourceAddr) args.push(sourceAddr);
      return callRpc('updateidentity', args);
    }

    case 'createRawTransaction': {
      if (!params?.inputs || !params?.outputs) throw new Error('inputs and outputs required');
      const args: any[] = [params.inputs, params.outputs];
      if (params.locktime !== undefined) args.push(params.locktime);
      if (params.expiryheight !== undefined) args.push(params.expiryheight);
      return callRpc('createrawtransaction', args);
    }

    case 'signRawTransaction': {
      if (!params?.hex) throw new Error('hex required');
      return callRpc('signrawtransaction', [params.hex]);
    }

    case 'subscribe': {
      if (!params?.provider) throw new Error('provider required');

      // 1. Read provider terms from chain
      const providerIdentity = await callRpc('getidentity', [params.provider]);
      if (!providerIdentity?.identity) throw new Error('Provider identity not found');
      const cmm = providerIdentity.identity.contentmultimap || {};
      const termsKey = 'i8iZrgfNEB5c8oEGENRC9B5Cv8Agvv3mqv'; // veruspay.vrsc::subscription.terms
      if (!cmm[termsKey]) throw new Error('Provider has no subscription terms');

      let terms: any;
      try {
        const raw = Array.isArray(cmm[termsKey]) ? cmm[termsKey][0] : cmm[termsKey];
        terms = JSON.parse(typeof raw === 'string' && raw.match(/^[0-9a-f]+$/i) ? hexToUtf8(raw) : raw);
      } catch { throw new Error('Invalid subscription terms format'); }

      const plan = params.planId
        ? terms.plans.find((p: any) => p.planId === params.planId)
        : terms.plans[0];
      if (!plan) throw new Error('Plan not found');

      // Clear any stale pending subscriptions and their callbacks
      for (const [oldId, oldCb] of subscriptionCallbacks.entries()) {
        oldCb.reject('Replaced by new subscription request');
      }
      pendingSubscriptions.clear();
      subscriptionCallbacks.clear();

      // Store pending subscription for the approval UI
      const subId = crypto.randomUUID();
      pendingSubscriptions.set(subId, {
        provider: params.provider,
        providerName: providerIdentity.friendlyname || params.provider,
        plan,
        terms,
        origin: params.origin || '',
        subscriberId: params.subscriberId || '',
      });

      // Alert user — open side panel
      chrome.action.setBadgeText({ text: '1' });
      chrome.action.setBadgeBackgroundColor({ color: '#8250df' });
      try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.windowId && chrome.sidePanel) await (chrome.sidePanel as any).open({ windowId: tab.windowId }); } catch {
        try {
          chrome.notifications.create('verus-sub-' + subId, {
            type: 'basic', iconUrl: 'images/icon-128.png',
            title: 'Subscription Request',
            message: `${providerIdentity.friendlyname || params.provider} wants you to subscribe.`,
          });
        } catch {}
      }

      // Wait for user approval/rejection
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingSubscriptions.delete(subId);
          subscriptionCallbacks.delete(subId);
          reject(new Error('Subscription request timed out'));
        }, 300_000);
        subscriptionCallbacks.set(subId, {
          resolve: (result: any) => { clearTimeout(timeout); resolve(result); },
          reject: (error: string) => { clearTimeout(timeout); reject(new Error(error)); },
        });
      });
    }

    case 'executeSubscription': {
      // Called after user approves the subscription terms
      if (!params?.provider || !params?.plan) throw new Error('provider and plan required');
      const plan = params.plan;

      // Send progress updates to the UI (side panel) so it can show real status
      const sendProgress = (status: string) => {
        try { chrome.runtime.sendMessage({ type: 'SUBSCRIPTION_PROGRESS', status }); } catch {}
      };

      // Use the address the user selected in the approval screen
      const fromAddr = params.from || connectedAddress;
      if (!fromAddr) throw new Error('No source address');

      // 2. Use pre-generated address or create new one
      const dedicated = params.dedicatedAddress || await callRpc('getnewaddress', []);

      // 3. Fund with N UTXOs
      // For non-VRSC: interleave currency + VRSC fee outputs (currency at even vouts, VRSC at odd)
      const planCurr = plan.currency || 'VRSC';
      const fundOutputs: any[] = [];
      for (let i = 0; i < plan.periods; i++) {
        if (planCurr === 'VRSC') {
          fundOutputs.push({ address: dedicated, amount: plan.amount });
        } else {
          fundOutputs.push({ address: dedicated, amount: plan.amount, currency: planCurr });
          fundOutputs.push({ address: dedicated, amount: 0.0001 }); // VRSC for this period's broadcast fee
        }
      }
      sendProgress('Funding dedicated address...');
      const fundOpid = await callRpc('sendcurrency', [fromAddr, fundOutputs]);

      // Poll for funding txid (short timeout — service worker can be killed)
      let fundingTxid: string | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const ops = await callRpc('z_getoperationresult', [[fundOpid]]);
        if (ops?.length > 0) {
          if (ops[0].status === 'success') { fundingTxid = ops[0].result?.txid; break; }
          if (ops[0].status === 'failed') throw new Error(ops[0].error?.message || 'Funding failed');
        }
      }
      if (!fundingTxid) throw new Error('Funding timed out');

      // 4. For non-VRSC currencies, must wait for confirmation before signing
      // (VRSC UTXOs can be signed unconfirmed, currency UTXOs cannot)
      if (planCurr !== 'VRSC') {
        sendProgress('Waiting for funding confirmation...');
        let confirmed = false;
        for (let i = 0; i < 90; i++) { // ~7.5 minutes max
          await new Promise(r => setTimeout(r, 5000));
          const txCheck = await callRpc('getrawtransaction', [fundingTxid, 1]);
          if (txCheck?.confirmations >= 1) { confirmed = true; break; }
        }
        if (!confirmed) throw new Error('Funding TX confirmation timed out');
      }

      sendProgress('Signing time-locked transactions...');
      // 5. Get block height and create time-locked TXs
      const info = await callRpc('getinfo', []);
      const currentBlock = info.blocks;
      const expiry = currentBlock + 500000;
      const planCurrency = plan.currency || 'VRSC';
      // For VRSC: deduct fee from payment. For other currencies: fee is paid in VRSC separately
      const payment = planCurrency === 'VRSC' ? plan.amount - 0.0001 : plan.amount;

      // For non-VRSC currencies, resolve the currency name to i-address
      let currencyId = '';
      if (planCurrency !== 'VRSC') {
        const currInfo = await callRpc('getcurrency', [planCurrency]);
        if (currInfo?.currencyid) currencyId = currInfo.currencyid;
        else throw new Error(`Currency ${planCurrency} not found`);
      }

      // Resolve payment address — createrawtransaction needs i-address, not friendly name
      let payAddr = plan.paymentAddress;
      if (payAddr && payAddr.includes('@')) {
        const payId = await callRpc('getidentity', [payAddr]);
        if (payId?.identity?.identityaddress) payAddr = payId.identity.identityaddress;
      }

      const transactions: any[] = [];
      for (let i = 0; i < plan.periods; i++) {
        const locktime = i === 0 ? 0 : currentBlock + 5 + (plan.intervalBlocks * i);

        let inputs: any[];
        let output: any;

        if (planCurrency === 'VRSC') {
          inputs = [{ txid: fundingTxid, vout: i }];
          output = { [payAddr]: payment };
        } else {
          // Non-VRSC: currency at vout i*2, VRSC fee at vout i*2+1
          const currVout = i * 2;
          const feeVout = i * 2 + 1;
          inputs = [
            { txid: fundingTxid, vout: currVout },
            { txid: fundingTxid, vout: feeVout },
          ];
          output = { [payAddr]: { [currencyId]: payment } };
        }

        const raw = await callRpc('createrawtransaction', [
          inputs,
          output,
          locktime,
          expiry,
        ]);
        const signed = await callRpc('signrawtransaction', [raw]);
        if (!signed?.complete) {
          throw new Error(`Failed to sign TX ${i + 1}`);
        }

        transactions.push({
          period: i + 1,
          lockTime: locktime,
          rawTx: signed.hex,
        });
      }

      // 6. Build subscription payload
      // On-chain payload is lightweight (no transactions) to stay within contentmultimap size limits.
      // Signed transactions are returned to the caller and sent directly to the broadcast server.
      const subscriberId = params.subscriberId || connectedAddress;
      const payload = {
        version: 2,
        providerId: params.provider,
        subscriberId,
        dedicatedAddress: dedicated,
        fundingTxid,
        startBlock: currentBlock + 5,
        intervalBlocks: plan.intervalBlocks,
        totalPeriods: plan.periods,
        paymentAmount: payment,
        currency: plan.currency || 'VRSC',
      };

      // 7. Store in subscriber's contentmultimap (if subscriberId is an identity)
      // Supports multiple subscriptions — each provider gets its own array entry
      if (subscriberId && !subscriberId.startsWith('R')) {
        sendProgress('Storing subscription on-chain...');

        // Wait for any prior unconfirmed identity update to confirm first.
        // The daemon rejects updateidentity if there's already an unconfirmed one for the same identity.
        const subIdForCheck = await callRpc('getidentity', [subscriberId]);
        if (subIdForCheck?.identity) {
          const idAddr = subIdForCheck.identity.identityaddress;
          if (idAddr) {
            const mempool = await callRpc('getrawmempool', []);
            if (Array.isArray(mempool) && mempool.length > 0) {
              // Check if any mempool TX touches this identity
              let hasPendingIdUpdate = false;
              for (const mptxid of mempool) {
                try {
                  const mptx = await callRpc('getrawtransaction', [mptxid, 1]);
                  if (mptx?.vout?.some((v: any) => v.scriptPubKey?.identityprimary?.identityaddress === idAddr)) {
                    hasPendingIdUpdate = true;
                    break;
                  }
                } catch {}
              }
              if (hasPendingIdUpdate) {
                sendProgress('Waiting for prior identity update to confirm...');
                let idConfirmed = false;
                for (let i = 0; i < 90; i++) {
                  await new Promise(r => setTimeout(r, 5000));
                  // Re-check mempool for this identity
                  const mp2 = await callRpc('getrawmempool', []);
                  let stillPending = false;
                  if (Array.isArray(mp2)) {
                    for (const mptxid of mp2) {
                      try {
                        const mptx = await callRpc('getrawtransaction', [mptxid, 1]);
                        if (mptx?.vout?.some((v: any) => v.scriptPubKey?.identityprimary?.identityaddress === idAddr)) {
                          stillPending = true;
                          break;
                        }
                      } catch {}
                    }
                  }
                  if (!stillPending) { idConfirmed = true; break; }
                }
                if (!idConfirmed) throw new Error('Prior identity update confirmation timed out');
              }
            }
          }
        }

        // Re-read identity after any waits (state may have changed)
        const subIdentity = await callRpc('getidentity', [subscriberId]);
        if (subIdentity?.identity) {
          const existingCmm = subIdentity.identity.contentmultimap || {};
          const activeKey = 'iCvwWogVjiNCbiKVE38t88MEqFVFfDrjYY'; // veruspay.vrsc::subscription.active
          const existingEntries = existingCmm[activeKey] || [];

          // Decode existing entries, filter out this provider, and migrate v1 entries (strip transactions)
          const otherSubs: string[] = [];
          for (const hex of existingEntries) {
            try {
              const decoded = JSON.parse(hexToUtf8(hex));
              if (decoded.providerId === params.provider) continue; // remove old entry for this provider
              // Migrate v1 entries: strip transactions to save space
              if (decoded.transactions) {
                delete decoded.transactions;
                decoded.version = 2;
                otherSubs.push(utf8ToHex(JSON.stringify(decoded)));
              } else {
                otherSubs.push(hex); // already v2 or no transactions
              }
            } catch { otherSubs.push(hex); } // keep entries we can't decode
          }
          existingCmm[activeKey] = [...otherSubs, utf8ToHex(JSON.stringify(payload))];

          const identUpdate = { ...subIdentity.identity, contentmultimap: existingCmm };
          const sourceAddr = subIdentity.identity.primaryaddresses?.[0];
          const rpcParams = [identUpdate, false, false, 0.0001, sourceAddr || undefined];
          await callRpc('updateidentity', rpcParams);
        }
      }

      return {
        success: true,
        fundingTxid,
        dedicatedAddress: dedicated,
        startBlock: currentBlock + 5,
        intervalBlocks: plan.intervalBlocks,
        totalPeriods: plan.periods,
        paymentAmount: payment,
        currency: plan.currency || 'VRSC',
        transactions,
      };
    }

    case 'cancelSubscription': {
      if (!params?.provider) throw new Error('provider required');
      const subscriberId = params.subscriberId || connectedAddress;
      if (!subscriberId) throw new Error('No subscriber identity');

      // Read subscription from subscriber's contentmultimap
      const subIdentity = await callRpc('getidentity', [subscriberId]);
      if (!subIdentity?.identity) throw new Error('Subscriber identity not found');

      const existingCmm = subIdentity.identity.contentmultimap || {};
      const activeKey = 'iCvwWogVjiNCbiKVE38t88MEqFVFfDrjYY';
      const entries = existingCmm[activeKey] || [];
      if (entries.length === 0) throw new Error('No active subscription found');

      // Find this provider's subscription in the array
      let subscription: any = null;
      let matchIndex = -1;
      for (let i = 0; i < entries.length; i++) {
        try {
          const decoded = JSON.parse(hexToUtf8(entries[i]));
          if (decoded.providerId === params.provider) {
            subscription = decoded;
            matchIndex = i;
            break;
          }
        } catch {}
      }
      if (!subscription) throw new Error('No subscription found for this provider');

      // Sweep remaining UTXOs from dedicated address back to subscriber
      const dedicated = subscription.dedicatedAddress;
      const utxos = await callRpc('getaddressutxos', [{ addresses: [dedicated] }]);
      if (utxos && utxos.length > 0) {
        const totalSat = utxos.reduce((sum: number, u: any) => sum + u.satoshis, 0);
        const sweepAmount = (totalSat / 1e8) - 0.0001;
        if (sweepAmount > 0) {
          const sweepAddr = subIdentity.identity.primaryaddresses?.[0] || connectedAddress;
          const sweepOpid = await callRpc('sendcurrency', [dedicated, [{ address: sweepAddr, amount: sweepAmount }]]);
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const ops = await callRpc('z_getoperationresult', [[sweepOpid]]);
            if (ops?.length > 0) break;
          }
        }
      }

      // Remove only this provider's entry, keep other subscriptions
      const remaining = entries.filter((_: any, i: number) => i !== matchIndex);
      if (remaining.length > 0) {
        existingCmm[activeKey] = remaining;
      } else {
        delete existingCmm[activeKey];
      }
      const identUpdate = { ...subIdentity.identity, contentmultimap: existingCmm };
      const sourceAddr = subIdentity.identity.primaryaddresses?.[0];
      await callRpc('updateidentity', [identUpdate, false, false, 0.0001, sourceAddr || undefined]);

      return { success: true, swept: true };
    }

    case 'getAddressTxids': {
      const addr = params?.address || connectedAddress;
      if (!addr) throw new Error('No address');
      return callRpc('getaddresstxids', [{ addresses: [addr] }]);
    }

    case 'getRawTransaction': {
      if (!params?.txid) throw new Error('txid required');
      return callRpc('getrawtransaction', [params.txid, 1]);
    }

    case 'listTransactions': {
      const count = params?.count || 20;
      return callRpc('listtransactions', ['', count, 0]);
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// Deep link storage. tabId is captured at request time so the REDIRECT branch
// can navigate the originating tab back to the verus-connect web component
// with the signed response payload in the URL. `verified` tracks whether the
// relying-party signature has been cryptographically verified against the
// claimed signingIAddress — only true requests are surfaced to the user.
interface PendingDeeplink {
  uri: string;
  origin: string;
  parsed: ParsedLoginRequest;
  tabId: number | null;
  verified: boolean;
}
const pendingDeeplinks = new Map<string, PendingDeeplink>();
const deeplinkCallbacks = new Map<string, { resolve: (r: any) => void; reject: (e: string) => void }>();

async function verifyPendingDeeplinks() {
  for (const [id, dl] of Array.from(pendingDeeplinks.entries())) {
    if (dl.verified) continue;
    try {
      await verifyRequestSignature(dl.parsed, callRpc);
      dl.verified = true;
    } catch (e: any) {
      pendingDeeplinks.delete(id);
      const cb = deeplinkCallbacks.get(id);
      if (cb) { deeplinkCallbacks.delete(id); cb.reject('Login request: ' + e.message); }
    }
  }
}

// Subscription storage
const pendingSubscriptions = new Map<string, { provider: string; providerName: string; plan: any; terms: any; origin: string; subscriberId: string }>();
const subscriptionCallbacks = new Map<string, { resolve: (r: any) => void; reject: (e: string) => void }>();

// === Message Router ===

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PAGE_REQUEST') {
    handlePageRequest(message, sender, sendResponse);
    return true;
  }

  // All other message types must come from the extension popup (not content scripts in tabs)
  if (sender.tab || sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'Unauthorized' });
    return;
  }

  if (message.type === 'POPUP_RPC') {
    if (!isUnlocked) { sendResponse({ error: 'Wallet is locked' }); return; }
    resetLockTimer();
    handleMethod(message.method, message.params)
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'POPUP_APPROVE') {
    if (!isUnlocked) { sendResponse({ ok: false, error: 'Wallet is locked' }); return; }
    handlePopupApprove(message.id);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'POPUP_REJECT') {
    if (!isUnlocked) { sendResponse({ ok: false, error: 'Wallet is locked' }); return; }
    handlePopupReject(message.id, message.reason);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'GET_PENDING') {
    const pending = pendingApprovals.map(p => ({ id: p.id, method: p.method, params: p.params, origin: p.origin, context: p.context }));
    // Only surface deeplinks whose relying-party signature has been verified.
    // Unverified entries are still being checked or were just admitted under
    // a locked wallet; either way, the UI should never display an unverified
    // signing identity to the user as if it were trustworthy.
    const deeplinks = Array.from(pendingDeeplinks.entries())
      .filter(([, dl]) => dl.verified)
      .map(([id, dl]) => ({
        id, uri: dl.uri, origin: dl.origin,
        responseUri: dl.parsed.responseUri,
        uriType: dl.parsed.uriType,
        signingIAddress: dl.parsed.signingIAddress,
        systemId: dl.parsed.systemId,
      }));
    const subscriptions = Array.from(pendingSubscriptions.entries()).map(([id, sub]) => ({
      id, provider: sub.provider, providerName: sub.providerName,
      plan: sub.plan, origin: sub.origin, subscriberId: sub.subscriberId,
    }));
    sendResponse({ pending, deeplinks, subscriptions });
    return;
  }

  if (message.type === 'SUBSCRIPTION_APPROVE') {
    if (!isUnlocked) { sendResponse({ ok: false, error: 'Wallet is locked' }); return; }
    const { id, dedicatedAddress: dedAddr, from: msgFrom, subscriberId: msgSubId } = message;
    const sub = pendingSubscriptions.get(id);
    const cb = subscriptionCallbacks.get(id);
    if (sub && cb) {
      pendingSubscriptions.delete(id);
      subscriptionCallbacks.delete(id);
      // Wait for execution to complete before responding — keeps service worker alive
      handleMethod('executeSubscription', {
        provider: sub.provider,
        plan: sub.plan,
        from: msgFrom || connectedAddress,
        dedicatedAddress: dedAddr,
        subscriberId: msgSubId || sub.subscriberId,
      }).then(result => {
        cb.resolve(result);
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true, result });
      }).catch(err => {
        cb.reject(err.message);
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: false, error: err.message });
      });
    } else {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: false, error: 'No pending subscription' });
    }
    return true; // Keep channel open for async response
  }

  if (message.type === 'SUBSCRIPTION_REJECT') {
    const { id } = message;
    pendingSubscriptions.delete(id);
    const cb = subscriptionCallbacks.get(id);
    if (cb) { subscriptionCallbacks.delete(id); cb.reject('User rejected'); }
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'DEEPLINK_APPROVE') {
    if (!isUnlocked) { sendResponse({ ok: false, error: 'Wallet is locked' }); return; }
    const { id, identity } = message;
    const dl = pendingDeeplinks.get(id);
    const cb = deeplinkCallbacks.get(id);

    if (!dl || !cb) {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: false, error: 'No pending login request found' });
      return;
    }

    pendingDeeplinks.delete(id);
    deeplinkCallbacks.delete(id);
    const tabId = dl.tabId;

    (async () => {
      try {
        // Defense in depth: re-verify the relying-party signature right
        // before signing, in case verification state was tampered with.
        await verifyRequestSignature(dl.parsed, callRpc);
        const result = await signAndDeliverLogin(dl.parsed, identity, callRpc);
        if (result.kind === 'redirect' && tabId != null) {
          // Navigate the originating tab to the redirect URL (with the
          // base64url response payload appended). Same origin, so the page
          // session continues uninterrupted on the verus-connect side.
          try { await chrome.tabs.update(tabId, { url: result.redirectUrl }); } catch {}
        }
        cb.resolve({ success: true, identity: result.identity });
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
      } catch (err: any) {
        cb.reject(err.message);
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (message.type === 'DEEPLINK_REJECT') {
    const { id } = message;
    pendingDeeplinks.delete(id);
    const cb = deeplinkCallbacks.get(id);
    if (cb) { deeplinkCallbacks.delete(id); cb.reject('User rejected'); }
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'SET_ADDRESS') {
    connectedAddress = message.address;
    chrome.storage.local.set({ connectedAddress: message.address });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'SET_ACCOUNT_NAME') {
    const key = 'accountName:' + message.address;
    chrome.storage.local.set({ [key]: message.name });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'GET_ACCOUNT_NAME') {
    const key = 'accountName:' + message.address;
    chrome.storage.local.get([key], (data) => {
      sendResponse({ name: data[key] || '' });
    });
    return true;
  }

  if (message.type === 'ADD_PENDING_TX') {
    const key = 'pendingTxs:' + message.address;
    chrome.storage.local.get([key], (data) => {
      const existing = data[key] || [];
      existing.unshift(message.tx);
      chrome.storage.local.set({ [key]: existing.slice(0, 10) });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'GET_PENDING_TXS') {
    const key = 'pendingTxs:' + message.address;
    chrome.storage.local.get([key], (data) => {
      sendResponse({ txs: data[key] || [] });
    });
    return true;
  }

  if (message.type === 'CLEAR_CONFIRMED_PENDING') {
    const key = 'pendingTxs:' + message.address;
    chrome.storage.local.get([key], (data) => {
      const pending = (data[key] || []).filter((tx: any) => !message.confirmedTxids.includes(tx.txid));
      chrome.storage.local.set({ [key]: pending });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'GET_STATE') {
    migrateLegacyRpcConfig()
      .catch(() => {})
      .then(() => chrome.storage.local.get(['passwordHash', 'chains', 'activeChain']))
      .then((data) => {
        const chains: ChainsMap = data.chains || {};
        const activeKey: string | undefined = data.activeChain;
        const active = activeKey ? chains[activeKey] : undefined;
        sendResponse({
          connectedAddress,
          isUnlocked,
          hasPassword: !!data.passwordHash,
          hasRpcConfig: !!(active && active.user && active.password),
          activeChain: activeKey || null,
          chainKeys: Object.keys(chains),
          lockTimeout: lockTimeoutMs,
        });
      });
    return true;
  }

  if (message.type === 'GET_CHAINS') {
    migrateLegacyRpcConfig()
      .catch(() => {})
      .then(() => chrome.storage.local.get(['chains', 'activeChain']))
      .then((data) => {
        sendResponse({
          chains: data.chains || {},
          activeChain: data.activeChain || null,
        });
      });
    return true;
  }

  if (message.type === 'SAVE_CHAIN') {
    // Upserts a chain entry and (optionally) makes it active.
    const key: string = (message.key || '').trim();
    if (!key) { sendResponse({ ok: false, error: 'Missing chain key' }); return; }
    chrome.storage.local.get(['chains', 'activeChain'], (data) => {
      const chains: ChainsMap = data.chains || {};
      chains[key] = {
        name: message.name || key,
        host: message.host || '127.0.0.1',
        port: message.port || '27486',
        user: message.user || '',
        password: message.password || '',
      };
      const updates: Record<string, unknown> = { chains };
      if (message.activate || !data.activeChain) updates.activeChain = key;
      chrome.storage.local.set(updates, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (message.type === 'PROBE_CHAIN') {
    // Best-effort liveness check: fetch the RPC port unauthenticated.
    // A live daemon answers with 401 (auth required). A dead/missing one
    // fails with a network error. We don't care about the body.
    const host: string = message.host || '127.0.0.1';
    const port: string = message.port || '';
    if (!port) { sendResponse({ alive: false }); return; }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    fetch(`http://${host}:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'getinfo', params: [] }),
      signal: controller.signal,
    })
      .then((res) => { clearTimeout(t); sendResponse({ alive: res.status === 401 || res.ok }); })
      .catch(() => { clearTimeout(t); sendResponse({ alive: false }); });
    return true;
  }

  if (message.type === 'SET_ACTIVE_CHAIN') {
    const key: string = (message.key || '').trim();
    if (!key) { sendResponse({ ok: false, error: 'Missing chain key' }); return; }
    chrome.storage.local.get(['chains'], (data) => {
      const chains: ChainsMap = data.chains || {};
      if (!chains[key]) { sendResponse({ ok: false, error: 'Unknown chain' }); return; }
      chrome.storage.local.set({ activeChain: key }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (message.type === 'DELETE_CHAIN') {
    const key: string = (message.key || '').trim();
    if (!key) { sendResponse({ ok: false, error: 'Missing chain key' }); return; }
    chrome.storage.local.get(['chains', 'activeChain'], (data) => {
      const chains: ChainsMap = data.chains || {};
      delete chains[key];
      const updates: Record<string, unknown> = { chains };
      if (data.activeChain === key) {
        const remaining = Object.keys(chains);
        updates.activeChain = remaining[0] || null;
      }
      chrome.storage.local.set(updates, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // Legacy single-chain setup shim — kept so SetupScreen.tsx can call its
  // existing message without changing its UX. Writes into the chains map
  // under the provided key (or "VRSC" by default) and activates it.
  if (message.type === 'SAVE_RPC_CONFIG') {
    const key: string = (message.key || 'VRSC').trim();
    chrome.storage.local.get(['chains'], (data) => {
      const chains: ChainsMap = data.chains || {};
      chains[key] = {
        name: message.name || key,
        host: message.host || '127.0.0.1',
        port: message.port || '27486',
        user: message.user || '',
        password: message.password || '',
      };
      chrome.storage.local.set({ chains, activeChain: key }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (message.type === 'UNLOCK') {
    verifyPassword(message.password).then((ok) => {
      if (ok) {
        isUnlocked = true;
        resetLockTimer();
        // Any deeplinks queued while locked still need their signature
        // verified before the user can be shown the claimed identity.
        // Fire-and-forget — UI polls GET_PENDING which only returns verified.
        verifyPendingDeeplinks().catch(() => {});
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Wrong password' });
      }
    });
    return true;
  }

  if (message.type === 'VERIFY_PASSWORD') {
    verifyPassword(message.password).then((ok) => {
      sendResponse({ ok });
    });
    return true;
  }

  if (message.type === 'SET_LOCK_TIMEOUT') {
    lockTimeoutMs = message.timeout;
    chrome.storage.local.set({ lockTimeout: message.timeout });
    if (isUnlocked) resetLockTimer();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'LOCK') {
    isUnlocked = false;
    if (lockTimer) clearTimeout(lockTimer);
    broadcastLock();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'SET_PASSWORD') {
    setPassword(message.password).then(() => {
      isUnlocked = true;
      resetLockTimer();
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function handlePageRequest(
  message: { id: number; method: string; params: any; origin: string },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void
) {
  const { method, params } = message;

  // Deep link login — handle before the allowlist check
  if (method === 'handleDeeplink') {

    // Parse and store the deep link regardless of lock state.
    // The page's promise stays pending until user approves/rejects.
    let parsed: ParsedLoginRequest;
    try {
      parsed = parseDeeplink(params?.uri);
    } catch (e: any) {
      sendResponse({ error: 'Invalid login request: ' + e.message });
      return;
    }

    // Cryptographically verify the relying party's signature against the
    // claimed signingIAddress BEFORE storing — otherwise a malicious page
    // could put any identity it likes in the approval UI ("Challenge signed
    // by coinbase@") with a garbage signature. Needs the daemon, so when
    // the wallet is locked we store as unverified and run the check at
    // unlock time (see UNLOCK handler).
    let verifiedNow = false;
    if (isUnlocked) {
      try {
        await verifyRequestSignature(parsed, callRpc);
        verifiedNow = true;
      } catch (e: any) {
        sendResponse({ error: 'Login request: ' + e.message });
        return;
      }
    }

    const id = crypto.randomUUID();
    pendingDeeplinks.set(id, {
      uri: params.uri,
      origin: message.origin || '',
      parsed,
      tabId: sender.tab?.id ?? null,
      verified: verifiedNow,
    });

    // Set up callback so page promise resolves when user approves
    const deeplinkPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingDeeplinks.delete(id);
        deeplinkCallbacks.delete(id);
        reject(new Error('Login request timed out'));
      }, 300_000);
      deeplinkCallbacks.set(id, {
        resolve: (result: any) => { clearTimeout(timeout); resolve(result); },
        reject: (error: string) => { clearTimeout(timeout); reject(new Error(error)); },
      });
    });

    // Alert user
    chrome.action.setBadgeText({ text: '1' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.windowId && chrome.sidePanel) await (chrome.sidePanel as any).open({ windowId: tab.windowId }); } catch {
      try {
        chrome.notifications.create('verus-login-' + id, {
          type: 'basic', iconUrl: 'images/icon-128.png',
          title: 'Verus Login Request',
          message: isUnlocked
            ? 'Click the Verus Wallet icon to approve a login request.'
            : 'Click the Verus Wallet icon to unlock and approve a login request.',
        });
      } catch {}
    }

    // Wait for user approval/rejection — sendResponse only when done
    try {
      const result = await deeplinkPromise;

      sendResponse({ result });
    } catch (err: any) {

      sendResponse({ error: err.message || 'Internal error' });
    }
    return;
  }

  // Subscription request — handle before the allowlist check (like deeplinks)
  if (method === 'subscribe') {
    if (!isUnlocked) {
      sendResponse({ error: 'Wallet is locked. Open the extension and unlock.' });
      return;
    }
    try {
      const result = await handleMethod('subscribe', { ...params, origin: message.origin });
      sendResponse({ result });
    } catch (err: any) {
      sendResponse({ error: err.message || 'Subscription failed' });
    }
    return;
  }

  // Reject unknown methods
  if (!READ_ONLY.has(method) && !APPROVAL_REQUIRED.has(method)) {
    sendResponse({ error: `Unknown method: ${method}` });
    return;
  }

  // All methods from web pages require unlock
  if (!isUnlocked) {
    sendResponse({ error: 'Wallet is locked. Open the extension and enter your password.' });
    return;
  }

  try {
    resetLockTimer();
    if (APPROVAL_REQUIRED.has(method)) {
      const result = await requestApproval(message.id, method, params, message.origin);
      sendResponse({ result });
    } else {
      const result = await handleMethod(method, params);
      sendResponse({ result });
    }
  } catch (err: any) {
    sendResponse({ error: err.message || 'Internal error' });
  }
}

async function buildApprovalContext(method: string, params: any): Promise<any> {
  // Pre-fetch on-chain state the approval UI needs to render a meaningful
  // diff. Without this, the user is approving an opaque params object.
  if (method === 'updateIdentity' && params?.identity) {
    const targetName = params.identity.name && params.identity.parent
      ? `${params.identity.name}@`
      : params.identity.identityaddress;
    if (!targetName) return null;
    try {
      const current = await callRpc('getidentity', [targetName]);
      return { currentIdentity: current?.identity || null };
    } catch {
      return { currentIdentity: null, contextError: 'Could not load current identity for diff' };
    }
  }
  return null;
}

function requestApproval(_pageId: number, method: string, params: any, origin: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const approval: PendingApproval = { id, method, params, origin, resolve, reject: (e) => reject(new Error(e)) };
    pendingApprovals.push(approval);
    // Build context asynchronously; UI polls GET_PENDING so it will pick it
    // up on a later tick if it's not ready immediately. We never block the
    // approval queue on context being available.
    buildApprovalContext(method, params).then((ctx) => {
      if (ctx) approval.context = ctx;
    }).catch(() => {});
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => { if (tab?.windowId && chrome.sidePanel) (chrome.sidePanel as any).open({ windowId: tab.windowId }); }).catch(() => {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'images/icon-128.png',
        title: 'Verus Wallet',
        message: `${origin} wants to ${method}. Click the extension icon to approve.`,
      });
    });
  });
}

async function handlePopupApprove(id: string) {
  const idx = pendingApprovals.findIndex(p => p.id === id);
  if (idx === -1) return;
  const approval = pendingApprovals.splice(idx, 1)[0];
  try {
    const result = await handleMethod(approval.method, approval.params);
    approval.resolve(result);
  } catch (err: any) {
    approval.reject(err.message || 'Failed to execute');
  }
}

function handlePopupReject(id: string, reason?: string) {
  const idx = pendingApprovals.findIndex(p => p.id === id);
  if (idx === -1) return;
  pendingApprovals.splice(idx, 1)[0].reject(reason || 'User rejected');
}
