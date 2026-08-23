/* THE ENTRY/EXIT CAMERA BUG regression test - a getUserMedia that resolves into a
   session that has already been torn down.

   REPORTED as "the camera doesn't start; you have to close the fitting room and open it
   again before the stream works", on desktop AND mobile.

   WHY THE EXISTING TEARDOWN DIDN'T COVER IT. fullTeardown() already stopped every track
   it could see, and the widget already removes the iframe after a PEAR_TEARDOWN/ACK
   handshake - so there was no stale *variable* to inherit, and re-implementing that
   teardown would have changed nothing. The hole was one step earlier, in the ORDER of a
   cold first open:

     1. shopper taps "start camera"  → startCamera() awaits getUserMedia()
     2. the browser puts up its permission prompt, and the await parks there for as long
        as the shopper takes to answer - seconds, not milliseconds
     3. shopper closes the modal while the prompt is still up
     4. fullTeardown() runs. localStream is still null - the stream does not exist yet -
        so there is nothing for it to stop, and it correctly stops nothing
     5. the shopper answers "Allow". getUserMedia resolves INTO THE DEAD SESSION,
        assigns a freshly-opened camera track to localStream and binds it to #webcam

   The result is a live capture owned by nobody, with every code path that could have
   stopped it already run. The device stays lit, and the next open asks the OS for a
   camera the previous document is still holding - which is exactly "close and reopen it
   again and then it works", because by the second open the orphan has finally been
   collected.

   THE FIX: a generation counter. startCamera() captures cameraGen before awaiting and
   re-checks it after; fullTeardown() bumps it. A stream that arrives late finds the
   generation moved and stops its own tracks instead of installing itself.

   This runs the REAL startCamera() extracted from app.js against a getUserMedia whose
   resolution this suite controls, so the race can be reproduced deterministically rather
   than described. */
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

const startCameraSrc = extract(
  "async function startCamera(facing = cameraFacing) {",
  "\n/* Sample ONE frame of ANY <video> element");

check("extracted startCamera", /navigator\.mediaDevices\.getUserMedia/.test(startCameraSrc),
  "startCamera no longer calls getUserMedia - has it been restructured?");

/* A MediaStream stand-in that records whether anything ever stopped it. That single fact
   is what the whole suite turns on: an orphaned stream is precisely one whose stop() was
   never called. */
function makeStream(id) {
  const tracks = [
    { id: id + ":video", kind: "video", contentHint: "", stopped: false, stop() { this.stopped = true; } },
  ];
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
    get stopped() { return tracks.every((t) => t.stopped); },
  };
}

function makeHarness() {
  /* getUserMedia is left PENDING until the test resolves it by hand - that gap is the
     permission prompt, and it is the whole subject of this suite. */
  let release = null;
  const gum = () => new Promise((res, rej) => { release = { res, rej }; });

  const webcam = {
    srcObject: null,
    onloadedmetadata: null,
    videoWidth: 640, videoHeight: 480,
    loadCalls: 0,
    load() { this.loadCalls++; },
    play: async () => {},
  };
  const els = {
    webcam,
    camError: { hidden: false },
    captureBtn: { disabled: true },
    cameraCard: { dataset: {}, classList: { add() {}, remove() {} } },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { mediaDevices: { getUserMedia: gum } },
    $: (id) => els[id] || null,
    card: () => els.cameraCard,
    t: (k) => k,
    isDemoLocked: () => false,
    toast() {},
    showDemoLockedScreen() {},
    showPearLoader() {},
    hidePearLoader() {},
    showCamError() {},
    buildVideoConstraints: () => ({ facingMode: "user" }),
  };

  /* The module-level session state startCamera() reads and MUTATES. Declared inside the
     evaluated body for the same reason prompt-only-flip.test.mjs declares its own: an
     undeclared assignment inside new Function() is sloppy-mode global creation, so one
     harness's camera would leak onto globalThis and be read by the next. */
  const body =
    "let localStream = null; let cameraStartPromise = null; let cameraGen = 0;\n" +
    "let cameraFacing = 'user'; let cameraOrientation = 'landscape';\n" +
    startCameraSrc +
    "\nreturn { startCamera," +
    " state: () => ({ localStream, cameraStartPromise, cameraGen })," +
    /* What fullTeardown() does to this state, and nothing else - the point under test is
       that startCamera() respects the bump, not how the teardown is spelled. The real
       fullTeardown() is asserted separately, against source, at the bottom. */
    " teardown: () => { cameraGen++; cameraStartPromise = null;" +
    " if (localStream) { localStream.getTracks().forEach((tr) => tr.stop()); localStream = null; } } };";

  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { api, els, resolveGum: (s) => release.res(s), rejectGum: (e) => release.rej(e) };
}

