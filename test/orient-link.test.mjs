/* THE ORIENTATION LINK MAY NEVER LOSE A DECISION, AND A TEST SESSION RECORDS ITS TURN
   (2026-09-27) - the browser's half of the link, run for real on a fake clock and a fake socket.
   ─────────────────────────────────────────────────────────────────────────────
   REPORTED, first measurement, read frame by frame: no back print through the whole back view,
   then the rear reference landing as the shopper faced front again. Over a socket a decision can
   go missing where the in-browser call could not: a step whose timer fired ahead of its reply was
   DROPPED while the engine had already acted on it (the early turn fires once per turn). This
   suite keeps the fix and the instrument that will say whether anything else is left:
     §1  a slow reply on a LIVE link is still delivered - the watchdog pings instead of dropping;
     §2  a link that cannot answer a ping is DROPPED: pending steps resolve null, every channel
         re-opens on the next socket with a fresh engine, and no retry back-off is started;
         a reply that never comes is abandoned at ORIENT_LINK_STEP_HARD_MS;
     §3  the keepalive pings while the room is open and replaces a socket that does not answer,
         and go-live's freshness check does the same before a session;
     §4  the FLIGHT RECORDER records only a TEST session (pear_key=TEST or ?pear_trace=1), keeps
         each tick's sample, reply and round trip, is bounded, and posts once to the edge. */
import { readFileSync } from "node:fs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const a = APP.indexOf("const ORIENT_KNOB_KEYS = [");
const b = APP.indexOf("/* ── end flight recorder ── */");
if (a < 0 || b < 0 || b < a) { console.log("FAIL  could not slice the orientation link + flight recorder"); process.exit(1); }
const SRC = APP.slice(a, b);
const edgeSrc = APP.slice(APP.indexOf("function edgeApiUrl(route) {"), APP.indexOf("\n}\n", APP.indexOf("function edgeApiUrl(route) {")) + 3);

/* ── a fake world: clock, timers, sockets, fetch ─────────────────────────────── */
function world({ search = "", orientUrl = "wss://rt.pear-ai.io/orient", server = {}, pcs = null } = {}) {
  let now = 1_000_000;
  let seq = 1;
  const timers = [];
  const sockets = [];
  const posts = [];
  const warns = [];
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const schedule = (fn, ms, interval) => { const id = seq++; timers.push({ id, at: now + Math.max(0, ms || 0), fn, interval }); return id; };
  const cancel = (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = timers.filter((t) => !t.dead && t.at <= end).sort((x, y) => x.at - y.at || x.id - y.id)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      if (due.interval) due.at += due.interval; else due.dead = true;
      due.fn();
    }
    now = end;
    await flush();
  }
  /* The server end of each socket: answers steps and pings after `stepMs` / `pongMs` (null = never). */
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; this.closed = false;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.push(this);
      schedule(() => { if (this.closed) return; this.readyState = 1; this.onopen && this.onopen(); }, server.openMs ?? 5);
    }
    send(text) {
      if (this.readyState !== 1) throw new Error("not open");
      const m = JSON.parse(text);
      this.sent.push(m);
      const cfg = server.bySocket ? server.bySocket(sockets.indexOf(this)) : server;
      const reply = (obj, ms) => { if (ms === null || ms === undefined) return;
        schedule(() => { if (!this.closed && this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }, ms); };
      if (m.k === "step") reply({ c: m.c, q: m.q, a: [{ do: "log", line: "x" }, { do: "swap", next: "back", predictive: true }] }, cfg.stepMs);
      if (m.k === "ping") reply({ k: "pong", q: m.q }, cfg.pongMs);
    }
    close() { this.closed = true; this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const sandbox = {
    PEAR_ORIENT_URL: orientUrl, PEAR_BUILD: "test",
    location: { search, protocol: "https:", host: "app.pear-ai.io" },
    WebSocket: FakeWS,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: cancel,
    Date: class extends Date { static now() { return now; } },
    document: { hidden: false },
    navigator: { userAgent: "test-agent" },
    console: { log() {}, warn: (...m) => warns.push(m.join(" ")), error() {} },
    fetch: (url, init) => { posts.push({ url, init }); return Promise.resolve({ ok: true }); },
    ...(pcs ? { window: { __pearPCs: new Set(pcs) } } : {}),
  };
  const body = edgeSrc + "\n" + SRC + `
return { orientLinkConnect, orientLinkDrop, orientLinkPing, orientLinkEnsureFresh, orientLinkKeepAlive, openOrientChannel,
  traceEnabled, traceSessionBegin, traceOrient, traceSessionEnd, trace: () => _trace, TRACE_MAX_EVENTS,
  ORIENT_LINK_STEP_TIMEOUT_MS, ORIENT_LINK_STEP_HARD_MS, ORIENT_LINK_PONG_TIMEOUT_MS, ORIENT_LINK_PING_MS, RTC_SAMPLE_MS };`;
  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { api, advance, sockets, posts, warns, now: () => now, intervals: () => timers.filter((t) => !t.dead && t.interval).map((t) => t.interval) };
}
const SAMPLE = { t: 1, vote: "front", faceSeen: true, poseVoted: false, profileScore: 0.2, yawAbs: 38.6, yawAt: 1, lostAt: 0, lock: "front", profile: false, dualView: true };
/* Run one step to completion on the fake clock; resolves { acts, at } (at = ms it took). */
async function stepThrough(w, chan, ms = 10000) {
  const t0 = w.now();
  let out, done = false;
  chan.step({ ...SAMPLE, t: t0 }).then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 50) await w.advance(50);
  return { acts: out, done, took: w.now() - t0 };
}

