#!/usr/bin/env bun
/**
 * @agiterra/wallet-claude-code — CC plugin server.
 *
 * Stdio MCP server. Exposes wallet decision tools (approve / refuse /
 * etc.) and a channel handler for the wallet.sign.request Wire topic.
 *
 * v0.1.0 SCAFFOLDING: MCP server boots, advertises the tool surface,
 * and accepts calls. Tool implementations are stubs that log and
 * return ack-only responses. The Wire channel handler is a no-op until
 * wallet-extension v0.2 ships WireDecider.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  WALLET_SIGN_REQUEST,
  WALLET_SIGN_RESPONSE,
} from "@agiterra/wallet-tools";

// ----- MCP server -----

const server = new Server(
  {
    name: "wallet",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// In-memory tracking of pending sign requests for the current session.
// Real implementation will mirror Wire channel events into this map.
interface PendingRequest {
  request_id: string;
  wallet_address: string;
  method: string;
  origin: string;
  received_at: number;
  raw_event: Record<string, unknown>;
}
const pending = new Map<string, PendingRequest>();

// Subscribed wallets (by address). Real implementation registers a
// Wire channel filter; v0.1 just records intent.
const subscribed = new Set<string>();

// ----- Tool definitions -----

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wallet_subscribe",
      description:
        "Start listening for sign requests targeted at a specific wallet. Once subscribed, incoming wallet.sign.request channel events appear as conversation notifications. Subscribing to a wallet means this agent is willing to be a decider for it — the wallet's allowlist must include this agent's Wire pubkey for responses to be honored.",
      inputSchema: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "0x-prefixed Ethereum address of the wallet to subscribe to.",
          },
        },
        required: ["wallet_address"],
      },
    },
    {
      name: "wallet_unsubscribe",
      description: "Stop listening for sign requests on the given wallet address.",
      inputSchema: {
        type: "object",
        properties: {
          wallet_address: { type: "string" },
        },
        required: ["wallet_address"],
      },
    },
    {
      name: "wallet_approve",
      description:
        "Approve a pending sign request. The extension that originated the request will sign with its vault key and return the signed payload to the dApp.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: {
            type: "string",
            description: "The request_id from the incoming wallet.sign.request event.",
          },
        },
        required: ["request_id"],
      },
    },
    {
      name: "wallet_refuse",
      description:
        "Refuse a pending sign request. The dApp will receive a standard EIP-1193 4001 User rejected the request error. Use this to test dApp behavior under wallet rejection.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          reason: {
            type: "string",
            description: "Optional reason logged for audit; the dApp only sees the standard 4001.",
          },
        },
        required: ["request_id"],
      },
    },
    {
      name: "wallet_reject_with_error",
      description:
        "Reject a sign request with a custom JSON-RPC error. The dApp receives the code + message you specify. Useful for testing dApp handling of non-standard wallet errors.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          code: { type: "number", description: "JSON-RPC error code." },
          message: { type: "string", description: "JSON-RPC error message." },
        },
        required: ["request_id", "code", "message"],
      },
    },
    {
      name: "wallet_pending_requests",
      description:
        "List all currently-pending sign requests this agent has received but not yet responded to.",
      inputSchema: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "Optional: filter to requests for a specific wallet.",
          },
        },
      },
    },
    {
      name: "wallet_get_request",
      description: "Fetch full details for a specific pending sign request.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
        },
        required: ["request_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "wallet_subscribe": {
      const addr = String(args.wallet_address ?? "").toLowerCase();
      if (!addr) throw new Error("wallet_address required");
      subscribed.add(addr);
      return {
        content: [
          {
            type: "text",
            text: `Subscribed to ${addr}. (v0.1 stub: actual Wire channel registration lands in v0.2 with WireDecider.)`,
          },
        ],
      };
    }
    case "wallet_unsubscribe": {
      const addr = String(args.wallet_address ?? "").toLowerCase();
      subscribed.delete(addr);
      return { content: [{ type: "text", text: `Unsubscribed from ${addr}.` }] };
    }
    case "wallet_approve": {
      const rid = String(args.request_id ?? "");
      const req = pending.get(rid);
      if (!req) throw new Error(`No pending request with id ${rid}`);
      pending.delete(rid);
      // v0.1 stub: log + return ack. v0.2 publishes wallet.sign.response on Wire.
      console.error(`[wallet] (v0.1 stub) approve ${rid}; would publish ${WALLET_SIGN_RESPONSE}`);
      return { content: [{ type: "text", text: `Approved ${rid}. (stub)` }] };
    }
    case "wallet_refuse": {
      const rid = String(args.request_id ?? "");
      const reason = args.reason ? String(args.reason) : undefined;
      const req = pending.get(rid);
      if (!req) throw new Error(`No pending request with id ${rid}`);
      pending.delete(rid);
      console.error(`[wallet] (v0.1 stub) refuse ${rid} reason=${reason ?? "user_rejected"}`);
      return { content: [{ type: "text", text: `Refused ${rid}. (stub)` }] };
    }
    case "wallet_reject_with_error": {
      const rid = String(args.request_id ?? "");
      const code = Number(args.code ?? 0);
      const message = String(args.message ?? "");
      const req = pending.get(rid);
      if (!req) throw new Error(`No pending request with id ${rid}`);
      pending.delete(rid);
      console.error(`[wallet] (v0.1 stub) reject_with_error ${rid} ${code}: ${message}`);
      return { content: [{ type: "text", text: `Rejected ${rid} with code ${code}. (stub)` }] };
    }
    case "wallet_pending_requests": {
      const filter = args.wallet_address ? String(args.wallet_address).toLowerCase() : null;
      const list = [...pending.values()].filter(
        (p) => !filter || p.wallet_address.toLowerCase() === filter,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    }
    case "wallet_get_request": {
      const rid = String(args.request_id ?? "");
      const req = pending.get(rid);
      if (!req) throw new Error(`No pending request with id ${rid}`);
      return { content: [{ type: "text", text: JSON.stringify(req, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ----- Wire channel handler (stub) -----

// v0.2 wires this up via WireConnection.registerChannel(WALLET_SIGN_REQUEST, ...).
// Each incoming wallet.sign.request event is filtered by subscribed
// wallets and dropped into the agent's conversation as a notification
// + recorded in `pending` for the approve/refuse tools to reference.
void WALLET_SIGN_REQUEST; // referenced for future use

// ----- Boot -----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[wallet] MCP server connected (v0.1.0 scaffolding)");
}

main().catch((e) => {
  console.error("[wallet] fatal:", e);
  process.exit(1);
});
