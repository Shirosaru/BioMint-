/**
 * MCP tool server — exposes the mint-guard policy engine as MCP tools.
 *
 * Tools exposed:
 *   get_policy_state     → current state (free)
 *   get_risk_score       → compute live risk score (free)
 *   query_policy         → full policy decision (requires x402 payment)
 *   reset_policy         → reset state (admin only, requires x402 payment)
 *
 * x402 payment gate: Tools marked as paid return a 402 response body
 * when no X-Payment header is present. The x402Client.js handles payment
 * automatically on the calling agent's side.
 *
 * Usage:  node src/mcpServer.js [--port 3001]
 *
 * Compatible with Claude Desktop, Cursor, and any MCP-compliant host.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { loadState } from "./registry.js";
import { computeRisk } from "./risk.js";
import { decidePolicy } from "./policyEngine.js";
import { fetchMarketInput } from "./oracleAdapter.js";
import { evaluateBacking } from "./backing.js";
import { CONFIG } from "./config.js";
import { runPolicyStep, resetRuntimeState } from "./agent.js";
import { issueDelegation } from "./authorization.js";
import { selectExecutionPlan } from "./failover.js";

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_policy_state",
    description:
      "Returns the current mint policy state: paused flag, max LTV bps, mint cap in USD, and version. Free tool.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    paid: false
  },
  {
    name: "get_risk_score",
    description:
      "Compute a real-time risk score from live oracle data (Pyth + Jupiter + DexScreener). Returns score 0-100, grade, and component breakdown. Free tool.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token symbol to query (default: SOL)",
          default: "SOL"
        }
      },
      required: []
    },
    paid: false
  },
  {
    name: "query_policy",
    description:
      "Run a full autonomous policy decision step with live oracle data. Returns action, confidence, risk, backing ratio, and rationale. Requires x402 payment (50_000 lamports).",
    inputSchema: {
      type: "object",
      properties: {
        collateral_usd: {
          type: "number",
          description: "Reserve collateral in USD (default: from env COLLATERAL_USD)"
        },
        liability_usd: {
          type: "number",
          description: "Outstanding liability in USD (default: from env LIABILITY_USD)"
        }
      },
      required: []
    },
    paid: true,
    priceLamports: 50_000
  },
  {
    name: "reset_policy",
    description:
      "Reset policy state and attestation log to defaults. Admin operation — requires x402 payment (200_000 lamports).",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the reset"
        }
      },
      required: ["confirm"]
    },
    paid: true,
    priceLamports: 200_000
  }
];

// ── Payment gate helper ───────────────────────────────────────────────────────

/**
 * Returns a 402-style error payload that the x402Client can parse.
 * In MCP, payment requirements are embedded in the tool error text.
 */
function buildPaymentRequired(tool) {
  const requirement = {
    scheme: "exact",
    network: "solana-devnet",
    maxAmountRequired: tool.priceLamports,
    payTo: process.env.POLICY_STATE_ADDRESS ?? "MintGuard1111111111111111111111111111111111",
    asset: "So11111111111111111111111111111111111111112",
    resource: `mcp://mint-guard/${tool.name}`,
    description: `Pay ${tool.priceLamports} lamports to call ${tool.name}`
  };
  return {
    status: 402,
    error: "Payment Required",
    requirement
  };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleGetPolicyState() {
  const state = loadState();
  return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
}

async function handleGetRiskScore(args) {
  const token = args?.token ?? "SOL";
  const market = await fetchMarketInput(token);
  const risk = computeRisk(market, CONFIG.risk);
  const result = {
    score: risk.score,
    grade: risk.grade,
    oracleDivergence: risk.oracleDivergence,
    components: risk.components,
    market: {
      volatility24h: market.volatility24h,
      liquidityDepthUsd: market.liquidityDepthUsd,
      oraclePriceA: market.oraclePriceA,
      oraclePriceB: market.oraclePriceB,
      topHolderShare: market.topHolderShare,
      fetchedAt: market.fetchedAt,
      sources: market._meta?.sources
    }
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleQueryPolicy(args, xPaymentHeader) {
  const tool = TOOLS.find((t) => t.name === "query_policy");

  // Check payment
  if (tool.paid && !xPaymentHeader) {
    const pr = buildPaymentRequired(tool);
    return {
      content: [{ type: "text", text: JSON.stringify(pr, null, 2) }],
      isError: true
    };
  }

  const collateralUsd = args?.collateral_usd ?? parseFloat(process.env.COLLATERAL_USD ?? "1500000");
  const liabilityUsd = args?.liability_usd ?? parseFloat(process.env.LIABILITY_USD ?? "1000000");
  const mintCapacityUsd = parseFloat(process.env.MINT_CAPACITY_USD ?? "2000000");

  const market = await fetchMarketInput("SOL");

  const delegation = issueDelegation(
    {
      principal: "mcp-caller",
      agentId: "mcp-agent-001",
      permissions: ["mint", "trade", "policy"],
      maxMintUsd: mintCapacityUsd,
      maxTradeUsd: mintCapacityUsd * 0.5,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    },
    CONFIG.auth.delegationSecret
  );

  const now = Date.now();
  const controls = {
    request: { action: "mint", amountUsd: 100_000 },
    backingSnapshot: {
      collateralUsd,
      liabilityUsd,
      mintCapacityUsd,
      reserveProofFresh: true
    },
    delegation,
    agents: [
      { id: "agent-primary", lastHeartbeatMs: now, role: "primary", canApprove: true },
      { id: "agent-backup-1", lastHeartbeatMs: now - 8000, role: "backup", canApprove: true },
      { id: "agent-backup-2", lastHeartbeatMs: now - 15000, role: "backup", canApprove: true }
    ]
  };

  const outcome = runPolicyStep(market, controls);
  const result = {
    action: outcome.decision.action,
    confidence: outcome.decision.confidence,
    rationale: outcome.decision.rationale,
    risk: { score: outcome.risk.score, grade: outcome.risk.grade },
    backing: {
      collateralRatio: outcome.backing.collateralRatio,
      maxSafeMintUsd: outcome.backing.maxSafeMintUsd,
      healthy: outcome.backing.healthy
    },
    nextState: outcome.decision.nextState,
    authorized: outcome.auth.allowed,
    leader: outcome.executionPlan.leader
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleResetPolicy(args, xPaymentHeader) {
  const tool = TOOLS.find((t) => t.name === "reset_policy");

  if (tool.paid && !xPaymentHeader) {
    const pr = buildPaymentRequired(tool);
    return {
      content: [{ type: "text", text: JSON.stringify(pr, null, 2) }],
      isError: true
    };
  }

  if (!args?.confirm) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "confirm must be true" }) }],
      isError: true
    };
  }

  const reset = resetRuntimeState();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ success: true, paths: reset.paths, state: reset.state })
      }
    ]
  };
}

// ── MCP Server ────────────────────────────────────────────────────────────────

async function run() {
  const server = new Server(
    { name: "mint-guard", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // X-Payment can be passed as a meta field in the MCP request
    const xPaymentHeader = request.params?._meta?.xPayment ?? null;

    switch (name) {
      case "get_policy_state":
        return handleGetPolicyState();
      case "get_risk_score":
        return handleGetRiskScore(args);
      case "query_policy":
        return handleQueryPolicy(args, xPaymentHeader);
      case "reset_policy":
        return handleResetPolicy(args, xPaymentHeader);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mint-guard MCP] server running on stdio");
}

run().catch((err) => {
  console.error("[mint-guard MCP] fatal:", err);
  process.exit(1);
});
