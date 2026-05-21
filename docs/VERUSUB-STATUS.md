# VerusSub — Current Status & Known Issues

## What Works

### VRSC Subscriptions (fully working)
1. Website calls `window.verus.subscribe({ provider: 'provider-a.example@', subscriberId: 'user1.example@' })`
2. Wallet shows approval screen with plan details, cost, pay-from selector
3. User confirms with password
4. Dedicated address generated, named "Subscription - provider", pinned
5. N UTXOs funded via `sendcurrency`
6. N time-locked TXs created and signed immediately (no confirmation wait needed for VRSC)
7. Payload stored on subscriber's contentmultimap
8. Server reads contentmultimap, broadcasts TXs as locktimes reached
9. Website polls server, shows "Premium Content Unlocked"

### Multi-provider support
- Multiple subscriptions stored as array under one VDXF key
- Each entry has `providerId` for filtering
- Cancel removes only matching provider
- Server supports any provider (not hardcoded)

### Access calculation
- `accessUntilBlock = startBlock + (broadcastPeriods × intervalBlocks)`
- Calculated from startBlock, not broadcast time — fixes delay issue

## What's Broken — Non-VRSC Currency Subscriptions (vETH)

### The Pipeline Difference
**VRSC:**
1. Fund UTXOs → get txid
2. Sign time-locked TXs immediately (VRSC UTXOs can be signed unconfirmed)
3. Store on contentmultimap
4. Done in ~5 seconds

**Non-VRSC (vETH, tokens):**
1. Fund UTXOs (interleaved: currency at even vouts, VRSC fee at odd vouts)
2. **MUST wait for funding TX to confirm** (~1-2 minutes) — currency UTXOs CANNOT be signed unconfirmed
3. Sign time-locked TXs (each spends 2 inputs: currency vout + VRSC fee vout)
4. **MUST wait for any prior identity update to confirm** before storing new one
5. Store on contentmultimap
6. Total time: ~3-5 minutes

### Known Bugs for Non-VRSC

#### Bug 1: Payment amount deduction
- **Fixed**: For non-VRSC, full currency amount goes to provider (fee is VRSC, not currency)
- `payment = planCurrency === 'VRSC' ? plan.amount - 0.0001 : plan.amount`

#### Bug 2: Funding outputs need currency specified
- **Fixed**: `{ address, amount, currency: 'vETH' }` for currency outputs
- Plus `{ address, amount: 0.0001 }` VRSC dust per period for broadcast fees

#### Bug 3: createrawtransaction needs i-address, not friendly name
- **Fixed**: Resolve `paymentAddress` via `getidentity` → `identityaddress`
- Resolve currency name via `getcurrency` → `currencyid`
- Output format: `{ iAddress: { currencyId: amount } }`

#### Bug 4: Two inputs per time-locked TX
- **Fixed**: Each period's TX spends: `vout[i*2]` (currency) + `vout[i*2+1]` (VRSC fee)

#### Bug 5: "Invalid JSON ID parameter" on updateidentity
- **NOT FIXED**: Likely caused by trying to `updateidentity` while a prior identity update is still unconfirmed
- The daemon can't process two identity updates for the same identity in the same block
- Need to wait for prior identity operations to confirm before storing subscription
- Also possible: the combined payload (hustle + joe) exceeded some limit, OR the `hexToUtf8` filter threw on a malformed entry

#### Bug 6: Progress UI disconnected from reality
- **Partially fixed**: Progress now shows "Waiting for block confirmation..." for non-VRSC
- But the progress animation is still time-based, not event-based
- Ideally: background should send progress events to the UI

### What Needs Testing
1. Clean test: clear player1 contentmultimap (done), wait for confirm, then subscribe to provider-b.example@ (vETH)
2. Verify the full pipeline: fund → wait confirm → sign → wait confirm → store
3. Test that the server picks up the vETH subscription and broadcasts

## Website Issues (example.com/demo/)

### Fixed
- Two merchant panels (hustle VRSC + joe vETH) side by side
- Per-plan subscribe buttons with correct provider
- Login persistence in localStorage
- Session per merchant panel
- Wallet detection via MutationObserver
- MutationObserver no longer overwrites merchantSubscribe onclick handlers
- Subscription polling until active

