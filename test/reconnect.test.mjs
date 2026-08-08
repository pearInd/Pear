/* THE STATE-REVERSION BUG regression test - what happens when the SDK's OWN
   reconnect (not this file's) succeeds or gives up mid-session.

   BACKGROUND: @decartai/sdk@0.1.5's StreamSession already retries a dropped
   mid-session connection internally - handleConnectionLoss() → scheduleReconnect(),
   p-retry, 5 attempts, 1s/2s/4s/8s/10s backoff - and reports it through the exact
   onConnectionChange("reconnecting") callback this file already wires up. This file
   does not need to reimplement that reconnect loop, and does not need a literal
   outgoing-message queue either.

   TWO REAL BUGS were found by reading the SDK's own source rather than assuming its
   behaviour, and both are fixed in buildRealtimeConnectOpts()'s onConnectionChange
   handler and applyActive():

   BUG 1 - STATE REVERSION. scheduleReconnect()'s internal runOneConnect() resends
   getInitialState(), which reads this.config.initialImage/initialPrompt - captured
   ONCE at the original client.realtime.connect() call and never updated by any later
   rtClient.set()/setPrompt() (confirmed: neither method touches those fields). So an
   SDK-level reconnect silently puts the shopper back in whatever garment/pose was
   live at the ORIGINAL go-live moment, discarding every colour swap, orientation
   flip or profile-pose update sent since - with no error, nothing to say it
   happened. FIX: on a "reconnecting" -> "connected"/"generating" transition (for a
   session that had actually dressed the shopper), re-run applyActive() - which
   re-derives whatever is CURRENTLY true rather than replaying anything, so it is
   correct even if the shopper kept interacting during the outage.

   BUG 2 - ZOMBIE SESSION ON PERMANENT FAILURE. When scheduleReconnect() exhausts all
   5 attempts, the SDK settles at "disconnected" and emits "error" - this file's
   EXISTING rtClient.on("error", ...) listener already shows a message for that, but
   nothing retired the session: billing timers, the recorder and the orientation
   watcher kept running against a connection the SDK had already given up on. FIX: a
   "reconnecting" -> "disconnected" transition calls stopLive(), never a bare
   "connected" -> "disconnected" step (which is what teardown() ALSO produces, and
   must not re-enter itself while unwinding).

   THIRD FIX, in applyActive(): while connState is "reconnecting", every call site
   (colour taps, orientation flips, profile updates - none of which have anything
   useful to do with a rejection) skips cleanly instead of burning its own 200ms×2
   retry against a recovery that operates on a completely different timescale. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

/* ═══════════════════════════ onConnectionChange ═══════════════════════════ */

const optsCode = extract("function buildRealtimeConnectOpts(gen)", "\nasync function connectRealtime()");

function makeConnHarness() {
  const calls = { applyActive: 0, stopLive: 0, setConn: [], toast: [] };
  const sandbox = {
    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    document: { querySelector: () => ({ style: {}, play: () => Promise.resolve() }) },
    armFirstFrameBilling: () => {},
    setConn: (s) => calls.setConn.push(s),
    toast: (msg) => calls.toast.push(msg),
    applyActive: () => { calls.applyActive++; return Promise.resolve(); },
    stopLive: () => { calls.stopLive++; },
    console: { log() {}, warn() {}, error() {} },
    // Mutable module-level state the handler reads/writes as real `let`s.
    sessionGen: 1, connState: "connecting", isGarmentApplied: false,
  };
  const body = optsCode +
    "\nreturn { build: (gen) => buildRealtimeConnectOpts(gen)," +
    " state: () => ({ connState, isGarmentApplied, sessionGen })," +
    " setIsGarmentApplied: (v) => { isGarmentApplied = v; }," +
    " setSessionGen: (v) => { sessionGen = v; } };";
  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  const opts = api.build(1);   // gen === sandbox's initial sessionGen (1) - not stale
  return { opts, api, calls };
}

