// Native currency metadata for the 4 known Verus chains. Imported by both
// the service worker and popup screens so they agree on what "the native
// currency" means without having to round-trip through GET_STATE every
// render. For PBaaS children, the chain's system_id IS the native currency
// iaddress.
export interface ChainNative {
  name: string;
  iaddress: string;
  systemId: string;
}

export const CHAIN_NATIVE: Record<string, ChainNative> = {
  VRSC:  { name: 'VRSC',  iaddress: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', systemId: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV' },
  vDEX:  { name: 'vDEX',  iaddress: 'iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N', systemId: 'iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N' },
  vARRR: { name: 'vARRR', iaddress: 'iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2', systemId: 'iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2' },
  CHIPS: { name: 'CHIPS', iaddress: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP', systemId: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP' },
};

// Fallback when the active chain key isn't in the known set (user-added
// chain). Returns the key as the display name and null iaddr; callers should
// treat null iaddr as "skip the native-balance precheck."
export function nativeFor(chainKey: string | null | undefined): ChainNative | { name: string; iaddress: null; systemId: null } {
  if (!chainKey) return { name: '—', iaddress: null, systemId: null };
  const known = CHAIN_NATIVE[chainKey];
  if (known) return known;
  return { name: chainKey, iaddress: null, systemId: null };
}
