# wallet

> Give your agent an Ethereum wallet they can sign with — under operator-controlled access. Decisions never bypass review.

## What this gets you

- **Your agent can hold + use crypto wallets** with operator-granted permissions
- **Sign decisions are explicit** — every sign request comes with a `wallet_approve` / `wallet_refuse` / `wallet_reject_with_error` choice. No auto-approve policies, ever.
- **Vault management built in** — operator can grant agents access to specific wallets or set creator-only / specific / all access modes
- **Pairs with the wallet browser extension** for full agentic dApp interactions (eth_signTransaction, eth_signTypedData_v4, Seaport orders)

This is how Agiterra agents do things like buy property NFTs, list assets for sale, mint tokens, or transact on-chain — under your supervision.

## Quick setup

```
/plugin install wallet-claude-code@agiterra
```

Then, in tandem, install the Agiterra wallet browser extension and configure it with your Wire URL.

For the full agentic flow (buying, signing, listing), see [agiterra/wallet-extension](https://github.com/agiterra/wallet-extension).

## Quick example

Operator grants your agent access to a wallet:

```
register_agent({id: 'eclair', ...})
# operator uses dashboard or wallet vault MCP to grant the wallet to this agent
```

Your agent gets a sign request via Wire — e.g. a dApp wants them to sign a Seaport order to buy a property NFT.

Your agent reviews the request and calls:

```
wallet_approve({request_id: 'abc123'})    # → extension signs and broadcasts
# or
wallet_refuse({request_id: 'abc123', reason: 'price too high'})
# or
wallet_reject_with_error({request_id: 'abc123', code: -32000, message: 'invalid input'})
```

## For the agent

Tools exposed:

| Tool | What it does |
|---|---|
| `wallet_approve` | Approve a pending sign request (the extension signs with the wallet key) |
| `wallet_refuse` | Decline a sign request — returns a 4001 user_rejected JSON-RPC error |
| `wallet_reject_with_error` | Custom JSON-RPC error response |

Future tools (in progress): `wallet_create`, `wallet_list`, `wallet_use`, vault management.

Sign requests arrive via the `wallet.sign.request` Wire channel. Read the request carefully — what's being signed, what value, what to/from — before approving.

## Hard rules

- **NEVER auto-approve.** Every sign request requires an explicit decision from the agent. Auto-approve policies are not implemented and will not be.
- **Extension handles deterministic queries locally** (eth_chainId, eth_accounts, etc.). Only judgment-requiring calls (signing) go through the agent.

## Reference

| Var | Default | Description |
|---|---|---|
| `WIRE_URL` | `http://localhost:9800` | Wire server base URL |
| `AGENT_ID` | (required) | This agent's identity on Wire |
| `AGENT_PRIVATE_KEY` | (required) | Ed25519 private key for signing |

## Concepts

- [Identity model](https://github.com/agiterra/handbook/blob/main/CORE.md#1-agent-identities-personai-vs-ephemeral)

## Related plugins

- [`wire`](https://github.com/agiterra/wire-claude-code) and [`wire-ipc`](https://github.com/agiterra/wire-ipc-claude-code) — required (sign requests routed via Wire)
- [agiterra/wallet-extension](https://github.com/agiterra/wallet-extension) — the browser extension that holds the keys and signs

## License

MIT.

## Two traps every browser-driven lane hits

Both found the hard way by `eng-3586-transfer` on ENG-3586 (2026-09-22), each costing a run.

### 1. `wallet_send` reaches the SHARED vault only

`wallet_send` has no `vault_id` and always dispatches to `wallet-vault`. A wallet created in a
**per-lane** vault (`wallet_create`/`wallet_list` with `vault_id: 'wallet-vault-<lane>'`) is
invisible to it and fails:

```
{"source":"wallet-vault","topic":"wallet.sign.result",
 "payload":{"error":{"code":4100,"message":"no wallet 0x… in this vault's directory"}}}
```

⚠️ **Read the `source`, not just the error.** It says `wallet-vault`, not
`wallet-vault-<lane>` — that is how you know it was routed to the default vault rather than that
your wallet is missing.

The two vaults are different machines, not two copies of one:

| vault | signs how | reach it with |
|---|---|---|
| `wallet-vault` (shared) | service-side, autonomous | `wallet_send`, `wallet_deploy` |
| `wallet-vault-<lane>` (per-lane) | browser/extension, needs approval | `wallet_use` + `window.ethereum` + `wallet_approve` |

So for a per-lane wallet, drive it through the page:
`wallet_use(tab_id, wallet, vault_id)` → `window.ethereum.request(...)` → `wallet_approve(request_id, vault_id)`.

### 2. The browser request must be fired NON-BLOCKING

`await window.ethereum.request(...)` inside a single `browser_evaluate` **blocks the tool call**,
so you cannot call `wallet_approve` until it returns — and it never returns, because it is waiting
for the approval you are unable to send:

```
Decider error: WireDecider timeout after 60000ms (no wallet.sign.response for …)   (code -32603)
```

⇒ Dispatch, return immediately, approve, then read the result in a **second** evaluate:

```js
// evaluate #1 — returns at once
window.__r = { pending: true };
window.ethereum.request({ method: 'eth_sendTransaction', params: [{ to, value }] })
  .then(v => window.__r = { value: v }).catch(e => window.__r = { error: String(e) });
return 'dispatched';
```

then `wallet_approve(request_id, vault_id)`, then evaluate #2 reading `window.__r`.

★ The deadlock is structural, not a timing fluke: **the approval and the request cannot share one
synchronous tool call**, because the tool call is the thing that would carry the approval.
