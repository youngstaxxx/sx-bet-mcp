// Minimal stand-in for api.sx.bet so the server can be exercised offline.
import express from "express";
const app = express();
const MH = "0x" + "ab".repeat(32);
app.get("/sports", (_q, r) => r.json({ status: "success", data: [{ sportId: 1, label: "Basketball" }, { sportId: 5, label: "Soccer" }] }));
app.get("/leagues/active", (q, r) => r.json({ status: "success", data: [{ leagueId: 1, label: "NBA", sportId: 1, eventsByType: { "game-lines": 3 } }].filter(l => !q.query.sportId || String(l.sportId) === q.query.sportId) }));
app.get("/fixture/active", (q, r) => q.query.leagueId ? r.json({ status: "success", data: [{ participantOneName: "A", participantTwoName: "B", startDate: "2026-10-06T00:00:00Z", status: 1, leagueId: Number(q.query.leagueId), leagueLabel: "NBA", sportId: 1, eventId: "L1" }] }) : r.status(400).json({ message: ["leagueId required"], error: "Bad Request", statusCode: 400 }));
app.get("/search", (q, r) => r.json({ status: "success", data: [{ gameTime: "2026-10-06T00:00:00Z", teamOneName: q.query.query, teamTwoName: "X", eventId: "L1", type: [1, 2], league: { leagueId: 1, sportId: 1, label: "NBA" } }] }));
app.get("/markets/active", (q, r) => r.json({ status: "success", data: { markets: [{ marketHash: MH, outcomeOneName: "A", outcomeTwoName: "B", type: 1, gameTime: 1760000000, sportXeventId: "L1", leagueLabel: "NBA", query: q.query }], nextKey: "k2" } }));
app.get("/markets/popular", (_q, r) => r.json({ status: "success", data: [{ marketHash: MH, type: 1 }] }));
app.get("/markets/find", (q, r) => r.json({ status: "success", data: [{ marketHash: q.query.marketHashes, outcome: 1, reportedDate: 1760000000 }] }));
app.get("/orderbook-v3/snapshot", (q, r) => r.json({ status: "success", data: { marketHash: q.query.marketHash, outcomeOne: [{ percentageOdds: "50000000000000000000", size: "1000000" }], outcomeTwo: [{ percentageOdds: "40000000000000000000", size: "5000000" }], version: "001", taker: q.query.showTakerPerspective } }));
app.get("/trades-v3/public", (q, r) => r.json({ status: "success", data: { trades: [{ tradeId: "0x1", marketHash: MH, totalStake: "1000000", totalReturn: "2500000", betTime: "2026-10-05T00:00:00Z", q: q.query }], nextKey: "n2" } }));
app.get("/orders-v3/odds/best", (q, r) => q.get("x-sx-api-key") ? r.json({ status: "success", data: { bestOdds: [{ marketHash: MH, outcomeOne: { percentageOdds: "50000000000000000000", size: "1" }, outcomeTwo: null }] } }) : r.status(401).json({ message: "BAD_AUTH" }));
app.listen(4000, () => console.log("mock sx on :4000"));
