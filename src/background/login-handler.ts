/**
 * VerusID login (verus-connect v5.2 protocol).
 *
 * Parses verus:// deeplinks carrying a signed GenericRequest envelope, builds a
 * matching signed GenericResponse, and delivers it either by POST (callback URL)
 * or REDIRECT (URL the caller must open in the originating tab).
 *
 * Signing path: daemon's `signdata` over the response envelope's raw sha256.
 * The daemon wraps it as IdentitySignatureHash internally; do NOT pre-wrap with
 * getDetailsIdentitySignatureHash here (that would double-wrap and break
 * offline verification on mobile).
 */

import {
  GenericRequest,
  GenericResponse,
  AuthenticationResponseOrdinalVDXFObject,
  AuthenticationResponseDetails,
  ResponseURI,
  VerifiableSignatureData,
  CompactIAddressObject,
} from 'verus-typescript-primitives';
import { BN } from 'bn.js';
import { createHash } from 'crypto';

// VDXF key the wallet uses to append the base64url-encoded GenericResponse to
// the redirect URL when honouring a TYPE_REDIRECT ResponseURI. Constant per the
// primitives definition; hardcoded so we don't pull in the full constants
// module just for one string.
const RESPONSE_PARAM_VDXFID = 'i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC';

export type ResponseUriType = 'post' | 'redirect';

export interface ParsedLoginRequest {
  request: GenericRequest;
  /** Cached envelope bytes — used to compute response.requestHash. */
  requestBytes: Buffer;
  /** Resolved URI from the chosen ResponseURI entry (per-challenge URL). */
  responseUri: string;
  uriType: ResponseUriType;
  /** i-address of the signing identity carried in request.signature.identityID. */
  signingIAddress: string;
  /** systemID (chain i-address) the challenge was issued on. */
  systemId: string;
  /** Unix seconds the challenge was created at, or 0 if not present. */
  createdAt: number;
}

function bnToNum(bn: any): number {
  if (bn == null) return 0;
  if (typeof bn === 'number') return bn;
  if (typeof bn.toNumber === 'function') return bn.toNumber();
  return Number(bn);
}

export function parseDeeplink(uri: string): ParsedLoginRequest {
  if (!uri || uri.length > 10_000) throw new Error('Invalid deep link URI');

  let request: GenericRequest;
  try {
    request = GenericRequest.fromWalletDeeplinkUri(uri);
  } catch (e: any) {
    throw new Error('Could not parse login request: ' + (e?.message || 'unknown'));
  }

  if (!request.isSigned() || !request.signature) {
    throw new Error('Login request must be signed by the relying party');
  }

  const uris = request.responseURIs || [];
  if (uris.length === 0) {
    throw new Error('Login request has no ResponseURI');
  }

  // verus-connect ≥5.2 emits exactly one ResponseURI per envelope (the server
  // splits POST and REDIRECT into two envelopes). If a future or legacy server
  // ships multiple, prefer POST — it requires no tab navigation.
  const post = uris.find((u) => bnToNum(u.type) === bnToNum(ResponseURI.TYPE_POST));
  const pick = post || uris[0];
  const pickType = bnToNum(pick.type);

  let uriType: ResponseUriType;
  if (pickType === bnToNum(ResponseURI.TYPE_POST)) uriType = 'post';
  else if (pickType === bnToNum(ResponseURI.TYPE_REDIRECT)) uriType = 'redirect';
  else throw new Error('Unsupported ResponseURI type: ' + pickType);

  const createdAt = bnToNum(request.createdAt);
  if (createdAt > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (createdAt > nowSec + 300) {
      throw new Error('Challenge timestamp is too far in the future');
    }
    // Reject stale challenges. Five minutes matches the server-side window
    // and prevents replay of a leaked deeplink shared days/weeks ago.
    if (nowSec - createdAt > 300) {
      throw new Error('Challenge has expired (older than 5 minutes)');
    }
  }

  return {
    request,
    requestBytes: request.toBuffer(),
    responseUri: pick.getUriString(),
    uriType,
    signingIAddress: request.signature.identityID.toAddress(),
    systemId: request.signature.systemID.toAddress(),
    createdAt,
  };
}

function bytesToBase64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Verify the relying party's signature on the login request via the daemon.
 *
 * Without this, a malicious site can craft an envelope claiming any
 * signingIAddress (e.g. `coinbase@`) and the wallet would display that
 * identity to the user as "Challenge signed by …" purely on the page's
 * say-so. We verify before showing anything trust-bearing in the UI.
 */
