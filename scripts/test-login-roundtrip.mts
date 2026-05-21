/**
 * Round-trip test for the v5.2 login flow.
 *
 *  1. Build a signed GenericRequest deeplink (mimics verus-connect /login),
 *     using the local verusd to sign as the configured identity.
 *  2. Run parseDeeplink against it.
 *  3. Build a signed response with buildSignedResponse (private helper inlined
 *     here so we don't have to refactor the module just for testability).
 *  4. Verify the response signature against verusd's verifysignature —
 *     exactly what verus-connect's verifyResponse does server-side.
 *
 * Required env vars:
 *   VERUS_RPC_USER, VERUS_RPC_PASSWORD  — local daemon RPC credentials
 *   VERUS_TEST_IDENTITY                 — identity to sign as (e.g. "yourname@")
 *   VERUS_RPC_URL                       — defaults to http://127.0.0.1:27486
 *   VERUS_CALLBACK_BASE                 — defaults to https://example.com
 */

import {
  GenericRequest,
  GenericResponse,
  AuthenticationRequestOrdinalVDXFObject,
  AuthenticationRequestDetails,
  AuthenticationResponseOrdinalVDXFObject,
  AuthenticationResponseDetails,
  ResponseURI,
  VerifiableSignatureData,
  CompactIAddressObject,
} from 'verus-typescript-primitives';
import { BN } from 'bn.js';
import { createHash } from 'crypto';
import { parseDeeplink } from '../src/background/login-handler.js';

// --- Config (env-driven; no checked-in fallbacks) ---
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    console.error('See the comment at the top of this file for the required env.');
    process.exit(2);
  }
  return v;
}

const VRSC_SYSTEM_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const RP_IDENTITY = reqEnv('VERUS_TEST_IDENTITY');      // relying party
const USER_IDENTITY = process.env.VERUS_TEST_USER_IDENTITY || RP_IDENTITY;
const CALLBACK_BASE = process.env.VERUS_CALLBACK_BASE || 'https://example.com';
const CALLBACK = `${CALLBACK_BASE}/verus/verusidlogin/test-challenge-id`;
const REDIRECT = `${CALLBACK_BASE}/login?challengeId=test-challenge-id`;

const RPC_URL = process.env.VERUS_RPC_URL || 'http://127.0.0.1:27486';
const RPC_USER = reqEnv('VERUS_RPC_USER');
const RPC_PASSWORD = reqEnv('VERUS_RPC_PASSWORD');