console.log("── §1 a slow reply on a live link is delivered, not dropped ──");
{
  const w = world({ server: { stepMs: 8, pongMs: 5 } });
  const ch = w.api.openOrientChannel();
  const r = await stepThrough(w, ch);
  check("a healthy link answers a step with its actions", r.done && Array.isArray(r.acts) && r.acts.some((x) => x.do === "swap"), JSON.stringify(r));

  const slow = world({ server: { stepMs: 1700, pongMs: 5 } });
  const sc = slow.api.openOrientChannel();
  const s = await stepThrough(slow, sc);
  check("a reply that lands AFTER the soft timeout, on a link that answers a ping, is still applied",
    s.done && Array.isArray(s.acts) && s.acts.some((x) => x.do === "swap") && s.took >= 1700, JSON.stringify(s));
  check("...and the link was NOT dropped for it (one socket, a ping went out)",
    slow.sockets.length === 1 && !slow.sockets[0].closed && slow.sockets[0].sent.some((m) => m.k === "ping") &&
    !slow.warns.some((x) => /dropped/.test(x)), slow.warns.join(" | "));
}

console.log("\n── §2 a link that cannot answer is dropped - and every channel re-opens clean ──");
{
  const w = world({ server: { bySocket: (i) => (i === 0 ? { stepMs: null, pongMs: null } : { stepMs: 8, pongMs: 5 }) } });
  const ch = w.api.openOrientChannel();
  const r = await stepThrough(w, ch);
  const P = w.api.ORIENT_LINK_STEP_TIMEOUT_MS + w.api.ORIENT_LINK_PONG_TIMEOUT_MS;
  check("no reply and no pong: the step resolves null once the ping has failed (soft + pong timeout)",
    r.done && r.acts === null && r.took >= P && r.took < w.api.ORIENT_LINK_STEP_HARD_MS, `took ${r.took}ms, acts ${JSON.stringify(r.acts)}`);
  check("...the socket is closed on purpose and said so once", w.sockets[0].closed && w.warns.some((x) => /dropped \(a step went unanswered and so did a ping\)/.test(x)),
    w.warns.join(" | "));
  const r2 = await stepThrough(w, ch);
  check("the next step connects AT ONCE (no retry back-off) and re-opens its channel before stepping - a fresh engine",
    w.sockets.length === 2 && r2.done && Array.isArray(r2.acts) &&
    w.sockets[1].sent.map((m) => m.k).join(",").startsWith("open,step"), w.sockets[1].sent.map((m) => m.k).join(","));

  const late = world({ server: { bySocket: (i) => (i === 0 ? { stepMs: 5000, pongMs: null } : { stepMs: 8, pongMs: 5 }) } });
  const lc = late.api.openOrientChannel();
  const lr = await stepThrough(late, lc);
  await late.advance(3000);   // the dead socket's reply would have landed now
  check("a reply arriving on a dropped socket is ignored - the step already resolved null", lr.acts === null && late.sockets[0].closed);

  const stuck = world({ server: { stepMs: null, pongMs: 5 } });
  const st = stuck.api.openOrientChannel();
  const sr = await stepThrough(stuck, st);
  check("a link that pongs but never answers the step is abandoned at ORIENT_LINK_STEP_HARD_MS",
    sr.done && sr.acts === null && sr.took >= stuck.api.ORIENT_LINK_STEP_HARD_MS && sr.took < stuck.api.ORIENT_LINK_STEP_HARD_MS + 100 &&
    stuck.sockets[0].closed, `took ${sr.took}ms`);
}