console.log("── BUG 1 FIX: a successful SDK reconnect re-applies the CURRENT state ──");
{
  const { opts, api, calls } = makeConnHarness();
  api.setIsGarmentApplied(true);         // the shopper HAD dressed successfully
  opts.onConnectionChange("connecting");
  opts.onConnectionChange("connected");   // initial connect
  opts.onConnectionChange("reconnecting"); // a mid-session drop
  opts.onConnectionChange("connected");   // the SDK recovered on its own
  check("applyActive() was called exactly once - only on the RECOVERY, not the initial connect",
    calls.applyActive === 1, `called ${calls.applyActive} times`);
}
{
  const { opts, api, calls } = makeConnHarness();
  api.setIsGarmentApplied(true);
  opts.onConnectionChange("connecting");
  opts.onConnectionChange("connected");
  check("the FIRST connect alone never triggers a re-apply (prevState was never 'reconnecting')",
    calls.applyActive === 0);
}
{
  // "generating" is the other live state the SDK reports (markGenerating()) - the
  // re-apply must fire for it too, not only the bare "connected" value.
  const { opts, api, calls } = makeConnHarness();
  api.setIsGarmentApplied(true);
  opts.onConnectionChange("reconnecting");
  opts.onConnectionChange("generating");
  check("recovery into 'generating' (not just 'connected') also triggers the re-apply",
    calls.applyActive === 1);
}
{
  // Nothing to re-apply if the shopper never successfully dressed in the first place -
  // isGarmentApplied gates this so an empty/failed session doesn't fire a pointless set().
  const { opts, calls } = makeConnHarness();   // isGarmentApplied left false
  opts.onConnectionChange("reconnecting");
  opts.onConnectionChange("connected");
  check("no re-apply when isGarmentApplied is false (nothing was ever actually dressed)",
    calls.applyActive === 0);
}

console.log("\n── BUG 2 FIX: permanent reconnect failure retires the session ──");
{
  const { opts, calls } = makeConnHarness();
  opts.onConnectionChange("connected");
  opts.onConnectionChange("reconnecting");
  opts.onConnectionChange("disconnected");   // the SDK exhausted all 5 internal attempts
  check("stopLive() was called exactly once on a reconnect-exhausted permanent failure",
    calls.stopLive === 1, `called ${calls.stopLive} times`);
}
{
  /* THE GUARD THAT MATTERS MOST: an ordinary teardown() ALSO drives the session through
     "connected" -> "disconnected" (that transition is teardown()'s OWN job, via
     rtClient.disconnect()). If this fix fired stopLive() on every "disconnected" arrival
     regardless of history, a normal user-initiated Stop would recursively call stopLive()
     from inside the callback teardown() itself triggers - re-entering a function that is
     already mid-unwind. Scoping to prevState === "reconnecting" is what prevents that:
     a manual stop never passes through "reconnecting" first. */
  const { opts, calls } = makeConnHarness();
  opts.onConnectionChange("connected");
  opts.onConnectionChange("disconnected");   // ordinary teardown()-driven transition
  check("an ordinary connected -> disconnected step (a normal Stop) does NOT re-enter stopLive()",
    calls.stopLive === 0, `called ${calls.stopLive} times`);
}
{
  const { opts, calls } = makeConnHarness();
  opts.onConnectionChange("connecting");
  opts.onConnectionChange("disconnected");   // the very first connect failed outright
  check("an initial connect failure (never reached 'reconnecting') does not call stopLive()",
    calls.stopLive === 0);
}

console.log("\n── stale-callback guard: a torn-down session's late events are no-ops ──");
{
  const { opts, api, calls } = makeConnHarness();
  api.setIsGarmentApplied(true);
  opts.onConnectionChange("reconnecting");
  api.setSessionGen(99);       // a NEW session has since started (sessionGen bumped)
  opts.onConnectionChange("connected");   // late callback from the OLD (gen=1) client
  check("a late callback from a superseded session never fires the re-apply",
    calls.applyActive === 0);
  check("...nor the teardown path",
    calls.stopLive === 0);
}

