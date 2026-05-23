/**
 * Service worker — the brain of the extension.
 * Makes JSON-RPC calls directly to the local Verus daemon.
 * No native messaging, no external servers.
 */

import { parseDeeplink, signAndDeliverLogin, verifyRequestSignature } from './login-handler';
import type { ParsedLoginRequest } from './login-handler';
import { nativeFor } from '../data/chains';

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
  // Snapshot of the active chain at the moment the page request arrived.
  // Both the daemon target (via callRpc) and the fallback address (via
  // getActiveSelectedAddress) resolve dynamically from current chain state,
  // so without this binding a user who switches chains between the request
  // and the approval could sign a tx against the wrong daemon. Validated in
  // POPUP_APPROVE before execution.
  chainKey: string | null;
  // Optional pre-fetched context the popup approval UI can render. Currently
  // used for updateIdentity to diff the requested change against the current
  // on-chain state.
  context?: any;
  resolve: (result: any) => void;
  reject: (error: string) => void;
}

let pendingApprovals: PendingApproval[] = [];
// Per-chain selected address. The previously-single connectedAddress has been
// fanned out by chain key because R-addresses are wallet-local per daemon
// and i-addresses can exist on multiple chains as separate ledger states.
let selectedAddressByChain: Record<string, string | null> = {};
let isUnlocked = false;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let lockTimeoutMs = 5 * 60 * 1000; // Default: 5 minutes

async function getActiveChainKey(): Promise<string | null> {
  const data = await chrome.storage.local.get(['activeChain']);
  return data.activeChain || null;
}

async function getActiveNativeName(): Promise<string> {
  const key = await getActiveChainKey();
  return nativeFor(key).name;
}

// Cross-chain identity registry. Every time `listidentities` runs against
// any active daemon, we snapshot the i-addresses we see into this global
// map so the UI can offer "you own these IDs on other chains" hints.
// firstSeenChain is informational; the canonical source of truth for
// presence is always `getidentity` on the chain in question.
interface KnownIdentity {
  iAddress: string;
  friendlyName: string;
  primaryAddress: string;
  firstSeenChain: string;
  lastSeenAt: number;
}

// Per-chain currency catalog. Replaces the static VRSC-only currency-map.json
// for screens that need to know what currencies / baskets are available on
// the active daemon. Each chain has its own set of reserves + baskets, so
// shipping a single static catalog would mislead users on PBaaS children.
interface CurrencyCatalog {
  currencies: Record<string, string>;                        // iaddr -> friendly name
  baskets: Record<string, { id: string; reserves: string[] }>; // name -> {iaddr, reserve names}
  fetchedAt: number;
}

const CURRENCY_CACHE_TTL_MS = 30 * 60 * 1000;

// Verus consensus flag: a currency with the FRACTIONAL bit set + non-empty
// `currencies` array is a basket that can be swapped into. Empty-reserve
// fractional entries are excluded (they're not liquidity baskets).
const FRACTIONAL_FLAG = 32;

function normalizeListCurrencies(list: any): { currencies: Record<string, string>; baskets: Record<string, { id: string; reserves: string[] }> } {
  const currencies: Record<string, string> = {};
  const baskets: Record<string, { id: string; reserves: string[] }> = {};
  if (!Array.isArray(list)) return { currencies, baskets };
  // First pass: collect iaddr -> name so basket reserves can be name-mapped.
  for (const entry of list) {
    const cd = entry?.currencydefinition || {};
    const name = cd.name;
    const iaddr = cd.currencyid;
    if (typeof name === 'string' && typeof iaddr === 'string') {
      currencies[iaddr] = name;
    }
  }
  // Second pass: identify baskets and resolve their reserve iaddrs to names.
  for (const entry of list) {
    const cd = entry?.currencydefinition || {};
    const name = cd.name;
    const iaddr = cd.currencyid;
    const options = Number(cd.options) || 0;
    const reserves: string[] = Array.isArray(cd.currencies) ? cd.currencies : [];
    if (typeof name !== 'string' || typeof iaddr !== 'string') continue;
    if ((options & FRACTIONAL_FLAG) === 0) continue;
    if (reserves.length === 0) continue;
    baskets[name] = {
      id: iaddr,
      reserves: reserves.map((r) => currencies[r] || r),
    };
  }
  return { currencies, baskets };
}

