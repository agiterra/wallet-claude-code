# @agiterra/wallet-claude-code

Claude Code plugin for the agent wallet system. Loads as a CC plugin
in any agent that needs to drive a wallet-bound browser session.

Two surfaces:

1. **MCP tools** for agents to make decisions per sign request and
   manage the vault.
2. **Channel handler** for the `wallet.sign.request` Wire topic —
   incoming sign requests appear as conversation events.

## Design

See [agiterra/architecture/agent-wallet-extension.md](https://github.com/agiterra/architecture/blob/main/agent-wallet-extension.md).

## MCP tool surface (v0.1.0)

- `wallet_subscribe({wallet_address})` — start listening for sign
  requests targeted at this wallet.
- `wallet_unsubscribe({wallet_address})`
- `wallet_approve({request_id})` — sign as requested.
- `wallet_refuse({request_id, reason?})` — return 4001 user_rejected.
- `wallet_reject_with_error({request_id, code, message})` — custom JSON-RPC error.
- `wallet_pending_requests({wallet_address?})` — list outstanding requests.
- `wallet_get_request({request_id})` — full details for a specific request.

v0.2 adds `wallet_create`, `wallet_list`, `wallet_use`, history tools,
and `wallet_approve_with_override`. v0.5 adds Playwright test integration.

## Status

v0.1.0 — scaffolding. MCP server boots and exposes the tool surface,
but the Wire channel handler is a stub. Implementation lands alongside
wallet-extension v0.2 when WireDecider ships.