### Server (.59)
- Multi-provider support in `readSubscription` and `pollSubscribers`
- Access calculated from startBlock
- Server at `/opt/verus-demos/server.js`, port 8080, proxied via nginx
- Needs manual restart: `cd /opt/verus-demos && nohup node server.js > /tmp/verus-demos.log 2>&1 &`
- Server crashes sometimes after broadcast loop — needs investigation

## Architecture Notes

### VDXF Keys
- `i8iZrgfNEB5c8oEGENRC9B5Cv8Agvv3mqv` — subscription.terms (on provider)
- `iCvwWogVjiNCbiKVE38t88MEqFVFfDrjYY` — subscription.active (on subscriber)

### Provider Terms (on-chain)
```json
{
  "version": 1,
  "plans": [{
    "planId": "demo-veth",
    "label": "vETH Demo Plan",
    "amount": 0.0001,
    "currency": "vETH",
    "intervalBlocks": 5,
    "periods": 5,
    "paymentAddress": "provider-b.example@"
  }]
}
```

### Subscription Payload (on subscriber's identity)
```json
{
  "version": 1,
  "providerId": "provider-b.example@",
  "subscriberId": "user1.example@",
  "dedicatedAddress": "Rxxxx...",
  "fundingTxid": "abcd...",
  "startBlock": 4000000,
  "intervalBlocks": 5,
  "totalPeriods": 5,
  "paymentAmount": 0.0001,
  "currency": "vETH",
  "transactions": [
    { "period": 1, "lockTime": 0, "rawTx": "04000080..." },
    { "period": 2, "lockTime": 4000010, "rawTx": "04000080..." }
  ]
}
```

### Funding Structure for Non-VRSC
```
sendcurrency outputs:
  vout[0]: 0.0001 vETH → dedicated (period 1 currency)
  vout[1]: 0.0001 VRSC → dedicated (period 1 broadcast fee)
  vout[2]: 0.0001 vETH → dedicated (period 2 currency)
  vout[3]: 0.0001 VRSC → dedicated (period 2 broadcast fee)
  ...
  vout[8]: 0.0001 vETH → dedicated (period 5 currency)
  vout[9]: 0.0001 VRSC → dedicated (period 5 broadcast fee)
  vout[10]: change → fromAddr

Time-locked TX for period N spends:
  input[0]: fundingTxid vout[N*2]     (currency)
  input[1]: fundingTxid vout[N*2+1]   (VRSC fee)
  output: { paymentIAddress: { currencyIAddress: amount } }
```

### Key Code Locations
- `src/background/sw.ts` lines 251-470: subscribe + executeSubscription + cancelSubscription handlers
- `src/popup/screens/SubscriptionApprovalScreen.tsx`: approval UI
- `src/popup/App.tsx` lines 52-100: polling for pending subscriptions
- `src/content/inpage.ts` lines 67-72: subscribe/cancelSubscription API

### Test Identities
- **provider-a.example@**: VRSC subscription provider (terms set, working)
- **provider-b.example@**: vETH subscription provider (terms set, needs testing)
- **user1.example@**: test subscriber (contentmultimap cleared, ready for clean test)
- **user2.example@**: previously tested subscriber (has old hustle subscription)

### Critical Daemon Behaviors
1. VRSC UTXOs can be signed unconfirmed; currency UTXOs CANNOT
2. `updateidentity` fails if a prior identity update for the same identity is unconfirmed
3. `createrawtransaction` currency outputs need i-address keys, not names
4. `sendcurrency` from a specific address only uses UTXOs at that address
5. Each `sendcurrency` output with `currency` field creates a separate 0-sat UTXO with reserve_balance
6. Network fee is 0.0001 VRSC per transaction

## TODO Next Session
1. Wait for player1 contentmultimap cleanup to confirm
2. Test provider-b.example@ vETH subscription end-to-end (clean)
3. Add wait-for-prior-identity-update logic before storing subscription
4. Test concurrent VRSC + vETH subscriptions
5. Fix server auto-restart (systemd service or pm2)
6. Dev documentation with full replication steps
7. Subscription management UI in wallet (view active, cancel)
