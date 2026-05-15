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