async function getCurrencyCatalog(chainKey: string, forceRefresh: boolean): Promise<CurrencyCatalog> {
  const data = await chrome.storage.local.get(['chains']);
  const chains: ChainsMap = data.chains || {};
  const entry: any = chains[chainKey];
  if (!entry) throw new Error(`Chain ${chainKey} is not configured`);
  const cached: CurrencyCatalog | undefined = entry.currencyCache;
  const now = Date.now();
  if (!forceRefresh && cached && (now - (cached.fetchedAt || 0)) < CURRENCY_CACHE_TTL_MS) {
    return cached;
  }
  // Issue the listcurrencies call against the requested chain — could be the
  // active chain or another configured chain (used by Settings refresh).
  const list = await callRpcOn(chainKey, 'listcurrencies', []);
  const norm = normalizeListCurrencies(list);
  const fresh: CurrencyCatalog = { ...norm, fetchedAt: now };
  // Re-read chains right before writing so a SAVE_CHAIN / DELETE_CHAIN /
  // SAVE_RPC_CONFIG that landed during the RPC await window isn't reverted
  // by our stale snapshot. If the chain was deleted while we were fetching,
  // bail without writing the cache.
  const fresh2 = await chrome.storage.local.get(['chains']);
  const liveChains: ChainsMap = fresh2.chains || {};
  const liveEntry: any = liveChains[chainKey];
  if (!liveEntry) return fresh;
  liveChains[chainKey] = { ...liveEntry, currencyCache: fresh };
  await chrome.storage.local.set({ chains: liveChains });
  return fresh;
}

async function upsertKnownIdentities(list: any): Promise<void> {
  if (!Array.isArray(list) || list.length === 0) return;
  const chainKey = await getActiveChainKey();
  if (!chainKey) return;
  const { knownIdentities } = await chrome.storage.local.get(['knownIdentities']);
  const map: Record<string, KnownIdentity> = knownIdentities || {};
  const now = Date.now();
  let changed = false;
  for (const idObj of list) {
    const ident = idObj?.identity || idObj;
    const iAddr = ident?.identityaddress;
    if (!iAddr || typeof iAddr !== 'string') continue;
    if (typeof ident?.name === 'string' && ident.name.startsWith('3965555_')) continue;
    const friendlyName = (idObj?.friendlyname || idObj?.fullyqualifiedname || (ident.name ? ident.name + '@' : iAddr));
    const primaryAddress = (Array.isArray(ident.primaryaddresses) && ident.primaryaddresses[0]) || '';
    const prev = map[iAddr];
    if (!prev || prev.friendlyName !== friendlyName || prev.primaryAddress !== primaryAddress) {
      map[iAddr] = {
        iAddress: iAddr,
        friendlyName,
        primaryAddress,
        firstSeenChain: prev?.firstSeenChain || chainKey,
        lastSeenAt: now,
      };
      changed = true;
    } else if (now - prev.lastSeenAt > 60_000) {
      // Touch the timestamp at most once per minute so we don't burn storage
      // writes on every list call.
      map[iAddr] = { ...prev, lastSeenAt: now };
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ knownIdentities: map });
}

async function getActiveSelectedAddress(): Promise<string | null> {
  const key = await getActiveChainKey();
  if (!key) return null;
  if (selectedAddressByChain[key] !== undefined) return selectedAddressByChain[key];
  const data = await chrome.storage.local.get([`selectedAddress:${key}`]);
  const addr = data[`selectedAddress:${key}`] || null;
  selectedAddressByChain[key] = addr;
  return addr;
}

function getActiveChainMeta(activeKey: string | null): { nativeName: string | null; nativeIAddress: string | null; systemId: string | null } {
  const meta = nativeFor(activeKey);
  return { nativeName: meta.name, nativeIAddress: meta.iaddress, systemId: meta.systemId };
}

// Load saved lock timeout
chrome.storage.local.get(['lockTimeout'], (data) => {
  if (data.lockTimeout) lockTimeoutMs = data.lockTimeout;
});