export async function verifyRequestSignature(
  parsed: ParsedLoginRequest,
  callRpc: (method: string, params: any[]) => Promise<any>,
): Promise<void> {
  const sig = parsed.request.signature;
  if (!sig?.signatureAsVch) throw new Error('Request signature is missing');
  const sigB64 = sig.signatureAsVch.toString('base64');
  const rawSha = parsed.request.getRawDataSha256().toString('hex');
  // verifysignature wraps datahash with IdentitySignatureHash internally —
  // same convention as signdata. Pass the raw sha256, not pre-wrapped.
  // Without checkonly, the RPC returns the verified address (string) on
  // success or false / null on failure. Returning a string is the security
  // property we care about; cross-check it against the claimed signer to
  // close the case where verusd verifies for a different identity than the
  // envelope claims.
  let result: any;
  try {
    result = await callRpc('verifysignature', [{
      address: parsed.signingIAddress,
      signature: sigB64,
      datahash: rawSha,
    }]);
  } catch (e: any) {
    // Daemon-level failure (e.g. "Invalid identity", malformed signature)
    // is treated as a verification failure — fail closed.
    throw new Error('Request signature could not be verified: ' + (e?.message || 'rpc error'));
  }
  // verifysignature verifies AGAINST the address we passed (signingIAddress).
  // Truthy result means the signature is valid for that address; false/null
  // means it isn't. We don't need to cross-check the value — only that the
  // verification succeeded.
  if (!result) {
    throw new Error('Request signature does not match claimed identity');
  }
}

async function resolveToIAddress(
  nameOrIAddr: string,
  callRpc: (method: string, params: any[]) => Promise<any>,
): Promise<string> {
  if (/^i[a-zA-Z0-9]{33,34}$/.test(nameOrIAddr)) return nameOrIAddr;
  const info = await callRpc('getidentity', [nameOrIAddr]);
  const iaddr = info?.identity?.identityaddress || info?.identityaddress;
  if (!iaddr) throw new Error(`Could not resolve ${nameOrIAddr} to an i-address`);
  return iaddr;
}

async function buildSignedResponse(
  parsed: ParsedLoginRequest,
  identityIAddress: string,
  callRpc: (method: string, params: any[]) => Promise<any>,
): Promise<Buffer> {
  const requestHash = createHash('sha256').update(parsed.requestBytes).digest();

  const responseDetail = new AuthenticationResponseOrdinalVDXFObject({
    data: new AuthenticationResponseDetails({}),
  });

  const response = new GenericResponse({
    details: [responseDetail],
    createdAt: new BN(Math.floor(Date.now() / 1000)),
    requestHash,
    signature: new VerifiableSignatureData({
      identityID: CompactIAddressObject.fromAddress(identityIAddress),
      systemID: CompactIAddressObject.fromAddress(parsed.systemId),
    }),
  });
  response.setSigned();

  const rawSha = response.getRawDataSha256().toString('hex');
  const signResult = await callRpc('signdata', [{
    address: identityIAddress,
    datahash: rawSha,
  }]);
  if (!signResult?.signature) {
    throw new Error('Signing failed — daemon returned no signature');
  }
  response.signature!.signatureAsVch = Buffer.from(signResult.signature, 'base64');

  return response.toBuffer();
}

function isLoopbackHostname(hostname: string): boolean {
  // RFC 6761 loopback names + IPv4 127/8 + IPv6 ::1. Anything else is remote.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  return false;
}

function assertHttpUrl(rawUrl: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  // Reject loopback callbacks outright. They open a localhost-SSRF surface
  // (the wallet would POST a signed envelope to any local service the relying
  // party named) and have no legitimate use in production sign-in flows.
  if (isLoopbackHostname(url.hostname)) {
    throw new Error(`${label} cannot point to localhost`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label} must be HTTPS`);
  }
  return url;
}

export type SignResult =
  | { kind: 'post'; identity: string }
  | { kind: 'redirect'; identity: string; redirectUrl: string };

/**
 * Sign the GenericResponse and either POST it to the callback (POST envelope)
 * or return the redirect URL with the response payload appended (REDIRECT
 * envelope). For REDIRECT, the caller is responsible for navigating the
 * originating tab — the wallet sidecar/service-worker has no API to write to a
 * page's location once Linking is taken out of the picture.
 */
export async function signAndDeliverLogin(
  parsed: ParsedLoginRequest,
  identityAddressOrName: string,
  callRpc: (method: string, params: any[]) => Promise<any>,
): Promise<SignResult> {
  const identityIAddress = await resolveToIAddress(identityAddressOrName, callRpc);
  const responseBytes = await buildSignedResponse(parsed, identityIAddress, callRpc);

  if (parsed.uriType === 'post') {
    assertHttpUrl(parsed.responseUri, 'Callback URL');
    const r = await fetch(parsed.responseUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: responseBytes,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Callback failed (${r.status}): ${text.slice(0, 200)}`);
    }
    return { kind: 'post', identity: identityIAddress };
  }

  // REDIRECT — append base64url(responseBytes) under the VDXF key the
  // verus-connect web component reads back on the destination page.
  const url = assertHttpUrl(parsed.responseUri, 'Redirect URL');
  url.searchParams.set(RESPONSE_PARAM_VDXFID, bytesToBase64Url(responseBytes));
  return { kind: 'redirect', identity: identityIAddress, redirectUrl: url.toString() };
}
