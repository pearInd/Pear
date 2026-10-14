/* THE LAG, ACTED ON - TEST sessions only (2026-10-14): a slow render holds a turn's swap for the excess over the lag the
   turn was tuned on (PEAK record mv8fml6z: the back landed on a body still facing the lens at a 1.32s lag). Pins: no hold
   at a normal lag, no hold outside a recorded session or before the reveal, the live median before the stored prior, the
   cap, ?lag_comp=0, and the tick routing a held swap through delayedSwap() with its record. */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond && detail !== undefined) console.log(`        ${detail}`); }
const between = (a, b) => { const i = APP.indexOf(a); if (i < 0) throw new Error(a); return APP.slice(i, APP.indexOf(b, i)); };
const src = between("const LAG_COMP_BASE_MS", "/* ── end flight recorder ── */");
function run({ probe, billing = true, search = "", prior = null }) {
  const store = new Map(prior === null ? [] : [["pear_render_lag_ms", String(prior)]]);
  const sb = { _lagProbe: probe, billingStarted: billing, location: { search },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) } };
  return new Function(...Object.keys(sb), src + "\nreturn lagCompensationMs();")(...Object.values(sb));
}
const P = (lags) => ({ lags });
check("a normal lag (0.83-0.9s, the sessions the turn was tuned on) holds nothing", run({ probe: P([834, 850, 880]) }).ms === 0);
check("the reported session's 1.32s holds ~0.4s", run({ probe: P([1174, 1163, 1291, 1231, 1324]) }).ms === 331);
check("capped at 0.6s", run({ probe: P([2400, 2500]) }).ms === 600);
check("no recorded session (no probe) - nothing, a shopper's session is untouched", run({ probe: null }) === null);
check("before the reveal - nothing (the first front lock is not held)", run({ probe: P([1500]), billing: false }) === null);
check("?lag_comp=0 is the room before it", run({ probe: P([1500]), search: "?lag_comp=0" }) === null);
const pr = run({ probe: P([]), prior: 1500 });
check("no reading yet (a still body before the turn): the previous session's median", pr.ms === 600 && pr.from === "prior", JSON.stringify(pr));
const lv = run({ probe: P([1000]), prior: 1500 });
check("...and the live reading wins once there is one", lv.from === "live" && lv.ms === 100, JSON.stringify(lv));
check("no reading and no prior - nothing", run({ probe: P([]) }) === null);
check("the session's median is stored for the next one (5+ readings)",
  /if \(s\.length >= 5\) \{ try \{ localStorage\.setItem\(LAG_PRIOR_KEY, String\(s\[s\.length >> 1\]\)\); \}/.test(APP));
check("the tick holds a swap for the larger of the engine's delay and the compensation, through delayedSwap(), recorded",
  /const comp = typeof lagCompensationMs === "function" \? lagCompensationMs\(\) : null;/.test(APP) &&
  /traceOrient\("lag-comp", \{ next: a\.next, ms: comp\.ms, lag: comp\.lag, from: comp\.from \}\)/.test(APP) &&
  /const delay = Math\.max\(Number\(a\.delay\) \|\| 0, comp && comp\.ms > 0 \? comp\.ms : 0\);/.test(APP) &&
  /delayedSwap\(\{ \.\.\.a, delay, lagComp: !!\(comp && comp\.ms > 0\) \}\)/.test(APP));
check("the engine's own projected delay keeps its 400ms cap; only a compensation may reach 600",
  /Math\.min\(a\.lagComp \? 600 : 400, Number\(a\.delay\) \|\| 0\)/.test(APP));
console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
