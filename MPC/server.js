// SX Bet MCP server — read-only market data for AI agents (Notion, Claude, Cursor, ...).
//
// Wraps the public SX Bet REST API (https://docs.sx.bet) as MCP tools over Streamable HTTP.
// No order placement, no signing, no private keys. Every request to /mcp needs a bearer token.
//
// Env vars:
//   MCP_TOKEN     required — shared secret clients send as "Authorization: Bearer <token>"
//   SX_API_BASE   optional — default https://api.sx.bet (use https://api.toronto.sx.bet for testnet)
//   SX_API_KEY    optional — SX API key (x-sx-api-key). Only needed for sx_get_best_odds.
//   PORT          optional — default 3000 (Railway sets this)
//   CACHE_TTL_MS  optional — default 30000
//   UPSTREAM_RPM  optional — max upstream requests per minute, default 120

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- config ----------

const MCP_TOKEN = process.env.MCP_TOKEN;
if (!MCP_TOKEN || MCP_TOKEN.length < 16) {
  console.error("MCP_TOKEN is missing or shorter than 16 chars. Set it in the environment before starting.");
  process.exit(1);
}
const SX_API_BASE = (process.env.SX_API_BASE || "https://api.sx.bet").replace(/\/$/, "");
const SX_API_KEY = process.env.SX_API_KEY || "";
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30_000);
const UPSTREAM_RPM = Number(process.env.UPSTREAM_RPM || 120);
const MAX_TOOL_OUTPUT_CHARS = 200_000;

// ---------- upstream client: cache + rate limit ----------

const cache = new Map(); // key -> { expires, body }
const windowStart = { t: Date.now(), n: 0 };

function takeUpstreamSlot() {
  const now = Date.now();
  if (now - windowStart.t >= 60_000) {
    windowStart.t = now;
    windowStart.n = 0;
  }
  if (windowStart.n >= UPSTREAM_RPM) {
    throw new Error(`Upstream rate limit reached (${UPSTREAM_RPM}/min). Try again shortly.`);
  }
  windowStart.n += 1;
}

async function sx(path, params = {}, { ttl = CACHE_TTL_MS, auth = false } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const url = `${SX_API_BASE}${path}${qs.size ? `?${qs}` : ""}`;

  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.body;

  takeUpstreamSlot();
  const headers = { Accept: "application/json", "User-Agent": "sx-bet-mcp/1.0 (+https://docs.sx.bet)" };
  if (auth) {
    if (!SX_API_KEY) throw new Error("This tool needs SX_API_KEY set on the server (x-sx-api-key).");
    headers["x-sx-api-key"] = SX_API_KEY;
  }
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`SX API ${res.status} on ${path}: ${text.slice(0, 500)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`SX API returned non-JSON on ${path}`);
  }
  if (ttl > 0) cache.set(url, { expires: Date.now() + ttl, body });
  if (cache.size > 2000) {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
  }
  return body;
}

// ---------- helpers ----------

// SX odds are implied probabilities scaled by 1e20. Sizes are token base units (USDC = 6 decimals).
function decorateLevel(level) {
  if (!level || typeof level.percentageOdds !== "string") return level;
  const implied = Number(level.percentageOdds) / 1e20;
  return {
    ...level,
    impliedProbability: Number(implied.toFixed(6)),
    decimalOdds: implied > 0 ? Number((1 / implied).toFixed(4)) : null,
  };
}

function text(obj) {
  let s = JSON.stringify(obj);
  if (s.length > MAX_TOOL_OUTPUT_CHARS) {
    s = s.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n…truncated at ${MAX_TOOL_OUTPUT_CHARS} chars; narrow the query or page.`;
  }
  return { content: [{ type: "text", text: s }] };
}

function fail(err) {
  return { isError: true, content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }] };
}

const run = (fn) => async (args) => {
  try {
    return text(await fn(args ?? {}));
  } catch (e) {
    return fail(e);
  }
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const marketHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "marketHash must be a 0x-prefixed 32-byte hex string");

// ---------- MCP server ----------

