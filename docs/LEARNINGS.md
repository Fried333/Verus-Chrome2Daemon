# Verus Web Wallet — Technical Learnings

Hard-won knowledge from building and testing. Reference this before making changes.

## Webpack / Build

### bn.js Buffer polyfill
`bn.js/package.json` has `"browser": { "buffer": false }` which tells webpack to ignore `require('buffer')`. This breaks `BN.prototype.toBuffer()` in service workers (no global `Buffer`).

**Fix:** Add webpack rule:
```js
{
  test: /node_modules[\\/]bn\.js[\\/]lib[\\/]bn\.js$/,
  resolve: { aliasFields: [] },
}
```
This disables the `browser` field override so `require('buffer')` falls through to `resolve.fallback`.

### Building
- **NEVER build on production servers** — all builds happen locally with `npm run build`
- `node_modules` was copied from V1 wallet, lockfile generated via `npm shrinkwrap`
- `transpileOnly: true` in ts-loader skips type checking (needed because V1 node_modules have older TS)
- After `npm install`, the bn.js alias rule handles Buffer — no manual patching needed

### Service Worker Considerations
- Chrome MV3 service workers can be killed after ~30 seconds of inactivity
- Keep message channels open with `return true` + delayed `sendResponse` for long operations
- `setTimeout` is unreliable — use `chrome.alarms` for timers that survive restarts
- Side panel polls every 2 seconds for pending requests (login, subscription)

## Verus Daemon RPC

### sendcurrency
- Returns an `opid`, NOT a txid — must poll `z_getoperationresult` to get the actual txid
- Accepts identity names as `fromaddress` (e.g. `"user1.example@"`)
- When `fromaddress` is a specific address (not `"*"`), change goes back to that address
- No `changeaddress` parameter — change behavior is implicit
- For non-VRSC currencies, add `"currency": "vETH"` to each output object
- Multiple outputs in one call: `[{addr, amount}, {addr, amount, currency: "vETH"}]`

### createrawtransaction
- **VRSC outputs:** `{ "address": amount }`
- **Currency outputs:** `{ "address": { "currencyIAddress": amount } }` — must use i-address, NOT friendly name
- Payment address must be R-address or i-address — `"provider-b.example@"` fails, use `"iGy7wRED..."` instead
- Resolve names via `getidentity` → `identity.identityaddress`
- Resolve currency names via `getcurrency` → `currencyid`

### Signing Unconfirmed UTXOs
- **VRSC UTXOs: CAN be signed unconfirmed** — `signrawtransaction` works on mempool UTXOs
- **Currency UTXOs (vETH, tokens): CANNOT be signed unconfirmed** — returns "Input not found or already spent"
- Must wait for at least 1 confirmation (~1 minute) before signing non-VRSC UTXOs
- This only affects the funding TX → dedicated address step, not the user's original balance

### updateidentity
- **Must pass the FULL identity object** — not just the changed fields
- Sub-IDs (e.g. `user1.example@`) require `name`, `parent`, and all existing fields
- Using just `{ "name": "user1.example@", "primaryaddresses": [...] }` fails for sub-IDs
- Always: `getidentity` → spread full object → modify one field → `updateidentity`
- `sourceoffunds` (5th param) specifies which address pays the fee
- Without it, the daemon grabs fee UTXOs from any wallet address

### Identity Name Formats
- `getidentity` accepts: `"user1.example@"`, `"user1.example.VRSC@"`, i-address
- `updateidentity` with full object: use short `name` field (e.g. `"player1"`) + `parent` i-address
- Using `fullyqualifiedname` (e.g. `"user1.example.VRSC@"`) as `name` field causes "not found" error
- `createrawtransaction` outputs: must use i-address or R-address, not friendly names

### contentmultimap
- `updateidentity` **replaces the entire contentmultimap** — must read-merge-write
- Always: read existing → modify specific key → write back ALL keys
- Supports arrays per key: `{ "vdxfkey": ["hex1", "hex2"] }`
- Values are hex-encoded strings, decode with `Buffer.from(hex, 'hex').toString('utf8')`
- VDXF keys must be valid i-addresses — arbitrary strings like `"test"` cause "Invalid JSON ID parameter"

## Transaction Classification (Activity Tab)

