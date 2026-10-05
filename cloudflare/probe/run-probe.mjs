#!/usr/bin/env node
/* =============================================================================
   PEAR · Cloudflare probe - the client side. Runs from a laptop in Israel against the
   deployed probe Worker and prints the numbers phases 5 and 6 are decided on.

     PROBE_URL=https://pear-probe.<you>.workers.dev PROBE_KEY=<key> node run-probe.mjs
       [--duration 90]            seconds each /cpu session is held open (default 90)
       [--only echo,where,cpu,cpu-do,relay]

   Costs nothing: no render-engine session is opened. /relay is exercised with a
   deliberately INVALID api key, so the engine answers with a refusal - enough to prove the
   relay carries the handshake and its reply byte for byte, without minting anything.
   A real session through the relay is a separate, billed step (~10 credits), taken only
   on request.

   Needs Node 22+ (global WebSocket). Writes probe-results.json beside this file.
   PROBE_UPSTREAM overrides the engine host for the direct comparisons (a local dry run
   points it at a mock; leave it unset for the real measurement).
   ============================================================================= */
import { writeFileSync } from "node:fs";

const BASE = (process.env.PROBE_URL || "").replace(/\/+$/, "");
const KEY = process.env.PROBE_KEY || "";
if (!/^https?:\/\//.test(BASE) || KEY.length < 16) {
  console.error("set PROBE_URL=https://… and PROBE_KEY (≥16 chars) - see README.md");
  process.exit(2);
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const DURATION_S = Number(arg("duration", "90"));
const ONLY = new Set(String(arg("only", "echo,where,cpu,cpu-do,relay")).split(","));
const WS_BASE = BASE.replace(/^http/, "ws") + "/" + KEY;
const UPSTREAM = (process.env.PROBE_UPSTREAM || "https://api3.decart.ai").replace(/\/+$/, "");
const UPSTREAM_WS = UPSTREAM.replace(/^http/, "ws");
const FRAME_MS = 120;   // POSE_SAMPLE_MS in fitting-room/config.js - the room's pose cadence

const results = { at: new Date().toISOString(), base: BASE.replace(/\/\/[^.]+/, "//<worker>") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};
const fmt = (st) => (st ? `median ${st.median}ms · p90 ${st.p90}ms · max ${st.max}ms (n=${st.n})` : "no samples");

function openSocket(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("open timeout")); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve({ ws, openMs: Math.round(performance.now() - t0) }); };
    ws.onerror = () => {};
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error(`closed before open: ${e.code} ${e.reason || ""}`.trim())); };
  });
}

/* 33 pose landmarks, drifting slowly so each frame is a new input (x, y, z, visibility). */
function landmarks(frame) {
  const turn = Math.sin(frame / 40);
  return Array.from({ length: 33 }, (_, i) => [
    +(0.5 + 0.2 * Math.cos(i + turn)).toFixed(4), +(0.1 + i * 0.025).toFixed(4),
    +(0.1 * Math.sin(i * 0.7 + turn)).toFixed(4), 0.99,
  ]);
}

/* ── 1. echo - the distance to the edge ───────────────────────────────────── */
async function echo() {
  const { ws, openMs } = await openSocket(`${WS_BASE}/echo`);
  const rtts = [];
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const t0 = pending.get(m.seq);
    if (t0 !== undefined) { rtts.push(Math.round(performance.now() - t0)); pending.delete(m.seq); }
  };
  for (let seq = 0; seq < 60; seq++) {
    pending.set(seq, performance.now());
    ws.send(JSON.stringify({ seq }));
    await sleep(50);
  }
  await sleep(500);
  ws.close(1000, "done");
  results.echo = { openMs, rtt: stats(rtts) };
  console.log(`echo      open ${openMs}ms · round trip ${fmt(results.echo.rtt)}`);
}

/* ── 2. where - which colo, and how far the engine is from it ─────────────── */
async function where() {
  const r = await fetch(`${BASE}/${KEY}/where`);
  const body = await r.json();
  const local = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    let status = 0;
    try { status = (await fetch(UPSTREAM + "/", { redirect: "manual" })).status; } catch { status = -1; }
    local.push({ ms: Math.round(performance.now() - t0), status });
  }
  results.where = { ...body, fromThisMachine: local };
  const steady = (xs) => xs.slice(1).map((x) => x.ms);
  console.log(`where     colo ${body.colo} (${body.city || "?"}, ${body.country || "?"})`);
  console.log(`          engine host from the colo:     ${steady(body.upstreamRoundTrips).join(" / ")} ms (after the first)`);
  console.log(`          engine host from this machine: ${steady(local).join(" / ")} ms (after the first)`);
}

