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
 *      directory stored in Wire's plugin_settings under the vault's
 *      namespace (default "wallet-vault"). Since v0.8.0 (ENG-3313)
 *      each wallet lives under its own `wallet:<lowercase-address>`
 *      key — concurrent writers touch distinct rows, so creates can't
 *      clobber each other. Reads merge the legacy whole-roster
 *      `wallets` blob (per-key wins) until every writer has migrated;
 *      writes are per-key only. wallet_use publishes a tab-claim so
 *      subsequent sign requests originating in that browser tab route
 *      to the calling agent.
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
  WALLET_VAULT_TAB_RELEASE,
  WALLET_VAULT_CREATE_REQUEST,
  mergeWalletDirectory,
  walletSettingKey,
  tabClaimSettingKey,
} from "@agiterra/wallet-tools";
import type {
  WalletAccessMode,
  WalletDirectory,
  WalletMeta,
  WalletTabClaimStatus,
} from "@agiterra/wallet-tools";
import { createAuthJwt, importKeyPair } from "@agiterra/wire-tools/crypto";

const WALLET_VAULT_DEST = "wallet-vault";
// The DISPENSE custodian is the headless wallet-vault-service. Since the 2026-09-02 cutover (AGI-86) it owns the canonical Wire id "wallet-vault"; "wallet-vault-plugin" was its temp id (
// j:1098-1100), NOT the browser extension ("wallet-vault"). 2026-09-02: dispense requests sent
// to the extension id were dropped as forward_no_peer with no reply. Override via env.
const WALLET_DISPENSE_DEST = process.env.WALLET_VAULT_SERVICE_ID?.trim() || "wallet-vault";
const WALLET_VAULT_NAMESPACE = "wallet-vault";

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

// `dest` is the Wire id of the target wallet-vault EXTENSION instance. Defaults
// to the canonical "wallet-vault"; pass a non-default id to drive a specific
// instance (e.g. a browser-use launch registered as "wallet-vault-e2e"). This
// is what lets the wallet work across more than one live extension — the
// extension's Wire id is now configurable (wallet-extension wire-identity.ts),
// so the MCP can no longer assume a single "wallet-vault". For sign responses
// the caller passes the request's ENVELOPE source (the vault id that published
// the sign.request); for create/tab-claim it names the target instance.
async function publishDirected(topic: string, payload: unknown, dest: string = WALLET_VAULT_DEST): Promise<{ seq: number }> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const body = JSON.stringify(payload);
  const endpoint = `${url}/webhooks/${dest}/${topic}`;

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