console.log("\n── the badge and a one-time toast both distinguish reconnecting from connecting ──");
{
  const { opts, calls } = makeConnHarness();
  opts.onConnectionChange("connecting");
  opts.onConnectionChange("connected");
  opts.onConnectionChange("reconnecting");
  check("setConn('reconnecting') is issued as its own distinct state (not collapsed into 'connecting')",
    calls.setConn.includes("reconnecting"), JSON.stringify(calls.setConn));
  check("a toast fires once on entering reconnecting",
    calls.toast.some((t) => /מתחבר מחדש/.test(t)), JSON.stringify(calls.toast));
  opts.onConnectionChange("connected");
  check("...and a recovery toast fires once the SDK recovers",
    calls.toast.some((t) => /החיבור חזר/.test(t)), JSON.stringify(calls.toast));
}

/* ═══════════════════════════ applyActive() reconnect skip ═══════════════════════════ */

const applyActiveCode = extract("async function applyActive() {",
  "\n/**\n * Render BOTH garments of a verified look in ONE realtime set() call");

function makeApplyHarness(initialConnState, initialGarmentApplied = false) {
  const calls = { resolveLook: 0, applyGarment: 0, applyLook: 0 };
  const sandbox = {
    console: { log() {}, warn() {} },
    APPLY_ATTEMPTS: 2, APPLY_RETRY_MS: 1,     // 1ms so a real (unskipped) run stays fast in the suite
    resolveLook: () => { calls.resolveLook++; return null; },
    applyGarment: async () => { calls.applyGarment++; },
    applyLook: async () => { calls.applyLook++; },
    activeItem: { id: "x" },
    connState: initialConnState,
    isGarmentApplied: initialGarmentApplied,
  };
  const body = applyActiveCode +
    "\nreturn { applyActive, state: () => ({ isGarmentApplied }) };";
  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { api, calls };
}

console.log("\n── applyActive() skips ONLY an already-dressed session mid-reconnect ──");
{
  // The case the skip exists for: a PREVIOUSLY successful session hits a blip. Safe to
  // skip because onConnectionChange's Bug-1 fix will re-apply once the SDK recovers.
  const { api, calls } = makeApplyHarness("reconnecting", /* isGarmentApplied */ true);
  await api.applyActive();     // must not throw
  check("resolveLook()/applyGarment() were never called - no doomed set() attempt fired",
    calls.resolveLook === 0 && calls.applyGarment === 0);
}
{
  /* THE GUARD THAT MATTERS MOST HERE: a FIRST-EVER apply (isGarmentApplied still false,
     e.g. goLive()'s own initial call) racing a reconnect that just started must NOT
     skip - there is no earlier "dressed" state for the reconnect-recovery handler to
     restore (it is ALSO gated on isGarmentApplied, see that handler's test above), so
     skipping here would strand the shopper undressed with no error and nothing to ever
     redress them. It must fall through to the normal retry/fail path instead, exactly
     as if this guard did not exist for this one case. */
  const { api, calls } = makeApplyHarness("reconnecting", /* isGarmentApplied */ false);
  let threw = null;
  try { await api.applyActive(); } catch (e) { threw = e; }
  check("a first-ever apply is NOT skipped - it still attempts the real path",
    calls.resolveLook === 1 && calls.applyGarment === 1, JSON.stringify(calls));
}
{
  // The guard must not swallow the ORDINARY path - every other connState still applies normally.
  const { api, calls } = makeApplyHarness("connected");
  await api.applyActive();
  check("a normal 'connected' state still runs the real apply path",
    calls.resolveLook === 1 && calls.applyGarment === 1, JSON.stringify(calls));
  check("...and isGarmentApplied is set on success, exactly as before this change",
    api.state().isGarmentApplied === true);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
