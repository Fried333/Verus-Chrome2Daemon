/**
 * Attack-vector validation for the v5.2 login flow + sw allowlist.
 *
 * Each test constructs a malicious input and asserts the wallet code rejects
 * it. Failing tests indicate a security regression.
 *
 * Required env: VERUS_RPC_USER, VERUS_RPC_PASSWORD, VERUS_TEST_IDENTITY
 */

import {
  GenericRequest,
  AuthenticationRequestOrdinalVDXFObject,
  AuthenticationRequestDetails,
  ResponseURI,
  VerifiableSignatureData,
  CompactIAddressObject,
} from 'verus-typescript-primitives';
import { BN } from 'bn.js';
import { parseDeeplink, signAndDeliverLogin, verifyRequestSignature } from '../src/background/login-handler.js';

function req(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing env: ${name}`); process.exit(2); }
  return v;
}

const VRSC_SYSTEM_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const RP_IDENTITY = req('VERUS_TEST_IDENTITY');
const RPC_URL = process.env.VERUS_RPC_URL || 'http://127.0.0.1:27486';
const RPC_USER = req('VERUS_RPC_USER');
const RPC_PASSWORD = req('VERUS_RPC_PASSWORD');

async function callRpc(method: string, params: any[] = []): Promise<any> {
  const auth = Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64');
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({ jsonrpc: '1.0', id: '1', method, params }),
  });
  const data = await r.json() as any;
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

async function getIAddr(name: string): Promise<string> {
  if (/^i[a-zA-Z0-9]{33,34}$/.test(name)) return name;
  const info = await callRpc('getidentity', [name]);
  return info?.identity?.identityaddress;
}

/**
 * Build a signed GenericRequest for the given response URI + optional clock
 * skew. createdAtOverride lets us mint pre-dated / future-dated requests
 * to test the expiry bounds.
 */
async function buildSignedRequest(opts: {
  uri: string;
  uriType: 'post' | 'redirect';
  createdAtOverride?: number;
}): Promise<string> {
  const rpIAddr = await getIAddr(RP_IDENTITY);
  if (!rpIAddr) throw new Error('Could not resolve RP identity');

  const authDetail = new AuthenticationRequestOrdinalVDXFObject({
    data: new AuthenticationRequestDetails({}),
  });
  const placeholderSig = new VerifiableSignatureData({
    identityID: CompactIAddressObject.fromAddress(rpIAddr),
    systemID: CompactIAddressObject.fromAddress(VRSC_SYSTEM_ID),
  });
  const type = opts.uriType === 'post' ? ResponseURI.TYPE_POST : ResponseURI.TYPE_REDIRECT;
  const responseURIs = [ResponseURI.fromUriString(opts.uri, type)];

  const createdAt = opts.createdAtOverride ?? Math.floor(Date.now() / 1000);
  const request = new GenericRequest({
    details: [authDetail],
    createdAt: new BN(createdAt),
    responseURIs,
    signature: placeholderSig,
  });
  request.setSigned();

  const rawSha = request.getRawDataSha256().toString('hex');
  const sigResult = await callRpc('signdata', [{ address: rpIAddr, datahash: rawSha }]);
  request.signature!.signatureAsVch = Buffer.from(sigResult.signature, 'base64');
  return request.toWalletDeeplinkUri();
}

/** Same but with a deliberately bogus signature blob (forged identity claim). */
async function buildForgedSigRequest(opts: { uri: string; uriType: 'post' | 'redirect' }): Promise<string> {
  // Real signature shape — we sign with a different identity, then overwrite
  // the identityID field so the signature won't match the claimed signer.
  const realIAddr = await getIAddr(RP_IDENTITY);
  const fakeIAddr = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'; // any other i-address; doesn't need to be real
  const authDetail = new AuthenticationRequestOrdinalVDXFObject({
    data: new AuthenticationRequestDetails({}),
  });
  const responseURIs = [ResponseURI.fromUriString(opts.uri,
    opts.uriType === 'post' ? ResponseURI.TYPE_POST : ResponseURI.TYPE_REDIRECT)];
  const request = new GenericRequest({
    details: [authDetail],
    createdAt: new BN(Math.floor(Date.now() / 1000)),
    responseURIs,
    signature: new VerifiableSignatureData({
      identityID: CompactIAddressObject.fromAddress(realIAddr),
      systemID: CompactIAddressObject.fromAddress(VRSC_SYSTEM_ID),
    }),
  });
  request.setSigned();
  const rawSha = request.getRawDataSha256().toString('hex');
  const sigResult = await callRpc('signdata', [{ address: realIAddr, datahash: rawSha }]);
  request.signature!.signatureAsVch = Buffer.from(sigResult.signature, 'base64');
  // Now swap the identityID — claim someone else signed it
  request.signature!.identityID = CompactIAddressObject.fromAddress(fakeIAddr);
  return request.toWalletDeeplinkUri();
}

type Case = { name: string; run: () => Promise<void> };

async function expectThrow(label: string, fn: () => Promise<any>, mustContainAny: string | string[]): Promise<void> {
  const needles = Array.isArray(mustContainAny) ? mustContainAny : [mustContainAny];
  try {
    await fn();
    throw new Error(`REGRESSION: ${label} — expected throw containing one of ${JSON.stringify(needles)} but call returned`);
  } catch (e: any) {
    const msg = (e.message || '').toLowerCase();
    if (!needles.some(n => msg.includes(n.toLowerCase()))) {
      throw new Error(`REGRESSION: ${label} — wrong error: ${e.message}`);
    }
    console.log(`  ✓ ${label} (rejected: "${e.message}")`);
  }
}

const cases: Case[] = [
  {
    name: 'H1: Loopback responseUri (127.0.0.1) rejected',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'http://127.0.0.1:5555/admin/wipe',
        uriType: 'post',
      });
      const parsed = parseDeeplink(deeplink);
      await expectThrow('signAndDeliverLogin with loopback POST',
        () => signAndDeliverLogin(parsed, RP_IDENTITY, callRpc),
        'cannot point to localhost');
    },
  },
  {
    name: 'H1: Loopback responseUri (localhost) rejected',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'http://localhost:8080/x',
        uriType: 'post',
      });
      const parsed = parseDeeplink(deeplink);
      await expectThrow('signAndDeliverLogin with localhost POST',
        () => signAndDeliverLogin(parsed, RP_IDENTITY, callRpc),
        'cannot point to localhost');
    },
  },
  {
    name: 'H1: 127.x.x.x (other loopback) rejected',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'http://127.99.0.1/x',
        uriType: 'post',
      });
      const parsed = parseDeeplink(deeplink);
      await expectThrow('signAndDeliverLogin with 127.99.0.1',
        () => signAndDeliverLogin(parsed, RP_IDENTITY, callRpc),
        'cannot point to localhost');
    },
  },
  {
    name: 'H1: HTTP non-localhost responseUri rejected (HTTPS required)',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'http://example.com/x',
        uriType: 'post',
      });
      const parsed = parseDeeplink(deeplink);
      await expectThrow('signAndDeliverLogin with HTTP non-localhost',
        () => signAndDeliverLogin(parsed, RP_IDENTITY, callRpc),
        'must be HTTPS');
    },
  },
  {
    name: 'H2: Forged signing-identity claim rejected by verifyRequestSignature',
    run: async () => {
      const deeplink = await buildForgedSigRequest({
        uri: 'https://example.com/x',
        uriType: 'post',
      });
      const parsed = parseDeeplink(deeplink);
      await expectThrow('verifyRequestSignature with forged identityID',
        () => verifyRequestSignature(parsed, callRpc),
        ['does not match claimed identity', 'could not be verified']);
    },
  },
  {
    name: 'H3: Stale challenge (10 minutes old) rejected at parse time',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'https://example.com/x',
        uriType: 'post',
        createdAtOverride: Math.floor(Date.now() / 1000) - 600,
      });
      await expectThrow('parseDeeplink with stale createdAt',
        async () => parseDeeplink(deeplink),
        'expired');
    },
  },
  {
    name: 'H3: Future-dated challenge (10 min ahead) still rejected',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'https://example.com/x',
        uriType: 'post',
        createdAtOverride: Math.floor(Date.now() / 1000) + 600,
      });
      await expectThrow('parseDeeplink with future createdAt',
        async () => parseDeeplink(deeplink),
        'too far in the future');
    },
  },
  {
    name: 'Happy path: fresh https://example.com request passes parse + verify',
    run: async () => {
      const deeplink = await buildSignedRequest({
        uri: 'https://example.com/verus/verusidlogin/test',
        uriType: 'post',
      });
      const parsed = parseDeeplink(deeplink);
      await verifyRequestSignature(parsed, callRpc);
      console.log(`  ✓ parse + verify succeeded for ${parsed.signingIAddress}`);
    },
  },
];

async function main() {
  let failed = 0;
  for (const c of cases) {
    console.log(`\n— ${c.name}`);
    try {
      await c.run();
    } catch (e: any) {
      failed += 1;
      console.error(`  ✗ ${e.message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} attack-vector tests passed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
