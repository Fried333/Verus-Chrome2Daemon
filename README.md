# Verus-Chrome2Daemon

Chrome/Brave extension that bridges web pages to your **local Verus daemon**.
Non-custodial — your keys never leave the daemon. The extension only relays
JSON-RPC and gates mutating operations behind an explicit user approval.

> ⚠️ **Use at your own risk.** This software is provided **AS IS, without
> warranty of any kind**, express or implied. The authors and contributors
> accept **no liability** for any loss of funds, identity compromise, data
> loss, or other damages arising from use of this extension. Cryptocurrency
> wallet software is high-risk by nature: bugs, misconfiguration, or a
> compromised browser / daemon / host can lead to **irreversible loss**.
>
> Before relying on this wallet:
> - Read the code (the codebase is small and audit-friendly), and / or
>   commission a third-party security review for non-trivial amounts.
> - **Test with small amounts first.** Verify a few sends, swaps, and ID
>   updates on each chain you intend to use before holding material value.
> - **Back up your daemon's `wallet.dat`** (and any imported privkeys). The
>   extension stores no keys; recovery is entirely on the daemon side.
> - **Verify every approval popup** — recipient address, amount, currency,
>   chain — before clicking Approve. The extension renders what the page
>   asked for; only your eyes can spot a malicious page.
> - This project is **not affiliated with or endorsed by** the Verus Coin
>   Foundation. It is an independent client implementation.

## Features

- **Multi-chain** — Connect to VRSC, vDEX, vARRR, or CHIPS (or any custom
  Verus PBaaS daemon). Each chain has its own RPC credentials, its own
  selected address, and its own balance / activity view. Switch chains from
  the dashboard or Settings pill, and the UI hard-resets to the new chain's
  state.
- **VerusID Login** — Sign in to websites using the `verus://` deep-link
  protocol with the verus-connect v5.2 GenericRequest / GenericResponse
  envelope flow.
- **Send / Receive** — Send the active chain's native currency or any
  reserve currency, with approval popups.
- **Balance & UTXOs** — View balances across addresses and currencies; the
  headline balance reflects whichever chain is active.
- **Identity Management** — List, select, and update VerusIDs (with diffed
  approval for any on-chain change).
- **VerusSub Subscriptions** — Time-locked subscription payments via
  `window.verus.subscribe()`.
- **Dark / Light Theme** — Follows system preference.

## Architecture

```
Website                 Extension                          Local Daemons
  |                       |                                  |
  |--- window.verus ----> | inpage.ts (injected)             |  verusd  :27486 (VRSC)
  |                       | content.ts (bridge)              |  vdexd   :21778
  |                       | background.js (service worker)   |  varrrd  :20778
  |                       |--- JSON-RPC over HTTP ---------> |  chipsd  :22778
  |                       | side panel (React UI)            |
  |                       |   ↑ active-chain selector picks  |
  |                       |     which daemon RPC routes to   |
```

- **Non-custodial.** No keys stored in the extension. All signing done by the
  daemon (`signdata`, `signmessage`, `signrawtransaction`).
- **One active chain at a time.** Per-chain credentials live in
  `chrome.storage.local`; the active chain decides which daemon every RPC
  call routes to. Each chain also has its own selected account, pending tx
  history, and account-name overrides — they don't bleed across chains.
- **RPC allowlist.** The page-callable API is gated by an explicit set of
  methods. Dangerous daemon RPCs (`dumpprivkey`, `z_exportkey`, etc.) are
  never exposed.
- **Per-method approval.** All mutating operations (`sendCurrency`,
  `signMessage`, `updateIdentity`, `subscribe`, `cancelSubscription`) require
  a side-panel approval with full parameter rendering and password re-entry.
- **Chain-bound approvals.** The chain in effect when the page issued the
  request is snapshotted on the pending-approval record. If the user
  switches chains before clicking Approve, the service worker refuses to
  execute and the approval screen surfaces a red mismatch banner — so a
  page request issued under chain A can never be silently signed on chain B.
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
4. Click the extension icon to open the side panel.
5. **Pick the chain you want to set up first** (VRSC by default — a green
   dot next to the pill means a daemon is detected on its default RPC
   port). The setup screen shows you the exact `.conf` path for the
   selected chain on your OS (linux / mac / win) with a one-liner you can
   paste into a terminal to extract `rpcuser` / `rpcpassword` / `rpcport`.
   Paste the output into the textarea and hit **Connect**.
6. Set a wallet password.
7. To add another chain (e.g. vARRR), go to **Settings → Add / edit chain**
   and repeat from step 5 with a different chain pill selected. Configured
   chains then appear as switchable pills both in Settings and at the top
   of the dashboard.

Default RPC ports the extension expects per chain (override-able under
**Custom host / port** if your daemon was launched with `-rpcport=…`):

| Chain | Port |
|---|---|
| VRSC | 27486 |
| vDEX | 21778 |
| vARRR | 20778 |
| CHIPS | 22778 |

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
- **Chain-bound approval execution.** Every pending approval records the
  chain that was active when the page made the request. If the user
  switches chains before clicking Approve, the service worker rejects the
  call and the page caller gets an explanatory error — a request scoped to
  chain A can never silently sign on chain B's daemon.
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

[MIT](LICENSE) — see the LICENSE file for the full text, including the
disclaimer of warranty and limitation of liability.

In short: the software is distributed "AS IS", without warranty of any
kind, and the authors are not liable for any claim, damages, or other
liability arising from its use. By installing and using this extension you
accept these terms.