### Type Detection
- **Sent:** `weAreSpending && !hasReservetransfer`
- **Received:** `!weAreSpending` (default)
- **Swap Out:** `weAreSpending && vout has reservetransfer`
- **Swap In:** `!weAreSpending && all vin addresses empty (system payout) && (hasCurrencyToUs || vrscToUs > 0)`
- **ID Update:** `vout has identityprimary`
- **ID Revoke:** `vout has identityrevoke`
- **ID Recover:** `vout has identityrecover`

### Currency in Transactions
- Currency amounts are in `vout.scriptPubKey.reserve_balance` (e.g. `{ "vETH": 0.001 }`)
- When we're the spender, currency on OUR vout is just change — don't count it
- When we're NOT the spender, don't count currency on OTHER people's vouts (it's their change)
- For system txs (`allVinEmpty`), only count currency that came TO us
- Currency names in `reserve_balance` are i-addresses — resolve via `currencynames` from `getaddressbalance`

### Coinbase vs System Payouts
- Coinbase txs: `vin[0]` has `"coinbase"` key — these are mining/staking rewards
- System payouts (conversion results): all vins have NO address AND no `"coinbase"` key
- `allVinEmpty = vin.every(v => !v.address && !('coinbase' in v))` — only true for system payouts

## VerusSub Subscriptions

### VDXF Keys
- `i8iZrgfNEB5c8oEGENRC9B5Cv8Agvv3mqv` — veruspay.vrsc::subscription.terms (on provider)
- `iCvwWogVjiNCbiKVE38t88MEqFVFfDrjYY` — veruspay.vrsc::subscription.active (on subscriber)

### Multi-Subscription Array
- Multiple subscriptions stored as array entries under one VDXF key
- Each entry is hex-encoded JSON with `providerId` for filtering
- Subscribe: filter out same provider → append new entry
- Cancel: filter out matching provider → keep others
- If array becomes empty, delete the key entirely

### Non-VRSC Currency Subscriptions
- Funding: interleave currency + VRSC fee outputs (currency at even vouts, VRSC at odd)
- Each period needs: 1 currency UTXO + 1 VRSC dust UTXO (0.0002 VRSC for broadcast fee)
- Time-locked TX spends TWO inputs: currency vout (i*2) + fee vout (i*2+1)
- Output format: `{ paymentIAddress: { currencyIAddress: amount } }`
- Must wait for funding confirmation before signing (currency UTXOs only)
- Total VRSC needed: TX fees (~0.0001 per period) + broadcast fees (0.0002 per period)

### Access Calculation
- `accessUntilBlock = startBlock + (broadcastPeriods × intervalBlocks)`
- Calculated from `startBlock` (subscription creation), NOT from broadcast time
- This ensures full paid duration even if all TXs broadcast at once due to delay

### Dedicated Address
- Generated fresh for each subscription via `getnewaddress`
- Named "Subscription - {provider}" and pinned in account selector
- Only generate on final confirm click (not on Continue/Review)
- Cancel = sweep remaining UTXOs back to subscriber's primary address

## Chrome Extension

### Side Panel vs Popup
- `openPanelOnActionClick: true` makes icon click open side panel
- `sidePanel.open({ windowId })` can programmatically open it but doesn't refresh if already open
- `chrome.windows.create` works but opens as a tab — `sender.tab` is set, which triggers the security sender check
- Current approach: side panel + 2-second polling for pending items

### Sender Verification
- `sender.tab` is set for content scripts AND `chrome.windows.create` popup windows
- `!sender.tab && sender.id === chrome.runtime.id` = extension popup/side panel (not content script)
- Content scripts can only send `PAGE_REQUEST` messages
- All other message types require passing the sender check

### Balance Display
- `getaddressbalance` returns `currencybalance` with i-address keys, `currencynames` for mapping
- For non-VRSC max button: don't deduct fee (fee is paid in VRSC, not in the token)
- For VRSC max button: deduct 0.0001 for send, 0.0002 for swap (conversion fees)

## Security

### Password Per Transaction
- Send requires password re-entry (toggleable in settings)
- Disabling password protection requires entering the password first
- Swap does NOT require password (funds stay in user's control)
- Subscription requires password

### RPC Allowlist
- Only methods in `READ_ONLY` or `APPROVAL_REQUIRED` sets can be called from web pages
- `dumpprivkey`, `z_exportkey` etc. are NOT in either set — completely blocked
- `updateidentity`, `signRawTransaction`, `executeSubscription`, `cancelSubscription` require approval
- `signdata` is internal only (called by login handler, not exposed to pages)
