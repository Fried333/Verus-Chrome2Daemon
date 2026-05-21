# Verus-Chrome2Daemon

Chrome/Brave extension that bridges web pages to your **local Verus daemon**.
Non-custodial — your keys never leave the daemon. The extension only relays
JSON-RPC and gates mutating operations behind an explicit user approval.

## Features

- **VerusID Login** — Sign in to websites using the `verus://` deep-link
  protocol with the verus-connect v5.2 GenericRequest / GenericResponse
  envelope flow.
- **Send / Receive** — Send VRSC and reserve currencies with approval popups.
- **Balance & UTXOs** — View balances across addresses and currencies.
- **Identity Management** — List, select, and update VerusIDs (with diffed
  approval for any on-chain change).
- **VerusSub Subscriptions** — Time-locked subscription payments via
  `window.verus.subscribe()`.
- **Dark / Light Theme** — Follows system preference.

## Architecture

```
Website                 Extension                       Local Daemon
  |                       |                                |
  |--- window.verus ----> | inpage.ts (injected)           |
  |                       | content.ts (bridge)            |
  |                       | background.js (service worker) |
  |                       |--- JSON-RPC over HTTP -------> | verusd :27486
  |                       | side panel (React UI)          |
```

- **Non-custodial.** No keys stored in the extension. All signing done by the
  daemon (`signdata`, `signmessage`, `signrawtransaction`).
- **RPC allowlist.** The page-callable API is gated by an explicit set of
  methods. Dangerous daemon RPCs (`dumpprivkey`, `z_exportkey`, etc.) are
  never exposed.
- **Per-method approval.** All mutating operations (`sendCurrency`,
  `signMessage`, `updateIdentity`, `subscribe`, `cancelSubscription`) require
  a side-panel approval with full parameter rendering and password re-entry.
- **Verified relying party.** VerusID login requests are cryptographically
  verified against the claimed signing identity (`verifyhash` RPC) before
  the user sees any "Challenge signed by …" attribution.

## Prerequisites

- [Verus Desktop](https://verus.io/wallet) or `verusd` running locally
- Node.js 20+
- Chrome or Brave (or any Chromium-based browser with MV3 support)

## Setup

```bash
git clone https://github.com/Fried333/Verus-Chrome2Daemon.git
cd Verus-Chrome2Daemon
npm install
npm run build
```

Load the extension:

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. Click the extension icon, set your RPC credentials (from
   `~/.komodo/VRSC/VRSC.conf`), then set a wallet password.

## Build

```bash
npm run build        # Production build into dist/
npm run dev          # Watch mode (development)
npm run clean        # Delete dist/
```

## Dependencies

### Runtime
| Package | Pinned to | Purpose |
|---|---|---|
| react | 18.3.1 | Side-panel UI framework |
| react-dom | 18.3.1 | React DOM renderer |
| verus-typescript-primitives | github commit `7f0fd7ff` | Verus protocol types (VDXF, GenericRequest/Response, signatures) |

The Verus primitives dependency is pinned to a specific commit so that
`npm install` is reproducible and cannot be silently substituted by an
upstream branch change.

### Build-time only
webpack, ts-loader, typescript, html-webpack-plugin, copy-webpack-plugin,
css-loader, style-loader, node-polyfill-webpack-plugin, plus
`@types/*` packages.

## Security

The wallet's defenses (and the threat model they correspond to) are
described in detail in [SECURITY.md](SECURITY.md). Highlights:

- **Allowlisted page API.** Only the methods listed in
  [`src/background/sw.ts`](src/background/sw.ts) (`READ_ONLY` and
  `APPROVAL_REQUIRED` sets) are callable from a web page.
- **Mandatory approval rendering.** The approval screen refuses to display
  any method it cannot render the parameters of — adding a new mutating
  method without a UI is a hard failure, not a silent allow.
- **VerusID change diffing.** `updateIdentity` approvals fetch the current
  on-chain identity and render a structured diff. Revoke / recovery
  authority changes are surfaced as a prominent warning, since they are the
  identity-seizure vector.
- **Signed login requests are verified.** Before the relying party's
  identity is shown to the user, the request signature is checked via the
  daemon's `verifyhash` RPC. A forged "signed by …" claim is rejected.
- **No localhost callbacks.** Login response URLs (`responseUri`) must be
  HTTPS and may not point to loopback addresses — this closes a confused-
  deputy SSRF against local services.
- **Stale challenges rejected.** Login deeplinks older than 5 minutes are
  refused, so a leaked QR or link cannot be replayed later.
- **PBKDF2-SHA256 @ 600k iterations** for the wallet password, with
  per-user random salt and an automatic migration from any pre-existing
  100k-iteration hashes on first unlock.
- **Auto-lock** after a configurable inactivity timeout (default 5
  minutes). All approval handlers refuse if the wallet is locked.
- **Strict CSP** on extension pages (`script-src 'self'; object-src 'self';
  base-uri 'none'; frame-ancestors 'none'`).

## Reporting Vulnerabilities

See [SECURITY.md](SECURITY.md). Do not open public issues for security bugs.

## License

[MIT](LICENSE)
