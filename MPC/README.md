# sx-bet-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for SX Bet market data. Wraps the public endpoints of the SX Bet REST API (`https://docs.sx.bet`) as tools an AI agent can call: sports, active leagues, fixtures, search, active and popular markets, market lookup with settlement, order book snapshots, and the public trade tape.

No order placement. No signing. No private keys on the box. Every request to `/mcp` requires a bearer token.

## Tools

| Tool | SX endpoint | Notes |
| --- | --- | --- |
| `sx_get_sports` | `GET /sports` | cached 10 min |
| `sx_get_active_leagues` | `GET /leagues/active?sportId=` | cached 5 min |
| `sx_get_fixtures` | `GET /fixture/active?leagueId=` | leagueId required |
| `sx_search_fixtures` | `GET /search?query=` | team-name search, 3–100 chars |
| `sx_get_active_markets` | `GET /markets/active` | all documented filters; paginated via `paginationKey` |
| `sx_get_popular_markets` | `GET /markets/popular` | top 10 by volume |
| `sx_find_markets` | `GET /markets/find?marketHashes=` | includes settlement for resolved markets |
| `sx_get_orderbook` | `GET /orderbook-v3/snapshot` | taker perspective by default; adds `impliedProbability` and `decimalOdds` per level |
| `sx_get_trade_tape` | `GET /trades-v3/public` | paginated via `nextKey` |
| `sx_get_best_odds` | `GET /orders-v3/odds/best` | only registered when `SX_API_KEY` is set (SX requires a key for this route) |

Odds on SX are implied probabilities scaled by 1e20; sizes are token base units (USDC has 6 decimals). The order-book and best-odds tools annotate each level so an agent does not have to do the conversion.

## Deploy (Railway)

1. Push these files to a new GitHub repo (do not commit `.env`).
2. On [railway.app](https://railway.app): New Project → Deploy from GitHub repo → pick the repo. Railway detects Node and uses `railway.json`.
3. In the service's Variables tab set:
   - `MCP_TOKEN` — a long random secret: `openssl rand -hex 32`
   - `SX_API_KEY` — optional; only for `sx_get_best_odds`
4. Settings → Networking → Generate Domain. You get `https://<name>.up.railway.app`.
5. Check it: `curl https://<name>.up.railway.app/health` returns `{"ok":true,...}`.
6. Check auth: `curl -i -X POST https://<name>.up.railway.app/mcp` returns `401`.

Any host that runs Node 20+ and gives you an HTTPS URL works the same way (Render, Fly.io, a VPS behind a reverse proxy).

## Connect to Notion

Prerequisites: a Notion Business or Enterprise plan, and a workspace admin who has enabled custom MCP servers (Settings → Notion AI → AI connectors). Notion does not connect to unauthenticated MCP servers.

1. Open your Custom Agent → Settings → Tools & Access → Add connection → Custom MCP server.
2. MCP server URL: `https://<name>.up.railway.app/mcp`
3. Name: `SX Bet`
4. Authentication: bearer token / API token, value = your `MCP_TOKEN`.
5. Connect. Notion shows "Notion hasn't reviewed this server" for every custom server; that is expected.
6. Ask the agent: "Using the SX Bet connection, list active leagues for sport 1." If it does not pick the connection, name it in the prompt.

## Connect to Claude, Cursor, or anything else that speaks MCP

Point the client at `https://<name>.up.railway.app/mcp` with header `Authorization: Bearer <MCP_TOKEN>`.

## Run locally

```bash
cp .env.example .env   # set MCP_TOKEN
npm install
MCP_TOKEN=$(openssl rand -hex 32) npm start
npm test               # offline smoke test against a mock SX API
```

## Operational notes

- Stateless Streamable HTTP: a fresh MCP server per request, nothing held between calls, so it scales horizontally and restarts are harmless.
- In-memory cache (30 s default; order books 5 s; sports/leagues longer) and a per-process upstream limit (`UPSTREAM_RPM`, default 120) protect `api.sx.bet` from a looping agent.
- Tool output is capped at 200k characters with a note to narrow the query.
- To add write tools later (orders, cancels), do it in a separate server with its own token and keep this one read-only.