console.log("\n── §3 the keepalive and go-live's freshness check ──");
{
  const w = world({ server: { bySocket: (i) => (i === 0 ? { stepMs: 8, pongMs: null } : { stepMs: 8, pongMs: 5 }) } });
  w.api.orientLinkKeepAlive();
  await w.advance(100);
  check("entering the room opens the link", w.sockets.length === 1 && w.sockets[0].readyState === 1);
  await w.advance(w.api.ORIENT_LINK_PING_MS);
  check("the keepalive pings the open link every ORIENT_LINK_PING_MS", w.sockets[0].sent.some((m) => m.k === "ping"));
  await w.advance(w.api.ORIENT_LINK_PONG_TIMEOUT_MS + 100);
  check("an unanswered keepalive replaces the socket before any turn needs it",
    w.sockets[0].closed && w.sockets.length === 2 && w.sockets[1].readyState === 1, `${w.sockets.length} sockets`);
  w.api.orientLinkKeepAlive();
  await w.advance(w.api.ORIENT_LINK_PING_MS * 2 + 100);
  check("...idempotent: calling it again starts no second keepalive, and a healthy link is kept",
    w.sockets.length === 2 && w.sockets[1].sent.filter((m) => m.k === "ping").length === 2, `${w.sockets[1].sent.filter((m) => m.k === "ping").length} pings`);

  const f = world({ server: { bySocket: (i) => (i === 0 ? { pongMs: null } : { pongMs: 5 }) } });
  f.api.orientLinkConnect();
  await f.advance(50);
  let fresh = false;
  f.api.orientLinkEnsureFresh().then(() => { fresh = true; });
  await f.advance(1500);
  check("go-live: a socket that does not answer is replaced before the session", fresh && f.sockets[0].closed && f.sockets.length === 2 && f.sockets[1].readyState === 1);
  const g = world({ server: { pongMs: 5 } });
  g.api.orientLinkConnect();
  await g.advance(50);
  g.api.orientLinkEnsureFresh();
  await g.advance(200);
  check("...and one that answers is kept", g.sockets.length === 1 && !g.sockets[0].closed);
}

