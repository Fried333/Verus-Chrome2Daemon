/**
 * Content script — bridges between the injected inpage.js and the service worker.
 * Runs in an isolated world so it can access both the page and chrome.runtime.
 */

// Inject the inpage script into the page context
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inpage.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Forward requests from the page to the service worker
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'VERUS_REQUEST') return;

  const { id, method, params } = event.data;

  chrome.runtime.sendMessage(
    { type: 'PAGE_REQUEST', id, method, params, origin: window.location.origin },
    (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: 'VERUS_RESPONSE',
          id,
          error: 'Verus Wallet extension not available',
        }, '*');
        return;
      }

      window.postMessage({
        type: 'VERUS_RESPONSE',
        id,
        result: response?.result,
        error: response?.error,
      }, '*');
    }
  );
});