function createServer() {
  const server = new McpServer({ name: "sx-bet", version: "1.0.0" });

  server.registerTool(
    "sx_get_sports",
    {
      title: "List sports",
      description: "All sports on SX Bet with their numeric sportId. Use the id with other tools.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run(() => sx("/sports", {}, { ttl: 10 * 60_000 }))
  );

  server.registerTool(
    "sx_get_active_leagues",
    {
      title: "Active leagues",
      description:
        "Leagues that currently have active markets, with eventsByType counts (e.g. game-lines, outright-winner). Updated upstream every ~10 min. Optionally filter by sportId.",
      inputSchema: { sportId: z.number().int().optional().describe("Numeric sport id from sx_get_sports") },
      annotations: READ_ONLY,
    },
    run(({ sportId }) => sx("/leagues/active", { sportId }, { ttl: 5 * 60_000 }))
  );

  server.registerTool(
    "sx_get_fixtures",
    {
      title: "Active fixtures for a league",
      description: "Upcoming and live events (fixtures) in one league. leagueId is required; get it from sx_get_active_leagues.",
      inputSchema: { leagueId: z.number().int().describe("League id") },
      annotations: READ_ONLY,
    },
    run(({ leagueId }) => sx("/fixture/active", { leagueId }))
  );

  server.registerTool(
    "sx_search_fixtures",
    {
      title: "Search fixtures by team",
      description: "Find up to 8 active fixtures whose team names contain the query (3–100 chars, case-insensitive). Returns eventId and the market type ids available.",
      inputSchema: { query: z.string().min(3).max(100) },
      annotations: READ_ONLY,
    },
    run(({ query }) => sx("/search", { query }))
  );

  server.registerTool(
    "sx_get_active_markets",
    {
      title: "Active markets",
      description:
        "Active (unsettled) markets with filters. Paginated: pass the response's nextKey back as paginationKey for the next page. " +
        "Market fields include marketHash, outcome names, type (numeric market type id), line, gameTime (unix seconds), sportXeventId, leagueLabel. " +
        "Odds are NOT included — call sx_get_orderbook with the marketHash. Only one of type and betGroup may be set.",
      inputSchema: {
        leagueId: z.number().int().optional(),
        sportIds: z.array(z.number().int()).optional().describe("One or more sport ids"),
        eventId: z.string().optional().describe("Full sportXeventId, e.g. L12003787"),
        type: z.array(z.number().int()).optional().describe("Market type ids (see docs.sx.bet market types)"),
        betGroup: z.string().optional().describe("e.g. game-lines, outright-winner"),
        liveOnly: z.boolean().optional().describe("Only markets open for in-play betting"),
        onlyMainLine: z.boolean().optional().describe("Only the main line for spread/total types"),
        gameTime: z.number().int().optional().describe("Only games starting at or after this unix timestamp"),
        pageSize: z.number().int().min(1).max(100).default(50),
        paginationKey: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    run((a) => sx("/markets/active", a))
  );

  server.registerTool(
    "sx_get_popular_markets",
    {
      title: "Popular markets",
      description: "The top 10 markets by volume right now.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run(() => sx("/markets/popular"))
  );

  server.registerTool(
    "sx_find_markets",
    {
      title: "Find markets by hash",
      description: "Look up specific markets by marketHash, including settlement details (outcome, scores, reportedDate) for resolved markets.",
      inputSchema: { marketHashes: z.array(marketHash).min(1).max(100) },
      annotations: READ_ONLY,
    },
    run(({ marketHashes }) => sx("/markets/find", { marketHashes }, { ttl: 10_000 }))
  );

  server.registerTool(
    "sx_get_orderbook",
    {
      title: "Order book for one market",
      description:
        "Aggregated order book for a single market. Levels are sorted best-first. By default the book is shown from the taker's perspective " +
        "(what you can bet at). Each level is annotated with impliedProbability and decimalOdds derived from percentageOdds (scaled 1e20). size is in token base units (USDC has 6 decimals).",
      inputSchema: {
        marketHash,
        showTakerPerspective: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    run(async ({ marketHash: h, showTakerPerspective }) => {
      const body = await sx("/orderbook-v3/snapshot", { marketHash: h, showTakerPerspective }, { ttl: 5_000 });
      if (body?.data) {
        body.data.outcomeOne = (body.data.outcomeOne || []).map(decorateLevel);
        body.data.outcomeTwo = (body.data.outcomeTwo || []).map(decorateLevel);
      }
      return body;
    })
  );

  server.registerTool(
    "sx_get_trade_tape",
    {
      title: "Recent public trades",
      description:
        "The public trade tape: recent bets placed on the exchange, optionally filtered by marketHash or eventId. Rows carry username/userAddress only when the bettor was de-anonymized. " +
        "totalStake and totalReturn are token base units. Paginated via nextKey.",
      inputSchema: {
        marketHash: marketHash.optional(),
        eventId: z.string().min(2).max(64).optional(),
        perPage: z.number().int().min(1).max(100).default(50),
        nextKey: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    run((a) => sx("/trades-v3/public", a, { ttl: 10_000 }))
  );

  if (SX_API_KEY) {
    server.registerTool(
      "sx_get_best_odds",
      {
        title: "Best odds for many markets",
        description: "Top-of-book on each side for up to 100 markets in one call. Levels annotated with impliedProbability and decimalOdds.",
        inputSchema: {
          marketHashes: z.array(marketHash).min(1).max(100),
          showTakerPerspective: z.boolean().default(true),
        },
        annotations: READ_ONLY,
      },
      run(async ({ marketHashes, showTakerPerspective }) => {
        const body = await sx("/orders-v3/odds/best", { marketHashes, showTakerPerspective }, { ttl: 5_000, auth: true });
        for (const row of body?.data?.bestOdds || []) {
          row.outcomeOne = decorateLevel(row.outcomeOne);
          row.outcomeTwo = decorateLevel(row.outcomeTwo);
        }
        return body;
      })
    );
  }

  return server;
}

// ---------- HTTP ----------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sx-bet-mcp", upstream: SX_API_BASE, bestOddsTool: Boolean(SX_API_KEY) });
});

function requireBearer(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.length !== MCP_TOKEN.length || !timingSafeEqual(token, MCP_TOKEN)) {
    res.set("WWW-Authenticate", 'Bearer realm="sx-bet-mcp"');
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stateless Streamable HTTP: a fresh server + transport per request, nothing kept in memory between calls.
async function handleMcp(req, res) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
}

app.post("/mcp", requireBearer, handleMcp);
app.get("/mcp", requireBearer, handleMcp); // SDK answers 405 in stateless mode; auth still enforced
app.delete("/mcp", requireBearer, handleMcp);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`sx-bet-mcp listening on :${PORT}  upstream=${SX_API_BASE}  bestOdds=${SX_API_KEY ? "on" : "off"}`);
});