console.log("\n── §4 the flight recorder: a TEST session only, bounded, posted once ──");
{
  const on = (q) => world({ search: q }).api.traceEnabled();
  check("recorded for pear_key=TEST and ?pear_trace=1 - nothing else",
    on("?pear_key=TEST") && on("?x=1&pear_trace=1") && !on("?pear_key=LIVE-STORE") && !on("") && !on("?pear_key=test") && !on("?pear_trace=0"));

  const shopper = world({ search: "?pear_key=LIVE-STORE", server: { stepMs: 8, pongMs: 5 } });
  shopper.api.traceSessionBegin({ item: "x" });
  await stepThrough(shopper, shopper.api.openOrientChannel());
  shopper.api.traceSessionEnd("clip");
  check("a shopper's session records nothing and sends nothing", shopper.api.trace() === null && shopper.posts.length === 0);

  const w = world({ search: "?pear_key=TEST", server: { stepMs: 12, pongMs: 5 } });
  w.api.traceSessionBegin({ item: "OASIS tee" });
  const ch = w.api.openOrientChannel();
  await stepThrough(w, ch);
  w.api.traceOrient("swap-go", { next: "back" });
  const tr = w.api.trace();
  const s = tr && tr.ev.find((e) => e[1] === "s");
  check("each tick is kept: the sample, the round trip, and the actions (debug log lines dropped)",
    !!s && s[2].v === "front" && s[2].y === 39 && s[2].l === "front" && s[2].rtt >= 12 &&
    s[2].a.length === 1 && s[2].a[0].do === "swap", JSON.stringify(s));
  check("...stamped in ms since go-live, with the build and the session number",
    tr.ev.every((e) => typeof e[0] === "number" && e[0] >= 0) && tr.build === "test" && tr.n === 1 && tr.v === 1);
  w.api.traceSessionEnd("clip");
  w.api.traceSessionEnd("teardown");
  check("the record is posted ONCE, to the edge's /trace, as a simple text/plain request",
    w.posts.length === 1 && w.posts[0].url === "https://rt.pear-ai.io/trace" && w.posts[0].init.method === "POST" &&
    w.posts[0].init.headers["Content-Type"] === "text/plain" && JSON.parse(w.posts[0].init.body).end === "clip", JSON.stringify(w.posts.map((p) => p.url)));
  const posted = JSON.parse(w.posts[0].init.body);
  check("...and it carries no image and no URL - numbers, decisions and timings",
    !/https?:|data:|blob:/.test(JSON.stringify(posted.ev)), JSON.stringify(posted.ev).slice(0, 200));

  const big = world({ search: "?pear_trace=1" });
  big.api.traceSessionBegin({});
  for (let i = 0; i < big.api.TRACE_MAX_EVENTS + 50; i++) big.api.traceOrient("x", { i });
  check("bounded: TRACE_MAX_EVENTS events, the rest only counted", big.api.trace().ev.length === big.api.TRACE_MAX_EVENTS && big.api.trace().over === 50);
  big.api.traceSessionBegin({});
  check("a new go-live closes (and posts) the record the last one left open", big.posts.length === 1 && JSON.parse(big.posts[0].init.body).end === "superseded" && big.api.trace().n === 2);

  /* 2026-09-28: the media connection's numbers ride along in a recorded session - a back reference
     acknowledged 2.9s late could say when, not why. Numbers only; nothing decides from them. */
  let statsCalls = 0;
  const fakePc = { connectionState: "connected", getStats: async () => { statsCalls++; return new Map([
    ["a", { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.041, availableOutgoingBitrate: 1_450_000 }],
    ["b", { type: "outbound-rtp", kind: "video", bytesSent: 812345, framesSent: 96, framesPerSecond: 20, frameWidth: 512,
            totalPacketSendDelay: 0.3, qualityLimitationReason: "bandwidth", targetBitrate: 900_000 }],
    ["c", { type: "inbound-rtp", kind: "video", framesPerSecond: 19, framesDecoded: 90, framesDropped: 1, freezeCount: 0 }]]); } };
  const rec = world({ search: "?pear_key=TEST", pcs: [fakePc] });
  rec.api.traceSessionBegin({});
  await rec.advance(rec.api.RTC_SAMPLE_MS * 3 + 10);
  const rtc = rec.api.trace().ev.filter((e) => e[1] === "rtc");
  check("a recorded session samples the media connection every RTC_SAMPLE_MS - round trip, send estimate, bytes, fps, limit",
    rtc.length === 3 && rtc[0][2][0].rtt === 41 && rtc[0][2][0].avail === 1450 && rtc[0][2][0].bs === 812345 &&
    rtc[0][2][0].fpsOut === 20 && rtc[0][2][0].limit === "bandwidth" && rtc[0][2][0].target === 900 && rtc[0][2][0].fpsIn === 19,
    JSON.stringify(rtc));
  const sampling = rec.intervals().filter((ms) => ms === rec.api.RTC_SAMPLE_MS).length;
  rec.api.traceSessionEnd("clip");
  const before = statsCalls;
  await rec.advance(rec.api.RTC_SAMPLE_MS * 4);
  check("...and stops when the record closes - its timer cancelled, not left idling",
    sampling === 1 && rec.intervals().filter((ms) => ms === rec.api.RTC_SAMPLE_MS).length === 0 && statsCalls === before &&
    !/https?:|data:|blob:/.test(rec.posts[0].init.body), `sampling timers before/after: ${sampling}/${rec.intervals().length}`);
  let shopperCalls = 0;
  const quiet = world({ search: "?pear_key=LIVE-STORE", pcs: [{ connectionState: "connected", getStats: async () => { shopperCalls++; return new Map(); } }] });
  quiet.api.traceSessionBegin({});
  await quiet.advance(quiet.api.RTC_SAMPLE_MS * 4);
  check("...and a shopper's session never samples at all", shopperCalls === 0);

  const local = world({ search: "?pear_trace=1", orientUrl: "" });
  local.api.traceSessionBegin({});
  local.api.traceSessionEnd("clip");
  check("no edge (no PEAR_ORIENT_URL) - nothing is posted anywhere", local.posts.length === 0);
}

console.log(fails === 0 ? "\norient-link: OK" : `\norient-link: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