// Open side panel when clicking the extension icon (like MetaMask)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Cross-chain export arrivals: alarm fires every 30s while there are pending
// exports. For each one, we call getidentity on the DESTINATION chain (not
// the active chain). On a successful resolve we emit EXPORT_RESOLVED so the
// popup can toast the user, and drop the entry. Alarm survives SW kill;
// EXPORT_ID re-arms it on each new export.
async function pollPendingExports(): Promise<void> {
  const data = await chrome.storage.local.get(['pendingExports']);
  const map: Record<string, any> = data.pendingExports || {};
  const keys = Object.keys(map);
  if (keys.length === 0) {
    // No work left — cancel the alarm to stop the periodic wakeups.
    try { await chrome.alarms.clear('exportArrivalPoll'); } catch {}
    return;
  }
  let changed = false;
  for (const k of keys) {
    const entry = map[k];
    try {
      const resp = await callRpcOn(entry.destChainKey, 'getidentity', [entry.iAddress]);
      if (resp?.identity?.identityaddress === entry.iAddress) {
        // Arrived. Broadcast for the popup and clear the entry.
        chrome.runtime.sendMessage({
          type: 'EXPORT_RESOLVED',
          friendlyName: entry.friendlyName,
          iAddress: entry.iAddress,
          destChainKey: entry.destChainKey,
        }).catch(() => {});
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'images/icon-128.png',
            title: 'VerusID export complete',
            message: `${entry.friendlyName} is now active on ${entry.destChainKey}.`,
          });
        } catch {}
        delete map[k];
        changed = true;
      }
    } catch {
      // Destination daemon unreachable or identity not yet found — leave
      // the entry in place for the next tick.
    }
  }
  if (changed) await chrome.storage.local.set({ pendingExports: map });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'exportArrivalPoll') pollPendingExports().catch(() => {});
});

// On SW boot, if there are leftover pending exports from a prior session,
// re-arm the alarm so polling resumes without the user re-triggering anything.
chrome.storage.local.get(['pendingExports'], (data) => {
  const map = data.pendingExports || {};
  if (Object.keys(map).length > 0) {
    chrome.alarms.create('exportArrivalPoll', { periodInMinutes: 0.5 }).catch(() => {});
  }
});

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

