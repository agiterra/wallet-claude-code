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
  const endpoint = `${url}/webhooks/${WALLET_VAULT_DEST}/${topic}`;

  // Retry transient failures (ngrok blips, brief 5xx, JWT body-hash mismatch
  // on clock skew). Total wait ≤ ~7s before giving up. Real auth errors
  // (401/403) and validation errors (4xx not 408/429) fail fast — they
  // won't get better with retry.
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const wait = 300 * Math.pow(2, attempt - 1); // 300, 600, 1200ms
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      // Re-sign on each attempt: JWT iat shifts forward, body_hash stays
      // identical, so a clock-skew retry actually has a chance to succeed.
      const headers = await jwtHeaders(body);
      const res = await fetch(endpoint, { method: "POST", headers, body });
      if (res.ok) return (await res.json()) as { seq: number };
      const text = await res.text().catch(() => "");
      lastError = `${res.status}: ${text.slice(0, 200)}`;
      const transient = res.status >= 500 || res.status === 408 || res.status === 429 || res.status === 404 /* ngrok endpoint-offline can show as 404 */;
      if (!transient) throw new Error(`Wire publish failed (${lastError})`);
    } catch (e) {
      // Network / DNS / fetch-throw — retry.
      lastError = (e as Error).message;
    }
  }
  throw new Error(`Wire publish failed after retries (${lastError})`);
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

// ----- Faucet helper (Circle testnet) -----

const CIRCLE_FAUCET_ENDPOINT = "https://api.circle.com/v1/faucet/drips";

/**
 * Map a chain_id to the Circle "blockchain" string the faucet accepts.
 * Reference: https://developers.circle.com/w3s/developer-console-faucet
 */
function chainIdToCircleBlockchain(chainId: number): string | null {
  switch (chainId) {
    case 11155111: return "ETH";            // Ethereum Sepolia
    case 84532:    return "BASE";           // Base Sepolia
    case 421614:   return "ARB";            // Arbitrum Sepolia
    case 11155420: return "OP";             // Optimism Sepolia
    case 80002:    return "MATIC";          // Polygon Amoy
    case 1301:     return "UNI";            // Unichain Sepolia
    default: return null;
  }
}

async function dripCircleUsdc(address: string, chainId: number): Promise<{ ok: true; raw: unknown } | { ok: false; error: string }> {
  const apiKey = process.env.CIRCLE_FAUCET_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        "CIRCLE_FAUCET_API_KEY env var not set. Get a free testnet API key at https://console.circle.com (sandbox accounts only need an email). Key format: TEST_API_KEY:abc...:xyz...",
    };
  }
  const blockchain = chainIdToCircleBlockchain(chainId);
  if (!blockchain) {
    return { ok: false, error: `Circle faucet doesn't support chain_id ${chainId} (supported: 11155111, 84532, 421614, 11155420, 80002, 1301)` };
  }
  const body = JSON.stringify({ address, blockchain, native: false, usdc: true });
  try {
    const res = await fetch(CIRCLE_FAUCET_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Circle faucet HTTP ${res.status}: ${text.slice(0, 400)}` };
    }
    let raw: unknown = text;
    try { raw = JSON.parse(text); } catch { /* keep as text */ }
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, error: `Circle faucet network error: ${(e as Error).message}` };
  }
}

// ----- MCP server -----

const server = new Server(
  { name: "wallet", version: "0.4.0" },
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
    // ---- Faucet tools (v0.4) ----
    {
      name: "faucet_usdc",
      description:
        "Request testnet USDC from Circle's faucet API. Returns 20 USDC per address per chain per 2 hours (Circle's rate limit). Supports Sepolia (11155111), Base Sepolia (84532), Arbitrum Sepolia (421614), Optimism Sepolia (11155420), Polygon Amoy (80002), and Unichain Sepolia (1301). Requires CIRCLE_FAUCET_API_KEY env var (free from console.circle.com). Use this to fund agent-owned wallets for marketplace tests (e.g., the Fabrica Seaport buy flow).",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "0x-prefixed Ethereum address to receive USDC." },
          chain_id: { type: "number", description: "Target chain. Defaults to Sepolia (11155111)." },
        },
        required: ["address"],
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

    // ---- Faucet ----
    case "faucet_usdc": {
      const address = String(args.address ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("address must be a 0x-prefixed 20-byte hex address");
      const chainId = args.chain_id != null ? Number(args.chain_id) : 11155111;
      if (!Number.isFinite(chainId)) throw new Error("chain_id must be a number");
      const result = await dripCircleUsdc(address, chainId);
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{
          type: "text",
          text: `Requested USDC from Circle faucet for ${address} on chain ${chainId}. Funds typically arrive within seconds.\n\nResponse:\n${JSON.stringify(result.raw, null, 2)}`,
        }],
      };
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