console.log("\n── the reported bug: the modal is closed while the permission prompt is up ──");
{
  const { api, els, resolveGum } = makeHarness();
  const stream = makeStream("orphan");

  const pending = api.startCamera("user");        // parks on the permission prompt
  check("the request is in flight and nothing is bound yet",
    api.state().localStream === null && els.webcam.srcObject === null);

  api.teardown();                                  // the shopper closes the fitting room
  resolveGum(stream);                              // ...and only THEN answers "Allow"
  const ok = await pending;

  check("THE FIX: the late stream's tracks are stopped, not left running",
    stream.stopped === true,
    "the camera would stay lit after the room closed - this is the reported bug");
  check("...it never becomes the module-level camera",
    api.state().localStream === null, String(api.state().localStream && api.state().localStream.id));
  check("...it is never bound to #webcam",
    els.webcam.srcObject === null, String(els.webcam.srcObject && els.webcam.srcObject.id));
  check("...and startCamera() reports failure rather than a phantom success", ok === false, String(ok));
}

console.log("\n── the control: no teardown, so the stream installs exactly as before ──");
{
  const { api, els, resolveGum } = makeHarness();
  const stream = makeStream("live");

  const pending = api.startCamera("user");
  resolveGum(stream);
  const ok = await pending;

  check("the stream is installed", api.state().localStream === stream);
  check("...bound to #webcam", els.webcam.srcObject === stream);
  check("...its tracks are NOT stopped", stream.stopped === false);
  check("...and startCamera() reports success", ok === true, String(ok));
  check("the capture button is enabled", els.captureBtn.disabled === false);
  /* The guard must not leak into the happy path: a session that was never torn down has
     to end with the promise cache cleared so the NEXT call can issue a fresh request. */
  check("cameraStartPromise is cleared after a successful open",
    api.state().cameraStartPromise === null);
}

console.log("\n── a denial still fails cleanly, and still leaves nothing running ──");
{
  const { api, els, rejectGum } = makeHarness();
  const pending = api.startCamera("user");
  rejectGum(new Error("NotAllowedError"));
  const ok = await pending;
  check("a denied permission returns false", ok === false, String(ok));
  check("...and binds nothing", api.state().localStream === null && els.webcam.srcObject === null);
}

console.log("\n── two opens across a teardown: the second gets a genuinely fresh request ──");
{
  const { api, resolveGum } = makeHarness();
  const first = makeStream("first");

  const p1 = api.startCamera("user");
  api.teardown();
  resolveGum(first);
  await p1;
  check("the first (abandoned) stream is stopped", first.stopped === true);

  /* The real regression behind "close and reopen and then it works": if the cached
     cameraStartPromise survived the teardown, this second call would return the FIRST,
     already-settled request instead of issuing a new one - and the reopened room would
     sit on a camera that never starts. */
  const second = makeStream("second");
  const p2 = api.startCamera("user");
  resolveGum(second);
  const ok = await p2;
  check("the reopened session issues its own getUserMedia and installs THAT stream",
    ok === true && api.state().localStream === second,
    String(api.state().localStream && api.state().localStream.id));
  check("...and the second stream is left running", second.stopped === false);
}

console.log("\n── fullTeardown() itself: the bump, the cache clear, the hardware release ──");
{
  const fullTeardownSrc = extract("function fullTeardown() {", "\n/* The host widget sends this");

  check("fullTeardown() bumps the camera generation",
    /cameraGen\+\+/.test(fullTeardownSrc),
    "without this, a getUserMedia parked on the permission prompt still installs itself");
  check("...clears the cached in-flight request",
    /cameraStartPromise\s*=\s*null/.test(fullTeardownSrc),
    "a surviving promise makes the next startCamera() re-return the dead one");
  check("...still stops the live preview tracks (unchanged)",
    /localStream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(fullTeardownSrc));
  check("...detaches #webcam", /srcObject\s*=\s*null/.test(fullTeardownSrc));
  /* srcObject = null detaches; load() is what makes the element drop its own internal
     handle on the stopped stream, which is the difference between the device indicator
     going out now and going out whenever the element is finally collected. */
  check("...and calls load() to drop the element's own handle on the dead stream",
    /\bv\.load\(\)/.test(fullTeardownSrc));

  /* Ordering is load-bearing: the bump has to be visible to a startCamera() that is
     already parked on its await, which means it must not sit behind anything that can
     throw. It is the first statement after teardown(). */
  const bumpAt = fullTeardownSrc.indexOf("cameraGen++");
  const stopAt = fullTeardownSrc.indexOf("localStream.getTracks()");
  check("the generation is bumped BEFORE the track stop, so the guard is total",
    bumpAt !== -1 && stopAt !== -1 && bumpAt < stopAt, `bump@${bumpAt} stop@${stopAt}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll camera-lifecycle checks passed.");
process.exit(fails ? 1 : 0);
