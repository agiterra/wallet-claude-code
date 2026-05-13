#!/usr/bin/env bun
/**
 * @agiterra/wallet-claude-code — CC plugin server.
 *
 * Stdio MCP server. Exposes wallet decision tools (approve / refuse /
 * reject_with_error) that publish JWT-signed wallet.sign.response
 * messages directed at the wallet-vault Wire integration.
 *
 * Identity: this MCP server runs as the current Claude Code agent
 * (e.g. fondant) — it uses AGENT_ID + AGENT_PRIVATE_KEY + WIRE_URL from
 * the environment (set by ~/.wire/cc-launch.sh). No separate identity.
 *
 * Incoming wallet.sign.request events are surfaced to the agent's
 * conversation by the wire plugin's existing channel-notification path
 * (see `<channel topic="wallet.sign.request" ...>` system reminders).
 * This plugin does NOT open its own SSE connection — it just provides
 * the ergonomic outbound surface so the agent can decide via tool calls
 * instead of hand-crafting JWT-signed HTTP requests.
 *
 * v0.2.0:
 *   - wallet_approve(request_id)
 *   - wallet_refuse(request_id, reason?)
 *   - wallet_reject_with_error(request_id, code, message, data?)
 *
 * v0.3+ (deferred):
 *   - wallet_subscribe / wallet_pending_requests / wallet_get_request —
 *     reintroduced once the plugin owns a SSE connection or queries
 *     Wire's /messages endpoint for state.
 *   - Vault management: wallet_create / wallet_list / wallet_use /
 *     wallet_import — round-trip via wallet.vault.* topics to the
 *     extension.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WALLET_SIGN_RESPONSE } from "@agiterra/wallet-tools";
import { createAuthJwt, importKeyPair } from "@agiterra/wire-tools/crypto";

const WALLET_VAULT_DEST = "wallet-vault";

// ----- Wire publish helper -----

interface SignResponseApprove { request_id: string; action: "approve" }
interface SignResponseRefuse  { request_id: string; action: "refuse"; reason?: string }
interface SignResponseReject  { request_id: string; action: "reject_with_error"; code: number; message: string; data?: unknown }
type SignResponse = SignResponseApprove | SignResponseRefuse | SignResponseReject;

let cachedPrivateKey: CryptoKey | null = null;

async function getPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const b64 = process.env.AGENT_PRIVATE_KEY;
  if (!b64) throw new Error("AGENT_PRIVATE_KEY env var not set");
  const { privateKey } = await importKeyPair(b64);
  cachedPrivateKey = privateKey;
  return privateKey;
}

async function publishSignResponse(payload: SignResponse): Promise<{ seq: number }> {
  const url = process.env.WIRE_URL;
  const agentId = process.env.AGENT_ID;
  if (!url) throw new Error("WIRE_URL env var not set");
  if (!agentId) throw new Error("AGENT_ID env var not set");
  const privateKey = await getPrivateKey();
  const body = JSON.stringify(payload);
  const token = await createAuthJwt(privateKey, agentId, body);
  const endpoint = `${url}/webhooks/${WALLET_VAULT_DEST}/${WALLET_SIGN_RESPONSE}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire publish failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as { seq: number };
}

// ----- MCP server -----

const server = new Server(
  { name: "wallet", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wallet_approve",
      description:
        "Approve a pending wallet.sign.request. The wallet-vault extension will sign with its vault key and return the signed payload to the dApp. Pass the request_id from the incoming wallet.sign.request channel event.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: {
            type: "string",
            description: "request_id from the incoming wallet.sign.request channel event.",
          },
        },
        required: ["request_id"],
      },
    },
    {
      name: "wallet_refuse",
      description:
        "Refuse a pending wallet.sign.request. The dApp receives a standard EIP-1193 4001 \"User rejected the request.\" error. The reason (optional) is recorded in the response's data field for audit but is not surfaced to the dApp.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          reason: {
            type: "string",
            description: "Optional audit reason. Stored in data.reason; dApp sees only the 4001 sentinel.",
          },
        },
        required: ["request_id"],
      },
    },
    {
      name: "wallet_reject_with_error",
      description:
        "Reject a pending wallet.sign.request with a custom JSON-RPC error code + message. Use this to test dApp handling of non-standard wallet errors (e.g. -32603 internal, -32000 server error).",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          code: { type: "number", description: "JSON-RPC error code (e.g. -32603)." },
          message: { type: "string", description: "JSON-RPC error message." },
          data: {
            description: "Optional structured data passed back in the error's data field.",
          },
        },
        required: ["request_id", "code", "message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "wallet_approve": {
      const rid = String(args.request_id ?? "").trim();
      if (!rid) throw new Error("request_id required");
      const { seq } = await publishSignResponse({ request_id: rid, action: "approve" });
      return {
        content: [{ type: "text", text: `Approved ${rid} (Wire seq ${seq}).` }],
      };
    }
    case "wallet_refuse": {
      const rid = String(args.request_id ?? "").trim();
      if (!rid) throw new Error("request_id required");
      const reason = args.reason ? String(args.reason) : undefined;
      const { seq } = await publishSignResponse({
        request_id: rid,
        action: "refuse",
        ...(reason ? { reason } : {}),
      });
      return {
        content: [{ type: "text", text: `Refused ${rid} (Wire seq ${seq})${reason ? ` — reason: ${reason}` : ""}.` }],
      };
    }
    case "wallet_reject_with_error": {
      const rid = String(args.request_id ?? "").trim();
      if (!rid) throw new Error("request_id required");
      const code = Number(args.code);
      if (!Number.isFinite(code)) throw new Error("code must be a number");
      const message = String(args.message ?? "");
      if (!message) throw new Error("message required");
      const data = args.data;
      const { seq } = await publishSignResponse({
        request_id: rid,
        action: "reject_with_error",
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      });
      return {
        content: [{ type: "text", text: `Rejected ${rid} with code ${code} (Wire seq ${seq}): ${message}` }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ----- Boot -----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[wallet] MCP server connected (v0.2.0)");
}

main().catch((e) => {
  console.error("[wallet] fatal:", e);
  process.exit(1);
});
