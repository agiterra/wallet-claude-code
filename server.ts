#!/usr/bin/env bun
/**
 * @agiterra/wallet-claude-code — CC plugin server.
 *
 * Stdio MCP server. Two surfaces:
 *
 *   1. Sign-decision tools (v0.2.0): wallet_approve / wallet_refuse /
 *      wallet_reject_with_error — JWT-signed publish of wallet.sign.response
 *      directed at the wallet-vault Wire integration.
 *
 *   2. Vault management tools (v0.3.0): wallet_list / wallet_use /
 *      wallet_grant / wallet_revoke / wallet_set_access_mode — read
 *      and (operator-only for grant/revoke/mode) edit the wallet
 *      directory stored in Wire's plugin_settings (namespace="wallet-vault",
 *      key="wallets"). wallet_use publishes a tab-claim so subsequent
 *      sign requests originating in that browser tab route to the
 *      calling agent.
 *
 * Identity: this MCP server runs as the current Claude Code agent
 * (AGENT_ID + AGENT_PRIVATE_KEY + WIRE_URL from env, set by
 * ~/.wire/cc-launch.sh). Operator-gated tools additionally require
 * WIRE_DASHBOARD_TOKEN in env.
 *
 * Deferred to v0.3.x: wallet_create / wallet_rename — these need a
 * round-trip channel handler in the extension that publishes back the
 * new wallet's address. The MCP server doesn't own its own SSE
 * subscription yet, so the tool can't easily await the response.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  WALLET_SIGN_RESPONSE,
  WALLET_VAULT_TAB_CLAIM,
  WALLET_VAULT_CREATE_REQUEST,
} from "@agiterra/wallet-tools";
import type {
  WalletAccessMode,
  WalletDirectory,
  WalletMeta,
} from "@agiterra/wallet-tools";
import { createAuthJwt, importKeyPair } from "@agiterra/wire-tools/crypto";

const WALLET_VAULT_DEST = "wallet-vault";
const WALLET_VAULT_NAMESPACE = "wallet-vault";
const WALLETS_KEY = "wallets";

// ----- Env helpers -----

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var not set`);
  return v;
}

let cachedPrivateKey: CryptoKey | null = null;

async function getPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const { privateKey } = await importKeyPair(requireEnv("AGENT_PRIVATE_KEY"));
  cachedPrivateKey = privateKey;
  return privateKey;
}

function operatorToken(): string {
  const t = process.env.WIRE_DASHBOARD_TOKEN;
  if (!t) {
    throw new Error(
      "WIRE_DASHBOARD_TOKEN env var not set — this tool requires operator credentials. " +
      "Add WIRE_DASHBOARD_TOKEN to your shell environment to enable operator-gated wallet management tools.",
    );
  }
  return t;
}

// ----- Wire publish helpers -----

async function jwtHeaders(body: string): Promise<Record<string, string>> {
  const privateKey = await getPrivateKey();
  const token = await createAuthJwt(privateKey, requireEnv("AGENT_ID"), body);
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function publishDirected(topic: string, payload: unknown): Promise<{ seq: number }> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const body = JSON.stringify(payload);
  const res = await fetch(`${url}/webhooks/${WALLET_VAULT_DEST}/${topic}`, {
    method: "POST",
    headers: await jwtHeaders(body),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire publish failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as { seq: number };
}

// ----- plugin_settings read / write -----

async function readDirectory(): Promise<WalletDirectory> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const res = await fetch(`${url}/plugin_settings/${WALLET_VAULT_NAMESPACE}/${WALLETS_KEY}`);
  if (res.status === 404) return {};
  if (!res.ok) {
    throw new Error(`plugin_settings GET failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { value?: WalletDirectory };
  return body.value ?? {};
}

async function writeDirectoryAsOperator(directory: WalletDirectory): Promise<void> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const token = operatorToken();
  const body = JSON.stringify({ value: directory });
  const res = await fetch(`${url}/plugin_settings/${WALLET_VAULT_NAMESPACE}/${WALLETS_KEY}?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`plugin_settings PUT failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
}

// ----- Access helpers -----

function callerAccessibleWallets(dir: WalletDirectory, callerAgentId: string): WalletDirectory {
  const out: WalletDirectory = {};
  for (const addr of Object.keys(dir)) {
    const meta = dir[addr]!;
    if (meta.access.mode === "all" || meta.access.agents.includes(callerAgentId)) {
      out[addr] = meta;
    }
  }
  return out;
}

function findWalletByNameOrAddress(
  dir: WalletDirectory,
  nameOrAddress: string,
): { address: string; meta: WalletMeta } | null {
  const lower = nameOrAddress.toLowerCase();
  if (dir[lower]) return { address: lower, meta: dir[lower] };
  // Fuzzy name match: exact (case-insensitive) on name or operator_name.
  for (const addr of Object.keys(dir)) {
    const meta = dir[addr]!;
    if (meta.name.toLowerCase() === lower) return { address: addr, meta };
    if (meta.operator_name && meta.operator_name.toLowerCase() === lower) return { address: addr, meta };
  }
  return null;
}

// ----- Sign-response publish (kept from v0.2.0) -----

interface SignResponseApprove { request_id: string; action: "approve" }
interface SignResponseRefuse  { request_id: string; action: "refuse"; reason?: string }
interface SignResponseReject  { request_id: string; action: "reject_with_error"; code: number; message: string; data?: unknown }
type SignResponse = SignResponseApprove | SignResponseRefuse | SignResponseReject;

async function publishSignResponse(payload: SignResponse): Promise<{ seq: number }> {
  return publishDirected(WALLET_SIGN_RESPONSE, payload);
}

// ----- MCP server -----

const server = new Server(
  { name: "wallet", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ---- Sign-decision tools (v0.2 surface) ----
    {
      name: "wallet_approve",
      description:
        "Approve a pending wallet.sign.request. The wallet-vault extension will sign with its vault key and return the signed payload to the dApp. Pass the request_id from the incoming wallet.sign.request channel event.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "request_id from the incoming wallet.sign.request channel event." },
        },
        required: ["request_id"],
      },
    },
    {
      name: "wallet_refuse",
      description:
        "Refuse a pending wallet.sign.request. The dApp receives a standard EIP-1193 4001 \"User rejected the request.\" error. Optional reason rides in data for audit; dApp sees only the 4001 sentinel.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["request_id"],
      },
    },
    {
      name: "wallet_reject_with_error",
      description:
        "Reject a pending wallet.sign.request with a custom JSON-RPC error code + message. Useful for testing dApp handling of non-standard wallet errors.",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          code: { type: "number" },
          message: { type: "string" },
          data: {},
        },
        required: ["request_id", "code", "message"],
      },
    },
    // ---- Vault tools (v0.3) ----
    {
      name: "wallet_create",
      description:
        "Provision a new EOA wallet. The extension generates a fresh secp256k1 keypair, stores the private key encrypted in its vault, registers the wallet in the directory under your agent_id as creator (mode='specific', access=[you]), and returns the new public address. The agent never sees the private key. Names must be unique per calling agent. Optional chain_id sets the default network (Sepolia 11155111 if omitted).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable wallet name (per-agent unique)." },
          chain_id: { type: "number", description: "Default chain (e.g. 11155111 for Sepolia)." },
        },
        required: ["name"],
      },
    },
    {
      name: "wallet_list",
      description:
        "List the wallets this agent has access to. Returns name, address, chain_id, creator, and access mode for each. Wallets where the caller isn't in the access list (and the mode isn't 'all') are omitted.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "wallet_use",
      description:
        "Bind a wallet to a browser tab. Subsequent EIP-1193 sign requests originating in that tab will be routed to the calling agent for approval. The agent must have access to the wallet (be in its access list, or the wallet must be mode:'all'). Pass `tab_id` from the tool you used to open the tab (e.g. Chrome MCP tabs_create_mcp). The wallet may be referenced by name (case-insensitive) or 0x-address.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "string", description: "Browser tab identifier (e.g. Chrome MCP tabId stringified)." },
          wallet: { type: "string", description: "Wallet name or 0x-address." },
        },
        required: ["tab_id", "wallet"],
      },
    },
    {
      name: "wallet_grant",
      description:
        "OPERATOR ONLY. Grant an agent access to a wallet. Adds the agent to the wallet's access list. If the wallet was mode:'creator-only', it switches to mode:'specific'. Requires WIRE_DASHBOARD_TOKEN in env.",
      inputSchema: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Wallet name or address." },
          agent_id: { type: "string", description: "Agent to grant access to." },
        },
        required: ["wallet", "agent_id"],
      },
    },
    {
      name: "wallet_revoke",
      description:
        "OPERATOR ONLY. Revoke an agent's access to a wallet. Requires WIRE_DASHBOARD_TOKEN in env.",
      inputSchema: {
        type: "object",
        properties: {
          wallet: { type: "string" },
          agent_id: { type: "string" },
        },
        required: ["wallet", "agent_id"],
      },
    },
    {
      name: "wallet_set_access_mode",
      description:
        "OPERATOR ONLY. Change a wallet's access mode. 'creator-only' = only the creator agent; 'specific' = only listed agents (use wallet_grant/revoke to manage the list); 'all' = any registered Wire agent. Requires WIRE_DASHBOARD_TOKEN in env.",
      inputSchema: {
        type: "object",
        properties: {
          wallet: { type: "string" },
          mode: { type: "string", enum: ["creator-only", "specific", "all"] },
        },
        required: ["wallet", "mode"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const callerAgentId = requireEnv("AGENT_ID");

  switch (name) {
    // ---- Sign decisions ----
    case "wallet_approve": {
      const rid = String(args.request_id ?? "").trim();
      if (!rid) throw new Error("request_id required");
      const { seq } = await publishSignResponse({ request_id: rid, action: "approve" });
      return { content: [{ type: "text", text: `Approved ${rid} (Wire seq ${seq}).` }] };
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
      return { content: [{ type: "text", text: `Refused ${rid} (Wire seq ${seq})${reason ? ` — reason: ${reason}` : ""}.` }] };
    }
    case "wallet_reject_with_error": {
      const rid = String(args.request_id ?? "").trim();
      if (!rid) throw new Error("request_id required");
      const code = Number(args.code);
      if (!Number.isFinite(code)) throw new Error("code must be a number");
      const message = String(args.message ?? "");
      if (!message) throw new Error("message required");
      const { seq } = await publishSignResponse({
        request_id: rid,
        action: "reject_with_error",
        code,
        message,
        ...(args.data !== undefined ? { data: args.data } : {}),
      });
      return { content: [{ type: "text", text: `Rejected ${rid} with code ${code} (Wire seq ${seq}): ${message}` }] };
    }

    // ---- Vault provisioning ----
    case "wallet_create": {
      const walletName = String(args.name ?? "").trim();
      if (!walletName) throw new Error("name required");
      const chainId = args.chain_id != null ? Number(args.chain_id) : undefined;
      if (chainId != null && !Number.isFinite(chainId)) throw new Error("chain_id must be a number");

      // Reject early if a wallet with this name already exists for this agent.
      const before = await readDirectory();
      for (const meta of Object.values(before)) {
        if (meta.creator === callerAgentId && (meta.name === walletName || meta.operator_name === walletName)) {
          throw new Error(`agent '${callerAgentId}' already has a wallet named '${walletName}'`);
        }
      }

      const requestId = crypto.randomUUID();
      await publishDirected(WALLET_VAULT_CREATE_REQUEST, {
        request_id: requestId,
        name: walletName,
        ...(chainId != null ? { chain_id: chainId } : {}),
      });

      // Poll plugin_settings for the new entry. Extension publishes
      // wallet.vault.created back to us (and the directory updates via
      // plugin_settings.updated), so the directory cache reflects the new
      // wallet within a few hundred ms of the extension finishing.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const current = await readDirectory();
        for (const [addr, meta] of Object.entries(current)) {
          if (before[addr]) continue;
          if (meta.creator !== callerAgentId) continue;
          if (meta.name !== walletName) continue;
          return {
            content: [{
              type: "text",
              text: `Created wallet '${walletName}' at ${addr} (chain ${meta.chain_id}, creator=${callerAgentId}, access=specific:[${callerAgentId}]).`,
            }],
          };
        }
      }
      throw new Error(
        `wallet_create timed out after 15s waiting for the extension. Is the wallet-vault extension reloaded with v0.4 and connected to Wire?`,
      );
    }

    // ---- Vault listing / binding ----
    case "wallet_list": {
      const dir = await readDirectory();
      const accessible = callerAccessibleWallets(dir, callerAgentId);
      const rows = Object.entries(accessible).map(([address, meta]) => ({
        address,
        name: meta.operator_name ?? meta.name,
        chain_id: meta.chain_id,
        creator: meta.creator,
        access_mode: meta.access.mode,
      }));
      return {
        content: [{
          type: "text",
          text: rows.length === 0
            ? `(no wallets — ${callerAgentId} isn't in any access list and no wallets are mode:'all'.)`
            : JSON.stringify(rows, null, 2),
        }],
      };
    }
    case "wallet_use": {
      const tabId = String(args.tab_id ?? "").trim();
      if (!tabId) throw new Error("tab_id required");
      const walletQuery = String(args.wallet ?? "").trim();
      if (!walletQuery) throw new Error("wallet (name or address) required");

      const dir = await readDirectory();
      const found = findWalletByNameOrAddress(dir, walletQuery);
      if (!found) throw new Error(`no wallet matches '${walletQuery}'`);
      if (found.meta.access.mode !== "all" && !found.meta.access.agents.includes(callerAgentId)) {
        throw new Error(`agent ${callerAgentId} has no access to wallet ${found.address} (${found.meta.name}). Ask the operator to grant access via wallet_grant.`);
      }

      const { seq } = await publishDirected(WALLET_VAULT_TAB_CLAIM, {
        tab_id: tabId,
        wallet_address: found.address,
      });
      return {
        content: [{
          type: "text",
          text: `Bound tab ${tabId} to wallet ${found.address} (${found.meta.name}). Wire seq ${seq}. Subsequent sign requests in this tab will route to ${callerAgentId}.`,
        }],
      };
    }

    // ---- Operator-gated permission edits ----
    case "wallet_grant":
    case "wallet_revoke":
    case "wallet_set_access_mode": {
      const walletQuery = String(args.wallet ?? "").trim();
      if (!walletQuery) throw new Error("wallet (name or address) required");
      const dir = await readDirectory();
      const found = findWalletByNameOrAddress(dir, walletQuery);
      if (!found) throw new Error(`no wallet matches '${walletQuery}'`);

      const meta = { ...found.meta, access: { ...found.meta.access, agents: [...found.meta.access.agents] } };

      if (name === "wallet_grant") {
        const grantee = String(args.agent_id ?? "").trim();
        if (!grantee) throw new Error("agent_id required");
        if (meta.access.mode === "creator-only") meta.access.mode = "specific";
        if (!meta.access.agents.includes(grantee)) meta.access.agents.push(grantee);
      } else if (name === "wallet_revoke") {
        const grantee = String(args.agent_id ?? "").trim();
        if (!grantee) throw new Error("agent_id required");
        meta.access.agents = meta.access.agents.filter((a) => a !== grantee);
      } else {
        const mode = String(args.mode ?? "") as WalletAccessMode;
        if (mode !== "creator-only" && mode !== "specific" && mode !== "all") {
          throw new Error(`invalid mode '${mode}'`);
        }
        meta.access.mode = mode;
      }

      const next: WalletDirectory = { ...dir, [found.address]: meta };
      await writeDirectoryAsOperator(next);
      return {
        content: [{
          type: "text",
          text: `Updated ${found.address} (${meta.name}). New access: mode=${meta.access.mode}, agents=[${meta.access.agents.join(", ")}].`,
        }],
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
  console.error("[wallet] MCP server connected (v0.3.0)");
}

main().catch((e) => {
  console.error("[wallet] fatal:", e);
  process.exit(1);
});