// Read the whole vault namespace and merge both storage generations:
// legacy `wallets` blob first, per-key `wallet:<addr>` entries winning
// per address (see @agiterra/wallet-tools/directory for the convention).
async function readDirectory(vaultId: string = WALLET_VAULT_NAMESPACE): Promise<WalletDirectory> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const res = await fetch(`${url}/plugin_settings/${vaultId}`);
  if (res.status === 404) return {};
  if (!res.ok) {
    throw new Error(`plugin_settings GET failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const settings = (await res.json()) as Record<string, unknown>;
  return mergeWalletDirectory(settings);
}

// Upsert ONE wallet under its own key. Never writes the legacy blob —
// a whole-roster PUT is exactly the race that clobbered concurrent
// creates (ENG-3313). Editing a legacy-blob wallet through here
// migrates it: the per-key copy shadows the stale blob entry on read.
async function writeWalletAsOperator(address: string, meta: WalletMeta, vaultId: string = WALLET_VAULT_NAMESPACE): Promise<void> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const token = operatorToken();
  const body = JSON.stringify({ value: meta });
  const res = await fetch(`${url}/plugin_settings/${vaultId}/${encodeURIComponent(walletSettingKey(address))}?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`plugin_settings PUT failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
}

// ----- Tab-claim ack polling (AGI-16 fail-loud binding) -----

// The extension writes every claim outcome (accepted | refused+reason) to
// plugin_settings under tab_claim:<tab_id>, and DELETEs it on release. The
// namespace GET is public, so polling needs no auth.
async function readTabClaimStatus(vaultId: string, tabId: string): Promise<WalletTabClaimStatus | null> {
  const url = requireEnv("WIRE_URL").replace(/\/$/, "");
  const res = await fetch(`${url}/plugin_settings/${vaultId}`);
  if (!res.ok) {
    throw new Error(`plugin_settings GET failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const all = (await res.json()) as Record<string, unknown>;
  return (all[tabClaimSettingKey(tabId)] as WalletTabClaimStatus | undefined) ?? null;
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

async function publishSignResponse(payload: SignResponse, dest: string = WALLET_VAULT_DEST): Promise<{ seq: number }> {
  return publishDirected(WALLET_SIGN_RESPONSE, payload, dest);
}

// Resolve the target wallet-vault instance from a tool call's optional
// `vault_id`. Defaults to the canonical "wallet-vault" (backward-compatible);
// a non-default value routes to a specific extension instance. For sign
// decisions the caller passes the request's channel-event source (the vault id
// that published the sign.request); for create/tab-claim it names the instance.
function destFromArgs(args: Record<string, unknown>): string {
  const v = args.vault_id;
  return typeof v === "string" && v.trim() ? v.trim() : WALLET_VAULT_DEST;
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
  { name: "wallet", version: "0.8.0" },
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
          vault_id: { type: "string", description: "Optional. Wire id of the wallet-vault instance to respond to — pass the SOURCE of the incoming wallet.sign.request channel event when it's a non-default instance (e.g. 'wallet-vault-e2e'). Defaults to 'wallet-vault'." },
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
          vault_id: { type: "string", description: "Optional. Wire id of the wallet-vault instance to respond to (the sign.request's source). Defaults to 'wallet-vault'." },
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
          vault_id: { type: "string", description: "Optional. Wire id of the wallet-vault instance to respond to (the sign.request's source). Defaults to 'wallet-vault'." },
        },
        required: ["request_id", "code", "message"],
      },
    },
    // ---- Faucet tools (v0.4) ----
    {
      name: "faucet_usdc",
      description: "RETIRED (2026-09-03): the Circle faucet is dead. Use wallet_dispense for testnet USDC/ETH from the shared custodian pool; wallet_pool_inventory shows what it holds.",
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
    {
      name: "wallet_pool_inventory",
      description:
        "Read what the shared custodian pool can dispense: SepoliaETH and USDC balances plus the PROPERTIES (ERC-721 test tokens) the pool owns, banked by lanes at wrap-up (Tim 2026-09-03). Instant and local: returns the pool meter's snapshot (refreshed every 5 min; holdings tailed from on-chain transfer events, so the count is exact however large). Page through token ids with limit/offset; set with_metadata to fetch name/address/acres/value/loan state for the page (one single-token query each, max 20) so you can pick a property that fits, then request it with wallet_dispense(token_contract, token_id).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Page size for token ids (default 20, max 20 when with_metadata)." },
          offset: { type: "number", description: "Page offset into the sorted token id list (default 0)." },
          with_metadata: { type: "boolean", description: "Fetch per-token metadata for the page from the staging property index (default false)." },
        },
      },
    },
    {
      name: "wallet_dispense",
      description:
        "Fund a wallet with testnet SepoliaETH + USDC from the shared custodian pool (WALLET_DISPENSE, supersedes the dead Circle faucet_usdc). The wallet-vault service is the sole pool custodian: it signs+broadcasts TWO nonce-sequenced txs (ETH then USDC) to your address and posts the two tx hashes back as a 'wallet.dispense.result' event on your Wire channel (this tool returns immediately after dispatch — read your channel for the hashes). No metering. Sepolia only for now (11155111). Use to fund fresh agent EOAs/smart-accounts for marketplace + onboarding tests.",
      inputSchema: {
        type: "object",
        properties: {
          agent_address: { type: "string", description: "0x-prefixed 20-byte address to fund with ETH+USDC." },
          chain_id: { type: "number", description: "Target chain. Defaults to Sepolia (11155111)." },
          assets: { type: "array", items: { type: "string", enum: ["eth", "usdc"] }, description: "Optional. Which legs to dispense (default both). Each leg is sent if the pool can afford it; a leg the pool cannot afford is reported in result.skipped rather than failing the whole request." },
          token_contract: { type: "string", description: "Optional, with token_id: dispense a PROPERTY (ERC-721) from the shared pool instead of ETH+USDC — the pool custodies test property banked by lanes at wrap-up (Tim 2026-09-03). 0x-prefixed contract address." },
          token_id: { type: "string", description: "Optional, with token_contract: decimal token id the pool owns. Result carries token_tx." },
        },
        required: ["agent_address"],
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
          vault_id: { type: "string", description: "Optional. Wire id of the target wallet-vault extension instance. Defaults to 'wallet-vault'." },
        },
        required: ["name"],
      },
    },
    {
      name: "wallet_list",
      description:
        "List the wallets this agent has access to. Returns name, address, chain_id, creator, and access mode for each. Wallets where the caller isn't in the access list (and the mode isn't 'all') are omitted.",
      inputSchema: { type: "object", properties: { vault_id: { type: "string", description: "Optional. Wire id of the wallet-vault instance to list from. Defaults to 'wallet-vault'." } } },
    },
    {
      name: "wallet_use",
      description:
        "Bind a wallet to a browser tab and AWAIT the vault's explicit claim outcome — errors loudly on refusal (no access, unknown wallet, wallet not signable by that vault instance) or 15s timeout. Subsequent EIP-1193 sign requests originating in that tab route to the calling agent for approval. `tab_id` must be the REAL chrome.tabs tab id: get it from the page itself via window.ethereum.request({method:'agiterra_getTabId'}) (works under any driver, incl. playwright-mcp browser_evaluate — a Playwright page INDEX is NOT a tab id), or from Chrome MCP's tab list. The wallet may be referenced by name (case-insensitive) or 0x-address.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "string", description: "REAL Chrome tab id, stringified (from agiterra_getTabId or Chrome MCP — never a Playwright page index)." },
          wallet: { type: "string", description: "Wallet name or 0x-address." },
          vault_id: { type: "string", description: "Optional. Wire id of the target wallet-vault extension instance. Defaults to 'wallet-vault'." },
        },
        required: ["tab_id", "wallet"],
      },
    },
    {
      name: "wallet_release",
      description:
        "Release a tab's wallet binding (the inverse of wallet_use). Only the claim's owner may release it. Awaits confirmation (the vault deletes the claim ack) and errors on 15s timeout. Use in teardown so stale claims never outlive a session.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "string", description: "The tab id whose binding to release." },
          vault_id: { type: "string", description: "Optional. Wire id of the target wallet-vault extension instance. Defaults to 'wallet-vault'." },
        },
        required: ["tab_id"],
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
          vault_id: { type: "string", description: "Optional. Wire id of the target wallet-vault instance. Defaults to 'wallet-vault'." },
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
          vault_id: { type: "string", description: "Optional. Wire id of the target wallet-vault instance. Defaults to 'wallet-vault'." },
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
          vault_id: { type: "string", description: "Optional. Wire id of the target wallet-vault instance. Defaults to 'wallet-vault'." },
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
      const { seq } = await publishSignResponse({ request_id: rid, action: "approve" }, destFromArgs(args));
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
      }, destFromArgs(args));
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
      }, destFromArgs(args));
      return { content: [{ type: "text", text: `Rejected ${rid} with code ${code} (Wire seq ${seq}): ${message}` }] };
    }

    // ---- Faucet ----
    case "faucet_usdc": {
      // RETIRED 2026-09-03: the Circle faucet is dead (j:1098) and every lane that tried it stalled on
      // CIRCLE_FAUCET_API_KEY. The shared custodian pool is the only USDC source: wallet_dispense.
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, retired: true, error: "faucet_usdc is retired: the Circle faucet is dead. Testnet USDC (and ETH, and banked properties) come from the shared custodian pool: call wallet_dispense(agent_address) — check wallet_pool_inventory first; if the pool is short the dispense reply says so and the fleet meter flags it for the operator." }) }] };
    }
    case "faucet_usdc_retired_original": {
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

    case "wallet_pool_inventory": {
      const { readFileSync, statSync } = await import("fs");
      const file = process.env.WALLET_POOL_METER_FILE?.trim() || "/tmp/pool-usage.json";
      let snap: any;
      try { snap = JSON.parse(readFileSync(file, "utf8")); }
      catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `pool meter snapshot unreadable at ${file}: ${String(e)} — the com.agiterra.pool-usage job publishes it every 5 min` }) }] }; }
      const ageS = Math.round((Date.now() - statSync(file).mtimeMs) / 1000);
      const props = snap.properties || {};
      const ids: string[] = Array.isArray(props.token_ids) ? props.token_ids : [];
      const withMeta = args.with_metadata === true;
      const limit = Math.max(1, Math.min(Number(args.limit ?? 20) || 20, withMeta ? 20 : 200));
      const offset = Math.max(0, Number(args.offset ?? 0) || 0);
      const page = ids.slice(offset, offset + limit);
      let items: unknown[] = page.map((id) => ({ token_id: id }));
      if (withMeta && page.length) {
        const url = process.env.PROPERTY_INDEX_URL?.trim() || "https://api-test.fabrica.land/graphql";
        items = await Promise.all(page.map(async (id) => {
          try {
            const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query($n:String!,$c:String!,$t:String!){ token(network:$n, contractAddress:$c, tokenId:$t){ tokenId name street locality region countryCode acres estimatedValue propertyLink isPremint supplyUnderLoan supplyInDefault supplyLiquidating } }", variables: { n: props.network || "sepolia", c: props.contract, t: id } }) });
            const j: any = await r.json(); const t = j?.data?.token;
            return t ? { ...t, under_loan: !!(t.supplyUnderLoan && String(t.supplyUnderLoan) !== "0") } : { token_id: id, metadata: "not in index" };
          } catch (e) { return { token_id: id, metadata_error: String(e).slice(0, 120) }; }
        }));
      }
      const out = { ok: true, as_of: snap.as_of, snapshot_age_s: ageS, pool: snap.pool, eth: snap.eth, usdc: snap.usdc, flags: snap.flags || [],
        properties: { status: props.status, contract: props.contract, network: props.network, count: props.count, last_block: props.last_block, error: props.error || null, offset, limit, items,
          note: "the meter file lists the first 25 ids; the full ledger is /opt/agiterra/watch/state/pool-properties.json" } };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
    case "wallet_dispense": {
      const agentAddress = String(args.agent_address ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) throw new Error("agent_address must be a 0x-prefixed 20-byte hex address");
      const chainId = args.chain_id != null ? Number(args.chain_id) : 11155111;
      if (!Number.isFinite(chainId)) throw new Error("chain_id must be a number");
      const requestId = crypto.randomUUID();
      const assets = Array.isArray(args.assets) ? (args.assets as unknown[]).map(String) : undefined;
      const token = args.token_contract && args.token_id != null ? { contract: String(args.token_contract), token_id: String(args.token_id) } : undefined;
      const { seq } = await publishDirected("wallet.dispense.request", { request_id: requestId, agent_address: agentAddress, chain_id: chainId, ...(assets ? { assets } : {}), ...(token ? { token } : {}) }, WALLET_DISPENSE_DEST);
      return {
        content: [{
          type: "text",
          text: `Dispense requested for ${agentAddress} on chain ${chainId} (request_id ${requestId}, seq ${seq}). The pool custodian will drip SepoliaETH + USDC as two nonce-sequenced txs and post the two tx hashes as a 'wallet.dispense.result' channel event addressed to you. This tool returns after dispatch — read your Wire channel for the hashes.`,
        }],
      };
    }

    // ---- Vault provisioning ----
    case "wallet_create": {
      const walletName = String(args.name ?? "").trim();
      if (!walletName) throw new Error("name required");
      const chainId = args.chain_id != null ? Number(args.chain_id) : undefined;
      if (chainId != null && !Number.isFinite(chainId)) throw new Error("chain_id must be a number");

      const dest = destFromArgs(args);
      // Reject early if a wallet with this name already exists for this agent.
      const before = await readDirectory(dest);
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
      }, dest);

      // Poll plugin_settings for the new entry. Extension publishes
      // wallet.vault.created back to us (and the directory updates via
      // plugin_settings.updated), so the directory cache reflects the new
      // wallet within a few hundred ms of the extension finishing.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const current = await readDirectory(dest);
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
      const dir = await readDirectory(destFromArgs(args));
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

      const dest = destFromArgs(args);
      const dir = await readDirectory(dest);
      const found = findWalletByNameOrAddress(dir, walletQuery);
      if (!found) throw new Error(`no wallet matches '${walletQuery}'`);
      if (found.meta.access.mode !== "all" && !found.meta.access.agents.includes(callerAgentId)) {
        throw new Error(`agent ${callerAgentId} has no access to wallet ${found.address} (${found.meta.name}). Ask the operator to grant access via wallet_grant.`);
      }

      const publishedAt = Date.now();
      const { seq } = await publishDirected(WALLET_VAULT_TAB_CLAIM, {
        tab_id: tabId,
        wallet_address: found.address,
      }, dest);

      // Fail-loud (AGI-16): await the extension's explicit claim outcome
      // instead of reporting fire-and-forget success. 5s clock-skew grace on
      // `at` so a same-host restart clock nudge can't orphan a fresh ack.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const status = await readTabClaimStatus(dest, tabId).catch(() => null);
        if (!status) continue;
        if (status.agent_id !== callerAgentId) continue;
        if (status.wallet_address !== found.address.toLowerCase()) continue;
        if (status.at < publishedAt - 5_000) continue; // stale ack from an earlier claim
        if (status.status === "refused") {
          throw new Error(`tab_claim refused by vault '${dest}': ${status.reason ?? "(no reason given)"}`);
        }
        return {
          content: [{
            type: "text",
            text: `Bound tab ${tabId} to wallet ${found.address} (${found.meta.name}) — claim ACCEPTED by vault '${dest}' (wire seq ${seq}). Subsequent sign requests in this tab route to ${callerAgentId}. Verify from the page: window.ethereum.request({method:'eth_accounts'}) should return ${found.address}.`,
          }],
        };
      }
      throw new Error(
        `tab_claim published (seq ${seq}) but no ack within 15s. Either the vault extension predates v0.5.0 (no claim-ack support), or it isn't connected to Wire, or the claim was dropped. Verify in-page with window.ethereum.request({method:'eth_accounts'}).`,
      );
    }
    case "wallet_release": {
      const tabId = String(args.tab_id ?? "").trim();
      if (!tabId) throw new Error("tab_id required");
      const dest = destFromArgs(args);
      const { seq } = await publishDirected(WALLET_VAULT_TAB_RELEASE, { tab_id: tabId }, dest);

      // The extension deletes the tab_claim:<tab_id> key on release; poll for
      // absence. Only the claim owner may release — a refusal leaves the key
      // in place and we time out with that context.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const status = await readTabClaimStatus(dest, tabId).catch(() => undefined);
        if (status === undefined) continue; // transient read failure — keep polling
        if (status === null) {
          return {
            content: [{
              type: "text",
              text: `Released tab ${tabId} binding on vault '${dest}' (wire seq ${seq}).`,
            }],
          };
        }
      }
      throw new Error(
        `tab_release published (seq ${seq}) but the claim ack for tab ${tabId} still exists after 15s. Only the claim's owner may release it — if another agent holds the claim, ask them (or re-claim with wallet_use). The extension may also predate v0.5.0 (no release support).`,
      );
    }

    // ---- Operator-gated permission edits ----
    case "wallet_grant":
    case "wallet_revoke":
    case "wallet_set_access_mode": {
      const dest = destFromArgs(args);
      const walletQuery = String(args.wallet ?? "").trim();
      if (!walletQuery) throw new Error("wallet (name or address) required");
      const dir = await readDirectory(dest);
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

      await writeWalletAsOperator(found.address, meta, dest);
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
  console.error("[wallet] MCP server connected (v0.8.0)");
}

main().catch((e) => {
  console.error("[wallet] fatal:", e);
  process.exit(1);
});
