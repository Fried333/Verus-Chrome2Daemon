# Security Policy

## Reporting a Vulnerability

If you discover a security issue in Verus-Chrome2Daemon, **do not open a public
GitHub issue**. Instead, email the maintainer at `fried333@proton.me` with:

- A description of the issue and its impact
- Steps to reproduce
- Any proof-of-concept code

You should expect an acknowledgement within 5 business days. Fixes for
high-severity issues are typically released within 14 days.

## Threat Model

This extension talks to a **local Verus daemon over JSON-RPC**. The trust
model assumes:

- The local daemon (`http://127.0.0.1:<rpcport>`) is trusted. If your machine
  is compromised, the wallet cannot protect you.
- RPC credentials live in `chrome.storage.local`. They are not encrypted at
  rest by this extension (Chrome encrypts the storage volume on most
  platforms). Anyone with read access to your Chrome profile can read them.
- The wallet password (PBKDF2-SHA256, 600k iterations) gates the in-memory
  unlock state. It is **not** a key for the on-chain private keys — those
  remain in your daemon's wallet.
- Web pages are untrusted. The page-callable API (`window.verus.*`) is gated
  by an allowlist; mutating methods require explicit user approval via the
  side panel.

## What is in scope

- Bypass of the user-approval flow for any mutating method
  (`sendCurrency`, `signMessage`, `updateIdentity`, `subscribe`,
  `cancelSubscription`).
- Confused-deputy attacks where the wallet is induced to act on a target
  the user did not intend (e.g. localhost SSRF, cross-origin authentication).
- Replay or forgery of the VerusID login envelope.
- Leaking of RPC credentials, wallet password hash, or identity data to a
  web page or another extension.
- Supply-chain issues in declared dependencies.

## What is out of scope

- Vulnerabilities in `verusd` itself (report to the Verus project).
- Physical access to an unlocked machine.
- Phishing where the user pastes their own seed/WIF into a hostile page
  (the wallet never asks for or handles seeds).
- Side-channel attacks on the user's OS or browser.