/* ── 3. cpu / cpu-do - does a session-long socket survive the free plan? ──── */
async function cpuSession(route, units, seconds = DURATION_S) {
  const label = `${route} n=${units}`;
  let opened;
  try { opened = await openSocket(`${WS_BASE}/${route}?n=${units}`); }
  catch (e) { console.log(`${label.padEnd(16)} ✖ could not open: ${e.message}`); return { units, opened: false, error: e.message }; }
  const { ws } = opened;
  const sentAt = new Map();
  const rtts = [];
  let sent = 0, received = 0, closed = null;
  const t0 = performance.now();
  ws.onmessage = (e) => {
    received++;
    try { const m = JSON.parse(e.data); const s = sentAt.get(m.seq); if (s !== undefined) { rtts.push(Math.round(performance.now() - s)); sentAt.delete(m.seq); } } catch {}
  };
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason || "", atS: +((performance.now() - t0) / 1000).toFixed(1) }; };
  const end = t0 + seconds * 1000;
  for (let seq = 0; performance.now() < end && !closed; seq++) {
    sentAt.set(seq, performance.now());
    try { ws.send(JSON.stringify({ seq, t: Date.now(), p: landmarks(seq) })); sent++; } catch { break; }
    await sleep(FRAME_MS);
  }
  await sleep(800);
  const survived = !closed;
  if (survived) ws.close(1000, "done");
  const out = { units, opened: true, openMs: opened.openMs, seconds, sent, received, survived, closed, rtt: stats(rtts) };
  console.log(`${label.padEnd(16)} ${survived ? "✓ survived" : `✖ closed at ${closed.atS}s (${closed.code} ${closed.reason})`}` +
              ` · ${received}/${sent} replies · ${fmt(out.rtt)}`);
  return out;
}

/* ── 4. relay - the handshake, carried byte for byte (invalid key, no credits) ── */
async function handshake(url) {
  const t0 = performance.now();
  return await new Promise((resolve) => {
    const out = { opened: false, openMs: null, firstMessageMs: null, messages: [], close: null };
    let ws;
    try { ws = new WebSocket(url); } catch (e) { resolve({ ...out, error: e.message }); return; }
    const done = setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 8000);
    ws.onopen = () => { out.opened = true; out.openMs = Math.round(performance.now() - t0); };
    ws.onmessage = (e) => {
      if (out.firstMessageMs === null) out.firstMessageMs = Math.round(performance.now() - t0);
      const text = typeof e.data === "string" ? e.data : "<binary>";
      let type = null;
      try { type = JSON.parse(text).type ?? null; } catch {}
      out.messages.push({ type, preview: text.slice(0, 160) });
    };
    ws.onerror = () => {};
    ws.onclose = (e) => { out.close = { code: e.code, reason: (e.reason || "").slice(0, 160) }; clearTimeout(done); resolve(out); };
  });
}
async function relay() {
  const q = "?api_key=probe-invalid-key&model=lucy-vton-3.5";
  const viaRelay = await handshake(`${WS_BASE}/relay/v1/stream${q}`);
  const direct = await handshake(`${UPSTREAM_WS}/v1/stream${q}`);
  const same = JSON.stringify(viaRelay.messages) === JSON.stringify(direct.messages) &&
               viaRelay.close?.code === direct.close?.code;
  results.relay = { viaRelay, direct, sameAnswer: same };
  const line = (h) => `${h.opened ? `open ${h.openMs}ms` : "not opened"} · first reply ${h.firstMessageMs ?? "-"}ms · ` +
                      `close ${h.close ? `${h.close.code} ${h.close.reason}` : "-"} · ${h.messages.length} msg`;
  console.log(`relay     via the Worker: ${line(viaRelay)}`);
  console.log(`          direct:         ${line(direct)}`);
  console.log(`          ${same ? "✓ the relay returned exactly what the engine returns directly" : "✖ the relay's answer differs from the direct one - see probe-results.json"}`);
}

/* ── run ─────────────────────────────────────────────────────────────────── */
console.log(`PEAR probe → ${results.base}  (cpu sessions: ${DURATION_S}s at one frame per ${FRAME_MS}ms)\n`);
const step = async (name, fn) => {
  if (!ONLY.has(name)) return;
  try { await fn(); } catch (e) { results[name] = { error: e.message }; console.log(`${name.padEnd(9)} ✖ ${e.message}`); }
};
await step("echo", echo);
await step("where", where);
/* n=1 and n=40 are held for the whole session: ~0.01ms and ~0.07ms of work per message,
   so they only die if CPU is counted ACROSS the connection. The short n=20000 spike is
   ~30ms per message - over the 10ms line on its own - so it separates a per-message limit
   from a per-connection one. */
await step("cpu", async () => {
  results.cpu = [];
  for (const n of [1, 40]) results.cpu.push(await cpuSession("cpu", n));
  results.cpu.push(await cpuSession("cpu", 20000, 3));
});
await step("cpu-do", async () => {
  results.cpuDo = [];
  for (const n of [1, 40]) results.cpuDo.push(await cpuSession("cpu-do", n));
  results.cpuDo.push(await cpuSession("cpu-do", 20000, 3));
});
await step("relay", relay);

writeFileSync(new URL("./probe-results.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("\nfull numbers: cloudflare/probe/probe-results.json");
