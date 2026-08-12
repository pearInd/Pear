/* THE SIGNALING-RACE REGRESSION - "המדידה החיה נכשלה: WebSocket is not open".

   REPORTED: a shopper's go-live attempt failed outright with that message, surfaced
   from goLive()'s catch block via connectRealtime()'s re-throw.

   ROOT CAUSE, found by reading @decartai/sdk@0.1.5's signaling channel
   (realtime/signaling-channel.js): openAndJoin() calls openSocket() (which resolves
   once ws.onopen fires), then IMMEDIATELY calls writeMessage({type:"livekit_join"}).
   writeMessage() checks `this.ws?.readyState !== WebSocket.OPEN` and, if the socket
   has already closed again by that exact moment, returns false without sending -
   which openAndJoin() turns into `throw new Error("WebSocket is not open")`, with no
   error code to distinguish it from any other failure. The ek_ token itself was
   already accepted (the socket opened at all); the join handshake lost a narrow race
   against network jitter or a momentarily overloaded signaling server.

   The permanent Decart key was independently confirmed valid for this investigation
   (POST /api/realtime-token minted a real ek_ token, scoped to lucy-vton-latest on
   http://localhost:3000) - this is not a key problem, and connectRealtime() had ZERO
   resilience for this specific transient. One retry fixes the class of failure this
   report describes, without masking a real auth/permission failure (which does not
   carry this message and must still fail on the first attempt).

   This runs the REAL connectRealtime()/buildRealtimeConnectOpts() extracted from
   app.js against a scripted fake SDK client, so the retry/no-retry decision under
   test is the shipped one, not a paraphrase of it. */
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

// buildRealtimeConnectOpts() sits directly above connectRealtime() and is called by
// it, so one contiguous extract carries the real dependency instead of a stub of it.
const code = extract("function buildRealtimeConnectOpts(gen)", "\n/**\n * Single teardown that kills the server-side Decart session");

/* A fresh harness per test: connectRealtime() closes over a page's worth of module
   state, all declared here exactly as `let` locals - same contract the other
   extraction tests in this suite use (see prompt-only-flip.test.mjs). `scriptedErrors`
   lets a test control exactly what client.realtime.connect() does on each successive
   call, which is the whole mechanism under test. */
function makeHarness({ scriptedErrors = [], mintFails = false } = {}) {
  const disposedThrottles = [];
  const mintCalls = [];
  let connectCallCount = 0;
  let tokenCacheSeenAsNull = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } },
    document: { querySelector: () => ({ style: {}, play: () => Promise.resolve() }) },

    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    // The server-supplied model id buildRealtimeConnectOpts() now reads instead of a literal.
    activeVtonModel: "lucy-vton-latest",
    localStream: { getVideoTracks: () => [{ clone: () => ({ id: "clone" }) }] },

    loadSDK: async () => ({
      createDecartClient: () => ({
        realtime: {
          connect: async (_input, _opts) => {
            connectCallCount++;
            const err = scriptedErrors[connectCallCount - 1];
            if (err) throw new Error(err);
            return { disconnect() {}, on() {}, getConnectionState: () => "connected" };
          },
        },
      }),
    }),

    mintEphemeralToken: async () => {
      mintCalls.push(sandbox._tokenCache);   // records whether the cache was null at mint time
      if (mintFails) throw new Error("token mint failed");
      return "ek_test_token";
    },
    createThrottledInputStream: () => {
      const t = { stream: { getTracks: () => [] }, dispose: () => disposedThrottles.push(t) };
      return t;
    },
    isLive: () => false,
    setConn: () => {},
    armFirstFrameBilling: () => {},

    // Mutable module-level state connectRealtime() reads/writes, as real `let`s.
    rtClient: null, connState: "idle", connecting: false,
    lastSentImageRef: "x", rtImageOnWire: true,
    _tokenCache: null, sessionGen: 0, realtimeInput: null, inputThrottle: null,
    firstFrameGuardTimer: null, billingStarted: false, dressedFrameReady: false,
    isGarmentApplied: false,
  };

  const body =
    code +
    "\nreturn { connectRealtime," +
    " state: () => ({ rtClient, inputThrottle, realtimeInput, connecting, _tokenCache }) };";
  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { api, disposedThrottles, mintCalls, callCount: () => connectCallCount };
}

console.log("── THE FIX: a single signaling-race failure retries once and succeeds ──");
{
  const { api, mintCalls, callCount } = makeHarness({ scriptedErrors: ["WebSocket is not open"] });
  await api.connectRealtime();
  check("connect() was called twice - one failure, one retry",
    callCount() === 2, `called ${callCount()} times`);
  check("...and the session ended up connected (rtClient set)",
    api.state().rtClient !== null);
  check("the retry invalidated the cached token before re-minting (mint saw cache=null on attempt 2)",
    mintCalls.length === 2 && mintCalls[1] === null, JSON.stringify(mintCalls));
}

console.log("\n── TWO consecutive signaling races give up (bounded retry, not a loop) ──");
{
  const { api, callCount } = makeHarness({
    scriptedErrors: ["WebSocket is not open", "WebSocket is not open"],
  });
  let threw = null;
  try { await api.connectRealtime(); } catch (e) { threw = e; }
  check("connect() was attempted exactly twice, then gave up",
    callCount() === 2, `called ${callCount()} times`);
  check("...and the error propagated to the caller (goLive() still shows the Hebrew banner)",
    threw && /WebSocket is not open/.test(threw.message), String(threw));
}

console.log("\n── a DIFFERENT failure (bad key / permission) is NOT retried ──");
{
  /* The narrow message match is load-bearing: retrying an auth failure just doubles
     the latency before the same inevitable error, and could mask a real
     misconfiguration behind "it eventually worked" noise in the console. */
  const { api, callCount } = makeHarness({ scriptedErrors: ["401 Unauthorized: invalid api key"] });
  let threw = null;
  try { await api.connectRealtime(); } catch (e) { threw = e; }
  check("connect() was attempted exactly ONCE - no retry on a non-signaling error",
    callCount() === 1, `called ${callCount()} times`);
  check("...and the real error is what reaches the caller, unmodified",
    threw && /invalid api key/.test(threw.message), String(threw));
}

console.log("\n── the failed attempt's throttle is disposed before retrying or rethrowing ──");
{
  const retried = makeHarness({ scriptedErrors: ["WebSocket is not open"] });
  await retried.api.connectRealtime();
  check("on a successful retry, the FIRST (failed) attempt's throttle was disposed",
    retried.disposedThrottles.length === 1, `disposed ${retried.disposedThrottles.length}`);

  const gaveUp = makeHarness({ scriptedErrors: ["WebSocket is not open", "WebSocket is not open"] });
  try { await gaveUp.api.connectRealtime(); } catch (_) {}
  check("on giving up, BOTH attempts' throttles were disposed - none leaked",
    gaveUp.disposedThrottles.length === 2, `disposed ${gaveUp.disposedThrottles.length}`);
  check("...and state was left clean (no dangling inputThrottle/realtimeInput)",
    gaveUp.api.state().inputThrottle === null && gaveUp.api.state().realtimeInput === null);
}

console.log("\n── success on the FIRST attempt never touches the retry machinery at all ──");
{
  const { api, callCount, mintCalls } = makeHarness({ scriptedErrors: [] });
  await api.connectRealtime();
  check("connect() was called exactly once - the common case pays no extra cost",
    callCount() === 1);
  check("mintEphemeralToken() was called exactly once",
    mintCalls.length === 1);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