async function callRpc(method: string, params: any[] = []): Promise<any> {
  const auth = Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64');
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({ jsonrpc: '1.0', id: '1', method, params }),
  });
  const data = await r.json() as any;
  if (data.error) throw new Error(`${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

async function getIAddr(name: string): Promise<string> {
  if (/^i[a-zA-Z0-9]{33,34}$/.test(name)) return name;
  const info = await callRpc('getidentity', [name]);
  return info?.identity?.identityaddress;
}

/** Build a signed GenericRequest exactly as verus-connect's createChallenge does. */
async function buildSignedRequest(uriType: 'post' | 'redirect'): Promise<string> {
  const rpIAddr = await getIAddr(RP_IDENTITY);
  if (!rpIAddr) throw new Error('Could not resolve RP identity');

  const authDetail = new AuthenticationRequestOrdinalVDXFObject({
    data: new AuthenticationRequestDetails({}),
  });

  const placeholderSig = new VerifiableSignatureData({
    identityID: CompactIAddressObject.fromAddress(rpIAddr),
    systemID: CompactIAddressObject.fromAddress(VRSC_SYSTEM_ID),
  });

  const uri = uriType === 'post' ? CALLBACK : REDIRECT;
  const type = uriType === 'post' ? ResponseURI.TYPE_POST : ResponseURI.TYPE_REDIRECT;
  const responseURIs = [ResponseURI.fromUriString(uri, type)];

  const request = new GenericRequest({
    details: [authDetail],
    createdAt: new BN(Math.floor(Date.now() / 1000)),
    responseURIs,
    signature: placeholderSig,
  });
  request.setSigned();

  const rawSha = request.getRawDataSha256().toString('hex');
  const sigResult = await callRpc('signdata', [{ address: rpIAddr, datahash: rawSha }]);
  request.signature!.signatureAsVch = Buffer.from(sigResult.signature, 'base64');

  return request.toWalletDeeplinkUri();
}

/** Build + sign a GenericResponse (same logic as login-handler's internal helper). */
async function buildSignedResponse(parsed: ReturnType<typeof parseDeeplink>): Promise<Buffer> {
  const userIAddr = await getIAddr(USER_IDENTITY);

  const requestHash = createHash('sha256').update(parsed.requestBytes).digest();
  const responseDetail = new AuthenticationResponseOrdinalVDXFObject({
    data: new AuthenticationResponseDetails({}),
  });
  const response = new GenericResponse({
    details: [responseDetail],
    createdAt: new BN(Math.floor(Date.now() / 1000)),
    requestHash,
    signature: new VerifiableSignatureData({
      identityID: CompactIAddressObject.fromAddress(userIAddr),
      systemID: CompactIAddressObject.fromAddress(parsed.systemId),
    }),
  });
  response.setSigned();

  const rawSha = response.getRawDataSha256().toString('hex');
  const sigResult = await callRpc('signdata', [{ address: userIAddr, datahash: rawSha }]);
  response.signature!.signatureAsVch = Buffer.from(sigResult.signature, 'base64');

  return response.toBuffer();
}

async function verifyResponseEnvelope(requestBytes: Buffer, responseBytes: Buffer): Promise<void> {
  const request = new GenericRequest();
  request.fromBuffer(requestBytes);

  const response = new GenericResponse();
  response.fromBuffer(responseBytes);

  // requestHash sanity check (same as verus-connect's auth.ts:185)
  if (response.requestHash && response.requestHash.length > 0) {
    const expected = createHash('sha256').update(requestBytes).digest();
    if (!response.requestHash.equals(expected)) {
      throw new Error('FAIL: response.requestHash does not match request bytes hash');
    }
    console.log('  ✓ requestHash matches sha256(requestBytes)');
  }

  if (!request.isSigned() || !response.isSigned()) {
    throw new Error('FAIL: both must be signed');
  }
  console.log('  ✓ both envelopes are flagged signed');

  // Request signature verify (verus-connect's step 3)
  const reqId = request.signature!.identityID.toAddress();
  const reqSigB64 = request.signature!.signatureAsVch.toString('base64');
  const reqHash = request.getRawDataSha256().toString('hex');
  const reqOk = await callRpc('verifysignature', [{
    address: reqId,
    signature: reqSigB64,
    datahash: reqHash,
  }]);
  if (!reqOk) throw new Error('FAIL: request signature did not verify');
  console.log(`  ✓ request signature verified for ${reqId}`);

  // Response signature verify (verus-connect's step 5)
  const respId = response.signature!.identityID.toAddress();
  const respSigB64 = response.signature!.signatureAsVch.toString('base64');
  const respHash = response.getRawDataSha256().toString('hex');
  const respOk = await callRpc('verifysignature', [{
    address: respId,
    signature: respSigB64,
    datahash: respHash,
  }]);
  if (!respOk) throw new Error('FAIL: response signature did not verify');
  console.log(`  ✓ response signature verified for ${respId}`);
}

async function runOne(uriType: 'post' | 'redirect') {
  console.log(`\n=== ${uriType.toUpperCase()} flow ===`);
  console.log('1. Building signed request deeplink...');
  const deeplink = await buildSignedRequest(uriType);
  console.log(`   deeplink length: ${deeplink.length} bytes`);

  console.log('2. parseDeeplink(...)');
  const parsed = parseDeeplink(deeplink);
  console.log(`   uriType=${parsed.uriType} signingIAddress=${parsed.signingIAddress} systemId=${parsed.systemId}`);
  console.log(`   responseUri=${parsed.responseUri}`);
  if (parsed.uriType !== uriType) throw new Error(`FAIL: expected uriType=${uriType}, got ${parsed.uriType}`);

  console.log('3. Building + signing response...');
  const responseBytes = await buildSignedResponse(parsed);
  console.log(`   responseBytes length: ${responseBytes.length}`);

  console.log('4. Verifying as verus-connect server would...');
  await verifyResponseEnvelope(parsed.requestBytes, responseBytes);

  console.log(`✅ ${uriType.toUpperCase()} round-trip PASSES`);
}

async function main() {
  await runOne('post');
  await runOne('redirect');
  console.log('\nAll flows verified.');
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
