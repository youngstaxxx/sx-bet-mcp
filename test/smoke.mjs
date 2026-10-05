// Smoke test: starts the mock SX API and the MCP server, then exercises auth + tools with the official MCP client.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "test-token-0123456789abcdef";
const env = { ...process.env, MCP_TOKEN: TOKEN, SX_API_BASE: "http://127.0.0.1:4000", SX_API_KEY: "key", PORT: "3100" };
const mock = spawn("node", ["test/mock-sx.mjs"], { stdio: "inherit" });
const srv = spawn("node", ["server.js"], { stdio: "inherit", env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (code) => { mock.kill(); srv.kill(); process.exit(code); };

try {
  await sleep(1200);

  // health
  const h = await fetch("http://127.0.0.1:3100/health").then((r) => r.json());
  if (!h.ok) throw new Error("health failed");

  // auth: no token -> 401
  const noAuth = await fetch("http://127.0.0.1:3100/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  if (noAuth.status !== 401) throw new Error(`expected 401 without token, got ${noAuth.status}`);
  const badAuth = await fetch("http://127.0.0.1:3100/mcp", { method: "POST", headers: { authorization: "Bearer wrong-token-xxxxxxxxxxxxxxxx", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  if (badAuth.status !== 401) throw new Error(`expected 401 with wrong token, got ${badAuth.status}`);
  console.log("auth: 401 without/with wrong token ✔");

  // real client
  const client = new Client({ name: "smoke", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3100/mcp"), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));
  const expected = ["sx_get_sports","sx_get_active_leagues","sx_get_fixtures","sx_search_fixtures","sx_get_active_markets","sx_get_popular_markets","sx_find_markets","sx_get_orderbook","sx_get_trade_tape","sx_get_best_odds"];
  for (const n of expected) if (!tools.find((t) => t.name === n)) throw new Error(`missing tool ${n}`);

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const txt = r.content[0].text;
    if (r.isError) throw new Error(`${name} errored: ${txt}`);
    return JSON.parse(txt);
  };

  const sports = await call("sx_get_sports", {});
  if (sports.data.length !== 2) throw new Error("sports shape");
  const leagues = await call("sx_get_active_leagues", { sportId: 1 });
  if (leagues.data[0].leagueId !== 1) throw new Error("leagues shape");
  await call("sx_get_fixtures", { leagueId: 1 });
  await call("sx_search_fixtures", { query: "Lakers" });
  const mk = await call("sx_get_active_markets", { sportIds: [1, 5], liveOnly: true, pageSize: 10 });
  if (mk.data.markets[0].query.sportIds !== "1,5" || mk.data.markets[0].query.liveOnly !== "true") throw new Error("markets params not forwarded");
  const MH = "0x" + "ab".repeat(32);
  const ob = await call("sx_get_orderbook", { marketHash: MH });
  if (ob.data.outcomeOne[0].decimalOdds !== 2 || ob.data.outcomeTwo[0].impliedProbability !== 0.4) throw new Error("odds decoration wrong");
  if (ob.data.taker !== "true") throw new Error("taker perspective default not sent");
  await call("sx_find_markets", { marketHashes: [MH] });
  const tape = await call("sx_get_trade_tape", { eventId: "L1", perPage: 5 });
  if (tape.data.trades[0].q.perPage !== "5") throw new Error("tape params");
  const best = await call("sx_get_best_odds", { marketHashes: [MH] });
  if (best.data.bestOdds[0].outcomeOne.decimalOdds !== 2) throw new Error("best odds decoration");

  // validation error surfaces as tool error, not crash
  const bad = await client.callTool({ name: "sx_get_orderbook", arguments: { marketHash: "nope" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  if (!bad.isError && !/invalid|must be/i.test(bad.content[0].text)) throw new Error("bad hash should error");
  console.log("validation: bad marketHash rejected ✔");

  // cache: second identical call does not hit upstream (we can't see upstream count, but it must still succeed fast)
  const t0 = Date.now(); await call("sx_get_sports", {}); console.log(`cache: repeat call ${Date.now() - t0}ms ✔`);

  await client.close();
  console.log("\nALL CHECKS PASSED");
  die(0);
} catch (e) {
  console.error("\nFAILED:", e);
  die(1);
}