// Migration v2: address-keyed storage gets chain-prefixed. Pre-PR users had
// only one chain so we attribute everything to whatever activeChain is.
// Idempotent via the `storageVersion` sentinel.
async function migrateAddressKeysV2(): Promise<void> {
  const sentinel = await chrome.storage.local.get(['storageVersion']);
  if ((sentinel.storageVersion || 0) >= 2) return;
  const { activeChain } = await chrome.storage.local.get(['activeChain']);
  if (!activeChain) {
    // No chain set up yet — nothing to migrate; just bump the sentinel so we
    // don't keep checking.
    await chrome.storage.local.set({ storageVersion: 2 });
    return;
  }
  const all = await chrome.storage.local.get(null);
  const updates: Record<string, unknown> = { storageVersion: 2 };
  const deletes: string[] = [];
  for (const k of Object.keys(all)) {
    if (k === 'connectedAddress') {
      updates[`selectedAddress:${activeChain}`] = all[k];
      deletes.push(k);
    } else if (k.startsWith('accountName:') && !k.startsWith(`accountName:${activeChain}:`)) {
      // Rewrite `accountName:<addr>` → `accountName:<chainKey>:<addr>`.
      // Skip keys that already look chain-prefixed in case a re-run hits a
      // partial migration.
      const rest = k.slice('accountName:'.length);
      if (!rest.includes(':')) {
        updates[`accountName:${activeChain}:${rest}`] = all[k];
        deletes.push(k);
      }
    } else if (k.startsWith('pendingTxs:') && !k.startsWith(`pendingTxs:${activeChain}:`)) {
      const rest = k.slice('pendingTxs:'.length);
      if (!rest.includes(':')) {
        updates[`pendingTxs:${activeChain}:${rest}`] = all[k];
        deletes.push(k);
      }
    } else if (k === 'pinnedAddresses') {
      updates[`pinnedAddresses:${activeChain}`] = all[k];
      deletes.push(k);
    }
  }
  await chrome.storage.local.set(updates);
  if (deletes.length) await chrome.storage.local.remove(deletes);
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

// Issue an RPC call against a specific chain (not the active one). Used by
// cross-chain flows — most notably the export-arrival poller, which needs to
// hit the destination chain's daemon while the user remains on the source
// chain. Reads creds from chains[chainKey].
async function callRpcOn(chainKey: string, method: string, params: any[] = []): Promise<any> {
  const data = await chrome.storage.local.get(['chains']);
  const chains: ChainsMap = data.chains || {};
  const chain = chains[chainKey];
  if (!chain || !chain.user || !chain.password) {
    throw new Error(`Chain ${chainKey} is not configured.`);
  }
  const body = JSON.stringify({ jsonrpc: '1.0', id: Date.now(), method, params });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + btoa(`${chain.user}:${chain.password}`),
  };
  const response = await fetch(`http://${chain.host || '127.0.0.1'}:${chain.port || '27486'}`, {
    method: 'POST', headers, body,
  });
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
      const addr = params?.address || (await getActiveSelectedAddress());
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
      const addr = params?.address || (await getActiveSelectedAddress());
      if (!addr) throw new Error('No address');
      return callRpc('getaddressutxos', [{ addresses: [addr] }]);
    }

    case 'sendCurrency': {
      const fallbackFrom = await getActiveSelectedAddress();
      if (!params?.from && !fallbackFrom) throw new Error('No from address');
      const fromAddr = params.from || fallbackFrom;

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
      const identity = params.identity || (await getActiveSelectedAddress());
      if (!identity) throw new Error('No identity');
      return callRpc('signmessage', [identity, params.message]);
    }

    case 'newAddress':
      return callRpc('getnewaddress');

    case 'listIdentities': {
      const list = await callRpc('listidentities');
      // Snapshot every identity we see on any chain into a global
      // knownIdentities map. The IDsScreen footer ("N other IDs not on this
      // chain") subtracts the active-daemon list from this set to find IDs
      // owned but not yet exported to the current chain. Fire-and-forget;
      // never block the RPC response on the storage write.
      upsertKnownIdentities(list).catch(() => {});
      return list;
    }

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
      const fromAddr = params.from || (await getActiveSelectedAddress());
      if (!fromAddr) throw new Error('No source address');

      // 2. Use pre-generated address or create new one
      const dedicated = params.dedicatedAddress || await callRpc('getnewaddress', []);

      // 3. Fund with N UTXOs
      // For non-native: interleave currency + native fee outputs (currency at
      // even vouts, native at odd). "Native" means the active chain's own
      // currency — VRSC on VRSC, vARRR on vARRR, etc.
      const nativeName = await getActiveNativeName();
      const planCurr = plan.currency || nativeName;
      const fundOutputs: any[] = [];
      for (let i = 0; i < plan.periods; i++) {
        if (planCurr === nativeName) {
          fundOutputs.push({ address: dedicated, amount: plan.amount });
        } else {
          fundOutputs.push({ address: dedicated, amount: plan.amount, currency: planCurr });
          fundOutputs.push({ address: dedicated, amount: 0.0001 }); // native fee for this period's broadcast
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

      // 4. For non-native currencies, must wait for confirmation before signing
      // (native UTXOs can be signed unconfirmed; reserve currency UTXOs cannot)
      if (planCurr !== nativeName) {
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
      const planCurrency = plan.currency || nativeName;
      // For native: deduct fee from payment. Otherwise: fee paid separately in native.
      const payment = planCurrency === nativeName ? plan.amount - 0.0001 : plan.amount;

      // For non-native currencies, resolve the currency name to i-address
      let currencyId = '';
      if (planCurrency !== nativeName) {
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

        if (planCurrency === nativeName) {
          inputs = [{ txid: fundingTxid, vout: i }];
          output = { [payAddr]: payment };
        } else {
          // Non-native: currency at vout i*2, native fee at vout i*2+1
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
      const subscriberId = params.subscriberId || (await getActiveSelectedAddress());
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
        currency: plan.currency || nativeName,
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
        currency: plan.currency || nativeName,
        transactions,
      };
    }

    case 'cancelSubscription': {
      if (!params?.provider) throw new Error('provider required');
      const subscriberFallback = await getActiveSelectedAddress();
      const subscriberId = params.subscriberId || subscriberFallback;
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
          const sweepAddr = subIdentity.identity.primaryaddresses?.[0] || subscriberFallback;
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
      const addr = params?.address || (await getActiveSelectedAddress());
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
    const pending = pendingApprovals.map(p => ({ id: p.id, method: p.method, params: p.params, origin: p.origin, context: p.context, chainKey: p.chainKey }));
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
      getActiveSelectedAddress().then((fallback) => handleMethod('executeSubscription', {
        provider: sub.provider,
        plan: sub.plan,
        from: msgFrom || fallback,
        dedicatedAddress: dedAddr,
        subscriberId: msgSubId || sub.subscriberId,
      })).then(result => {
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
        // Defense in depth #1: enforce the chain match in the SW too, not
        // just the popup's disabled button. A deeplink envelope is signed
        // for a specific systemId; if the user has since switched chains,
        // signAndDeliverLogin would otherwise dispatch signdata to the
        // wrong daemon. We fail closed even for unknown active chains —
        // if we can't resolve activeSystemId, we refuse rather than guess.
        const linkSystemId: string | null = (dl.parsed as any)?.systemId || null;
        if (linkSystemId) {
          const activeKey = await getActiveChainKey();
          const active = nativeFor(activeKey);
          if (!active.systemId || active.systemId !== linkSystemId) {
            throw new Error('Login request is for a different chain than the wallet is currently connected to. Switch chains and re-issue the request.');
          }
        }
        // Defense in depth #2: re-verify the relying-party signature right
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
    // Address selection is per-chain. The caller may pass chainKey explicitly
    // (race-safe against a concurrent chain switch); otherwise we use the
    // currently active chain.
    (async () => {
      const chainKey: string | null = message.chainKey || (await getActiveChainKey());
      if (!chainKey) { sendResponse({ ok: false, error: 'No active chain' }); return; }
      selectedAddressByChain[chainKey] = message.address || null;
      await chrome.storage.local.set({ [`selectedAddress:${chainKey}`]: message.address || null });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'SET_ACCOUNT_NAME') {
    (async () => {
      const chainKey: string | null = message.chainKey || (await getActiveChainKey());
      if (!chainKey) { sendResponse({ ok: false, error: 'No active chain' }); return; }
      const key = `accountName:${chainKey}:${message.address}`;
      await chrome.storage.local.set({ [key]: message.name });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_ACCOUNT_NAME') {
    (async () => {
      const chainKey: string | null = message.chainKey || (await getActiveChainKey());
      if (!chainKey) { sendResponse({ name: '' }); return; }
      const key = `accountName:${chainKey}:${message.address}`;
      const data = await chrome.storage.local.get([key]);
      sendResponse({ name: data[key] || '' });
    })();
    return true;
  }

  if (message.type === 'ADD_PENDING_TX') {
    (async () => {
      const chainKey: string | null = message.chainKey || (await getActiveChainKey());
      if (!chainKey) { sendResponse({ ok: false, error: 'No active chain' }); return; }
      const key = `pendingTxs:${chainKey}:${message.address}`;
      const data = await chrome.storage.local.get([key]);
      const existing = data[key] || [];
      existing.unshift(message.tx);
      await chrome.storage.local.set({ [key]: existing.slice(0, 10) });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_PENDING_TXS') {
    (async () => {
      const chainKey: string | null = message.chainKey || (await getActiveChainKey());
      if (!chainKey) { sendResponse({ txs: [] }); return; }
      const key = `pendingTxs:${chainKey}:${message.address}`;
      const data = await chrome.storage.local.get([key]);
      sendResponse({ txs: data[key] || [] });
    })();
    return true;
  }

  if (message.type === 'CLEAR_CONFIRMED_PENDING') {
    (async () => {
      const chainKey: string | null = message.chainKey || (await getActiveChainKey());
      if (!chainKey) { sendResponse({ ok: false, error: 'No active chain' }); return; }
      const key = `pendingTxs:${chainKey}:${message.address}`;
      const data = await chrome.storage.local.get([key]);
      const pending = (data[key] || []).filter((tx: any) => !message.confirmedTxids.includes(tx.txid));
      await chrome.storage.local.set({ [key]: pending });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_STATE') {
    migrateLegacyRpcConfig()
      .catch(() => {})
      .then(() => migrateAddressKeysV2().catch(() => {}))
      .then(() => chrome.storage.local.get(['passwordHash', 'chains', 'activeChain']))
      .then(async (data) => {
        const chains: ChainsMap = data.chains || {};
        const activeKey: string | undefined = data.activeChain;
        const active = activeKey ? chains[activeKey] : undefined;
        // Read the selected address for the active chain (fall back to a fresh
        // storage read if the in-memory cache is empty for this key — happens
        // on SW restart before any popup interaction).
        let selectedAddress: string | null = null;
        if (activeKey) {
          if (selectedAddressByChain[activeKey] !== undefined) {
            selectedAddress = selectedAddressByChain[activeKey];
          } else {
            const sa = await chrome.storage.local.get([`selectedAddress:${activeKey}`]);
            selectedAddress = sa[`selectedAddress:${activeKey}`] || null;
            selectedAddressByChain[activeKey] = selectedAddress;
          }
        }
        sendResponse({
          connectedAddress: selectedAddress,
          isUnlocked,
          hasPassword: !!data.passwordHash,
          hasRpcConfig: !!(active && active.user && active.password),
          activeChain: activeKey || null,
          activeChainMeta: getActiveChainMeta(activeKey || null),
          chainKeys: Object.keys(chains),
          lockTimeout: lockTimeoutMs,
        });
      });
    return true;
  }

  if (message.type === 'EXPORT_ID') {
    // Cross-chain VerusID export. The active chain is the source; the
    // destination chain key comes from the popup. The Verus consensus
    // rule is "only the controller of <id>@ may export it" — and the
    // controller check passes only when the spent UTXO is at the
    // identity's own i-address, NOT at a wallet R-address that holds the
    // primary key. So we precheck for an i-addr UTXO before issuing the
    // sendcurrency.
    if (!isUnlocked) { sendResponse({ ok: false, error: 'Wallet is locked' }); return; }
    const { friendlyName, iAddress, destChainKey, password } = message;
    if (!friendlyName || !iAddress || !destChainKey) {
      sendResponse({ ok: false, error: 'friendlyName, iAddress, destChainKey required' });
      return;
    }
    (async () => {
      try {
        const pwOk = await verifyPassword(password || '');
        if (!pwOk) { sendResponse({ ok: false, error: 'Wrong password' }); return; }
        const sourceChainKey = await getActiveChainKey();
        if (!sourceChainKey) throw new Error('No active chain');
        if (sourceChainKey === destChainKey) throw new Error('Source and destination chains are the same');
        const data = await chrome.storage.local.get(['chains']);
        const chains: ChainsMap = data.chains || {};
        if (!chains[destChainKey]) throw new Error(`Destination chain ${destChainKey} is not configured`);
        // Precheck the i-addr UTXO. The export fee is paid from a UTXO sitting
        // at the identity's i-address itself; without one the daemon rejects
        // with a misleading "shielding requirements" error.
        const utxos = await callRpc('getaddressutxos', [{ addresses: [iAddress] }]);
        if (!Array.isArray(utxos) || utxos.length === 0) {
          throw new Error(`${friendlyName} has no UTXO at its i-address. Send a small amount to ${friendlyName} on the source chain first (one block), then retry.`);
        }
        // Issue the export. EXACT syntax: amount: 0 (integer), exportid: true,
        // NO currency / convertto / via. See feedback_exportid_syntax.md.
        const output = {
          address: friendlyName,
          exportto: destChainKey,
          exportid: true,
          amount: 0,
        };
        const opid = await callRpc('sendcurrency', [friendlyName, [output]]);
        // Poll for the source-chain txid.
        let txid: string | null = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const ops = await callRpc('z_getoperationresult', [[opid]]);
          if (Array.isArray(ops) && ops.length > 0) {
            if (ops[0].status === 'success') { txid = ops[0].result?.txid || null; break; }
            if (ops[0].status === 'failed') throw new Error(ops[0].error?.message || 'Export failed');
          }
        }
        // Record the pending export so the alarm-driven poller can detect
        // arrival on the destination chain. Keyed by (destChainKey, iAddress)
        // so the same ID can't have two pending exports to the same chain.
        const { pendingExports } = await chrome.storage.local.get(['pendingExports']);
        const map: Record<string, any> = pendingExports || {};
        map[`${destChainKey}:${iAddress}`] = {
          iAddress,
          friendlyName,
          sourceChainKey,
          destChainKey,
          sourceTxid: txid,
          broadcastTime: Date.now(),
        };
        await chrome.storage.local.set({ pendingExports: map });
        // Make sure the poller alarm exists.
        try { await chrome.alarms.create('exportArrivalPoll', { periodInMinutes: 0.5 }); } catch {}
        sendResponse({ ok: true, txid, opid });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'GET_PENDING_EXPORTS') {
    chrome.storage.local.get(['pendingExports'], (data) => {
      sendResponse({ exports: data.pendingExports || {} });
    });
    return true;
  }

  if (message.type === 'LIST_CURRENCIES') {
    // Per-chain currency catalog. Cached into chains[key].currencyCache
    // with a 30-minute TTL; consumers (SwapScreen) call this on mount and
    // either get a cached snapshot or trigger a fresh listcurrencies fetch
    // + normalize step. Forced refresh goes through REFRESH_CURRENCY_CACHE.
    (async () => {
      try {
        const chainKey: string | null = message.chainKey || (await getActiveChainKey());
        if (!chainKey) { sendResponse({ ok: false, error: 'No active chain' }); return; }
        const result = await getCurrencyCatalog(chainKey, false);
        sendResponse({ ok: true, chainKey, ...result });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'REFRESH_CURRENCY_CACHE') {
    (async () => {
      try {
        const chainKey: string | null = message.chainKey || (await getActiveChainKey());
        if (!chainKey) { sendResponse({ ok: false, error: 'No active chain' }); return; }
        const result = await getCurrencyCatalog(chainKey, true);
        sendResponse({ ok: true, chainKey, ...result });
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'LIST_KNOWN_IDS') {
    // Returns the union of i-addresses the wallet has seen across any
    // chain's listidentities. Consumers (IDsScreen footer, future export
    // flows) subtract this against the active daemon's live list to
    // surface IDs the user owns but hasn't exported here yet. Presence on
    // the active chain is always verified via getidentity — this map is a
    // hint, not authoritative.
    chrome.storage.local.get(['knownIdentities'], (data) => {
      sendResponse({ ids: data.knownIdentities || {} });
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
      const willActivate = message.activate || !data.activeChain;
      if (willActivate) updates.activeChain = key;
      chrome.storage.local.set(updates, () => {
        if (willActivate) chrome.runtime.sendMessage({ type: 'WALLET_CHAIN_CHANGED', key }).catch(() => {});
        sendResponse({ ok: true });
      });
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
      chrome.storage.local.set({ activeChain: key }, () => {
        // Tell the popup the active chain changed so it can hard-reset any
        // address-bound state (current address, pending txs, sub flow, etc.).
        chrome.runtime.sendMessage({ type: 'WALLET_CHAIN_CHANGED', key }).catch(() => {});
        sendResponse({ ok: true });
      });
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
      chrome.storage.local.set({ chains, activeChain: key }, () => {
        chrome.runtime.sendMessage({ type: 'WALLET_CHAIN_CHANGED', key }).catch(() => {});
        sendResponse({ ok: true });
      });
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
    const approval: PendingApproval = { id, method, params, origin, chainKey: null, resolve, reject: (e) => reject(new Error(e)) };
    pendingApprovals.push(approval);
    // Snapshot the active chain at request time so the user can't be tricked
    // into approving a tx against a different daemon by switching chains
    // between the page request and the approval click.
    getActiveChainKey().then((key) => { approval.chainKey = key; }).catch(() => {});
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
  // Bind the approval to the chain it was issued under. If the user switched
  // chains between the page request and the approval, both callRpc's daemon
  // target and the fallback address would resolve to the new chain and sign
  // a tx the user did not intend. Refuse execution and surface the mismatch.
  if (approval.chainKey) {
    const liveChain = await getActiveChainKey();
    if (liveChain !== approval.chainKey) {
      approval.reject(`Chain changed from ${approval.chainKey} to ${liveChain || '(none)'} — request not executed. Switch back and re-request from the page.`);
      return;
    }
  }
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
