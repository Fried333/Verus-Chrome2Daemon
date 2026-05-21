/**
 * Injected into web pages as window.verus
 * Intercepts verus:// deep links AND exposes the wallet API.
 */

(function () {
  const VERUS_PROTOCOLS = ['verus://', 'vrsc://'];
  const LEGACY_PROTOCOL = 'i5jtwbp6zymeay9llnraglgjqgdrffsau4://';

  function isVerusUri(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return VERUS_PROTOCOLS.some(p => lower.startsWith(p)) || lower.startsWith(LEGACY_PROTOCOL);
  }

  function relayDeeplink(uri: string): void {
    window.postMessage({ type: 'VERUS_REQUEST', id: ++requestId, method: 'handleDeeplink', params: { uri } }, '*');
  }

  // === Provider API ===
  let requestId = 0;
  const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'VERUS_RESPONSE') return;
    const { id, result, error } = event.data;
    const pending = pendingRequests.get(id);
    if (!pending) return;
    pendingRequests.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result);
  });

  function request(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });
      window.postMessage({ type: 'VERUS_REQUEST', id, method, params }, '*');
      setTimeout(() => {
        if (pendingRequests.has(id)) { pendingRequests.delete(id); reject(new Error('Request timed out')); }
      }, 300_000);
    });
  }

  const verus = {
    isVerusWallet: true,
    version: '5.2.0',

    getAddress: () => request('getAddress'),
    getBalance: (address?: string) => request('getBalance', { address }),
    send: (params: { to: string; amount: number; currency?: string; convertto?: string; via?: string; memo?: string }) =>
      request('sendCurrency', params),
    getIdentity: (nameOrId: string) => request('getIdentity', { nameOrId }),
    getInfo: () => request('getInfo'),
    estimateConversion: (params: { from: string; to: string; amount: number; via?: string }) =>
      request('estimateConversion', params),
    signMessage: (params: { message: string; identity?: string }) =>
      request('signMessage', params),

    // VerusID login — website passes a verus:// deep link URI
    requestLogin: (uri: string): Promise<any> => {
      if (!uri || !isVerusUri(uri)) return Promise.reject(new Error('Invalid Verus login URI'));
      return request('handleDeeplink', { uri });
    },

    // VerusSub — subscription management
    subscribe: (params: { provider: string; planId?: string; subscriberId?: string }) =>
      request('subscribe', params),
    cancelSubscription: (params: { provider: string; subscriberId?: string }) =>
      request('cancelSubscription', params),

    // Generic request method for future extensibility
    request: (params: { method: string; params?: any }) =>
      request(params.method, params.params),
  };

  Object.defineProperty(window, 'verus', { value: Object.freeze(verus), writable: false, configurable: false });
  window.dispatchEvent(new CustomEvent('verus#initialized'));

  // === Intercept <a> clicks ===
  document.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest?.('a');
    if (!target) return;
    const href = target.getAttribute('href');
    if (!href || !isVerusUri(href)) return;
    event.preventDefault();
    event.stopPropagation();
    relayDeeplink(href);
  }, true);

  // === Intercept location changes ===
  try {
    const origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url: string) {
      if (isVerusUri(url)) { relayDeeplink(url); return; }
      return origAssign.call(this, url);
    };

    const origReplace = Location.prototype.replace;
    Location.prototype.replace = function (url: string) {
      if (isVerusUri(url)) { relayDeeplink(url); return; }
      return origReplace.call(this, url);
    };

    const hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (hrefDesc?.set) {
      const origSet = hrefDesc.set;
      Object.defineProperty(Location.prototype, 'href', {
        ...hrefDesc,
        set(value: string) {
          if (isVerusUri(value)) { relayDeeplink(value); return; }
          origSet.call(this, value);
        },
      });
    }
  } catch {}

  // === Intercept window.open ===
  const origOpen = window.open.bind(window);
  (window as any).open = function (url?: string | URL, target?: string, features?: string) {
    const urlStr = url?.toString();
    if (urlStr && isVerusUri(urlStr)) { relayDeeplink(urlStr); return null; }
    return origOpen(url, target, features);
  };

  // === Intercept programmatic <a> clicks ===
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.getAttribute('href');
    if (href && isVerusUri(href)) { relayDeeplink(href); return; }
    return origClick.call(this);
  };
})();
