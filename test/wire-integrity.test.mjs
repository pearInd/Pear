/* WHAT ACTUALLY REACHES DECART, AND WHETHER ANYTHING ELSE IS REACHING IT AT THE SAME TIME.

   Four separate mechanisms are pinned here because they failed as one symptom - "the
   garment turns into one nobody chose, mid-session" - and each of them was independently
   capable of producing it:

     §1  the wire mutex telling the truth about what is on the wire, across a session reset
     §2  a reference the SDK can actually decode, rather than one that merely exists
     §3  no dispatch that clears the model's conditioning by omitting an image
     §4  the input gate closing again when the transport is rebuilt under us

   The first two run the REAL functions extracted from app.js; the last two assert
   structure, because they are about which lines exist on a path rather than what a pure
   function returns. */
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

/* ═══════════════════════════════════════════════════════════════════════════════
   §1  THE MUTEX THAT LIED AFTER A RESET
   ───────────────────────────────────────────────────────────────────────────────
   resetConditionWire() zeroes the queue counters because a write belonging to a
   torn-down session must not hold the NEXT session's queue. That is right. What was
   wrong is that the same counter was also what wireBusy() reported - so for the length
   of an in-flight ack after a reset, wireBusy() answered "free" about a wire that had a
   write on it, and every skip-gate in the file (the re-anchor, the presence
   re-condition, the topology re-drape, the freeze keep-alive, and the tracker's
   canDispatch flag) took that as permission to send a second one.

   THE SDK CANNOT TELL TWO CONCURRENT WRITES APART. signaling-channel.js matches an image
   ack with `(msg) => msg.type === "set_image_ack"` - no correlation id - and resolves the
   first pending entry that matches. So the older write resolves on the newer write's ack,
   and applyGarment() pins lastAckedImageRef to a reference Decart never confirmed.
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log("── §1 the wire mutex, across a session reset ──");
{
  const wireSrc = extract("let isSettingCondition = false;", "\n/* Pre-minted ek_ token cache");
  const sandbox = { console: { log() {}, warn() {}, error() {} } };
  const api = new Function(...Object.keys(sandbox),
    wireSrc + "\nreturn { sendCondition, resetConditionWire, wireBusy," +
    " counters: () => ({ wireWrites, wireInFlight, wireEpoch }) };")(...Object.values(sandbox));

  check("a fresh wire is not busy", api.wireBusy() === false);

  /* A write that is genuinely on the wire, held open so the reset lands mid-flight. */
  let releaseFirst;
  const firstSettled = new Promise((r) => { releaseFirst = r; });
  const firstWrite = api.sendCondition("first", () => firstSettled);
  await Promise.resolve();                 // let the queue hand the send to the SDK

  check("...but IS busy while a write is in flight", api.wireBusy() === true,
    JSON.stringify(api.counters()));

  /* THE RESET, exactly as connectRealtime()/applyConditioningWithRecovery() issue it -
     while the write above has not settled. */
  api.resetConditionWire();

  check("resetConditionWire() retires the QUEUE - wireWrites goes to zero",
    api.counters().wireWrites === 0, JSON.stringify(api.counters()));
  check("...and bumps the epoch so the retired write cannot touch it again",
    api.counters().wireEpoch === 1, JSON.stringify(api.counters()));
  check("THE FIX: wireBusy() still reports the write that is physically on the wire",
    api.wireBusy() === true,
    "this returned false before wireInFlight existed - and every skip-gate believed it");
  check("...because the in-flight count is epoch-independent",
    api.counters().wireInFlight === 1, JSON.stringify(api.counters()));

  /* A background write offered during that window must decline rather than collide. */
  const skipped = await api.sendCondition("background", () => Promise.resolve("sent"),
    { skipIfBusy: true });
  check("a skipIfBusy write declines while the stale write is still on the wire",
    skipped === false,
    "this is the dispatch that used to slip through and desynchronise the acks");

  releaseFirst();
  await firstWrite;
  check("...and once it settles the wire reads free again", api.wireBusy() === false,
    JSON.stringify(api.counters()));
  check("...with the in-flight count back to zero, not negative",
    api.counters().wireInFlight === 0, JSON.stringify(api.counters()));

  /* IT CANNOT WEDGE: a REJECTED write must release the wire exactly like a resolved one,
     or one failed set() would make every later background write skip forever. */
  const boom = api.sendCondition("rejecting", () => Promise.reject(new Error("nope")));
  await boom.catch(() => {});
  check("a rejected write releases the wire too", api.wireBusy() === false,
    JSON.stringify(api.counters()));

  /* And the queue still serialises - the property the mutex existed for in the first
     place, which none of the above may quietly have broken. */
  const order = [];
  let releaseA;
  const aDone = new Promise((r) => { releaseA = r; });
  const a = api.sendCondition("A", async () => { order.push("A-start"); await aDone; order.push("A-end"); });
  const b = api.sendCondition("B", async () => { order.push("B-start"); });
  await Promise.resolve();
  check("a queued write waits for its predecessor rather than overlapping it",
    order.join(",") === "A-start", order.join(","));
  releaseA();
  await Promise.all([a, b]);
  check("...and runs once it is free", order.join(",") === "A-start,A-end,B-start", order.join(","));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   §2  A REFERENCE THE SDK CAN ACTUALLY DECODE
   ───────────────────────────────────────────────────────────────────────────────
   @decartai/sdk@0.1.5 utils/media.js imageToBase64() tests a string for a data: URL and
   for an ABSOLUTE http(s) URL, then ends with `return image;` - handing anything else
   back VERBATIM where base64 image bytes belong. A blob: URL reaches that branch (it
   parses, protocol "blob:") and so does any relative URL (new URL() throws). Decart is
   then conditioned on the characters of a URL and renders an arbitrary garment, with no
   error and no log anywhere in the stack.
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §2 can the SDK read this reference at all? ──");
{
  const guardSrc = extract("function usableImageRef(ref) {", "\n/**\n * Fires once per session");
  const sandbox = { Blob, URL, console: { log() {}, warn() {}, error() {} } };
  const api = new Function(...Object.keys(sandbox),
    guardSrc + "\nreturn { usableImageRef, assertUsableImageRef };")(...Object.values(sandbox));
  const u = (v) => api.usableImageRef(v);

  check("a real Blob is usable", u(new Blob(["x"], { type: "image/jpeg" })).usable === true);
  check("a 0-byte Blob is NOT - a composite or decode failed silently",
    u(new Blob([])).usable === false && u(new Blob([])).kind === "empty-blob");
  check("a data: URL with a payload is usable",
    u("data:image/jpeg;base64,AAAA").usable === true);
  check("...but one with nothing after the comma is not",
    u("data:image/jpeg;base64,").usable === false);
  check("an absolute https URL is usable", u("https://cdn.example.com/a.jpg").usable === true);
  check("an absolute http URL is usable", u("http://cdn.example.com/a.jpg").usable === true);

  /* THE TWO THAT USED TO GO OUT SILENTLY. */
  const blobUrl = u("blob:https://shop.example.com/9f2c-441a");
  check("A blob: URL is REFUSED - the SDK would ship the URL string as the reference",
    blobUrl.usable === false && blobUrl.kind === "sdk-fallthrough", JSON.stringify(blobUrl));
  const relative = u("/api/img-proxy?url=https%3A%2F%2Fcdn.example.com%2Fa.jpg");
  check("...and so is a relative URL, which reaches the same fallthrough",
    relative.usable === false && relative.kind === "sdk-fallthrough", JSON.stringify(relative));

  check("an explicit null is refused - the SDK documents it as CLEAR the image",
    u(null).usable === false && u(null).kind === "null");
  check("undefined is refused", u(undefined).usable === false && u(undefined).kind === "absent");
  check("an empty string is refused", u("").usable === false);
  check("a non-Blob object is refused", u({ toString: () => "https://x/y.jpg" }).usable === false);

  /* THE HARD STOP. Refusing has to end the dispatch, not merely describe it. */
  let threw = null;
  try { api.assertUsableImageRef("blob:https://shop.example.com/9f2c", "applyGarment"); }
  catch (e) { threw = e; }
  check("assertUsableImageRef THROWS on an unusable reference rather than warning",
    threw !== null && /unusable garment reference/.test(threw.message), String(threw));
  check("...and names both the call site and the reason, for a bug that is otherwise silent",
    threw !== null && /applyGarment/.test(threw.message) && /sdk-fallthrough/.test(threw.message),
    String(threw && threw.message));
  const good = new Blob(["x"], { type: "image/jpeg" });
  check("...and returns the reference untouched when it is usable - never rewrites a payload",
    api.assertUsableImageRef(good, "applyGarment") === good);

  /* THE SOURCE OF THE ONLY blob: THAT COULD REACH THE WIRE. garmentImageRef() used to
     pass blob: through beside data:, on the stated belief that the SDK treats them alike. */
  const refSrc = extract("function garmentImageRef(cdnUrl) {", "\n/** Console-safe image ref");
  const refApi = new Function("console", "location", "abbrevImg",
    refSrc + "\nreturn garmentImageRef;")(
    { log() {}, warn() {}, error() {} }, { hostname: "shop.example.com", origin: "https://shop.example.com" },
    (v) => String(v));
  check("garmentImageRef() refuses a blob: URL instead of passing it through",
    refApi("blob:https://shop.example.com/9f2c") === undefined,
    "returning undefined puts the caller on the pin/abandon path, which is loud and recoverable");
  check("...while a data: URL still passes through verbatim - custom uploads depend on it",
    refApi("data:image/png;base64,AAAA") === "data:image/png;base64,AAAA");
  check("...and an http(s) CDN URL still becomes an ABSOLUTE proxied ref",
    /^https:\/\/shop\.example\.com\/api\/img-proxy\?url=/.test(refApi("https://cdn.example.com/a.jpg")),
    "relative would hit the same SDK fallthrough a blob: URL does");

  /* Every dispatch site must consult the guard - a new send path that skips it is the
     way this returns. */
  for (const site of ["applyGarment", "applyLook", "applyFallbackConditioning"]) {
    check(`${site}() asserts its reference is readable before building a payload`,
      new RegExp(`assertUsableImageRef\\([a-zA-Z]+, "${site}"\\)`).test(SRC));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   §3  NO DISPATCH MAY CLEAR THE MODEL'S CONDITIONING
   ───────────────────────────────────────────────────────────────────────────────
   `...(image ? { image } : {})` encodes the assumption that an omitted image means "leave
   the conditioning alone". It does not. realtime/methods.js maps BOTH undefined and null
   to session.setImage({ kind: "data", data: null }), which puts image_data: null on the
   wire - an explicit CLEAR. applyGarment() and applyLook() were fixed out of that idiom;
   applyFallbackConditioning() was the one call site still carrying it, and the one where
   it mattered most, because it also sets isGarmentApplied and opens the input gate.
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §3 the fallback may not blank the reference ──");
{
  const fallback = extract("async function applyFallbackConditioning()", "\n/**\n * Open ONE realtime session");
  /* Comments stripped, the same rule turn-hold and image-first follow - and here it is not
     a convenience but the whole point. All three of these functions now carry a comment
     QUOTING the `...(image ? { image } : {})` idiom, because the record of what the bug
     looked like is the most useful thing on that path for whoever reads it next. A check
     that cannot tell a dispatch from an explanation of a retired dispatch would force
     exactly that record to be deleted to stay green. */
  const stripped = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fallbackCode = stripped(fallback);

  check("the conditional image spread is GONE from the fallback dispatch",
    !/\.\.\.\(image \? \{ image \} : \{\}\)/.test(fallbackCode),
    "that spread is what sent image_data: null and wiped the garment mid-recovery");
  check("...and the image key is unconditional on the payload",
    /rtClient\.set\(\{ prompt, enhance: false, image \}\)/.test(fallback), fallback.slice(-600));
  check("it falls back to the session's acknowledged garment before giving up",
    /if \(!image && lastAckedImageRef\)/.test(fallback),
    "the pin applyGarment() and applyLook() already read - this was the one site without it");
  check("...and ABANDONS the dispatch when even that is empty",
    /throw new Error\("\[PEAR\] fallback conditioning: no usable garment reference to send"\)/.test(fallback),
    "sending nothing leaves the model conditioned; sending an image-less set() replaces it");

  /* THROWS rather than returns, and the difference is load-bearing: this function IS the
     recovery, so a silent no-op would let applyConditioningWithRecovery() report success
     over a session with no garment on it. */
  check("the abandon path throws rather than returning quietly",
    !/\n\s*return;\s*\n/.test(fallbackCode.slice(0, fallbackCode.indexOf("await sendCondition"))),
    "a recovery that quietly does nothing is reported to the shopper as success");

  /* THE ORDERING THAT MADE IT WORST. isGarmentApplied and releaseInputGate must come
     AFTER the send, so an abandoned dispatch never declares the shopper dressed. */
  const iSend = fallback.indexOf("await sendCondition");
  check("isGarmentApplied is set only after the send, never before it",
    fallback.indexOf("isGarmentApplied = true") > iSend);
  check("...and the input gate opens after it too",
    fallback.indexOf('releaseInputGate("fallback conditioning")') > iSend,
    "opening the gate over an abandoned dispatch streams frames at an unconditioned model");

  /* The two survivors, re-asserted here so all three sites are pinned in one place. */
  const garment = extract("async function applyGarment(item) {", "\n/**\n * Reads the Screen 1 physical inputs");
  const look = extract("async function applyLook(top, bottom) {", "\n/**\n * Build ONE prompt");
  for (const [name, src] of [["applyGarment", garment], ["applyLook", look]]) {
    check(`${name}() still ships an unconditional image key`,
      !/\.\.\.\(image(Ref)? \? \{ image/.test(stripped(src)),
      "stripped first - both carry the retired idiom in a comment, deliberately");
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   §4  THE GATE CLOSES AGAIN WHEN THE TRANSPORT IS REBUILT
   ───────────────────────────────────────────────────────────────────────────────
   The atomic conditioning gate withholds camera frames until a garment is acknowledged,
   so Decart's first frame can never be one it had to invent. It was one-shot: release()
   returned false forever after. But the window it closes opens more than once - an
   SDK-internal reconnect rejoins the room with only whatever the SDK replays, while our
   frames are already flowing at it.
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §4 the input gate, re-armed on a rebuilt transport ──");
{
  const code = extract("function createThrottledInputStream(", "\n/**\n * Open the input gate");
  const state = { emitted: 0, timers: new Set(), logs: [] };
  const outTrack = { contentHint: "", requestFrame() { state.emitted++; }, stop() {} };
  const sandbox = {
    LIVE_INFERENCE_FPS: 10, LIVE_W: 512, LIVE_H: 288,
    INPUT_GATE_ENABLED: true, INPUT_GATE_MAX_MS: 5000,
    console: { log: (...a) => state.logs.push(a.join(" ")), warn: (...a) => state.logs.push(a.join(" ")) },
    setInterval: (fn) => { const id = { fn }; state.timers.add(id); return id; },
    clearInterval: (id) => state.timers.delete(id),
    setTimeout: (fn, ms) => { const id = { fn, ms, isTimeout: true }; state.timers.add(id); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    MediaStream: class { constructor(t) { this.t = t; } getTracks() { return this.t; } },
    document: {
      createElement: () => ({
        muted: false, playsInline: false, autoplay: false, srcObject: null,
        videoWidth: 640, videoHeight: 360, width: 0, height: 0,
        play: () => Promise.resolve(), pause() {},
        getContext: () => ({ save() {}, restore() {}, setTransform() {}, drawImage() {} }),
        captureStream: () => ({ getVideoTracks: () => [outTrack] }),
      }),
    },
  };
  const fn = new Function(...Object.keys(sandbox),
    code + "\nreturn createThrottledInputStream;")(...Object.values(sandbox));
  const srcStream = {
    getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }],
    getTracks: () => [],
  };
  const throttle = fn(srcStream, { fps: 10, gated: true, gateMaxMs: 5000 });
  const tick = () => [...state.timers].filter((t) => !t.isTimeout).forEach((t) => t.fn());
  const ceilings = () => [...state.timers].filter((t) => t.isTimeout);
  /* The paint loop is started from video.play().then(start), so the interval does not
     exist until that microtask has run. Without this flush every tick() below would be a
     no-op and the frame assertions would pass for the wrong reason - which is exactly the
     kind of green that hides a broken gate. */
  await new Promise((r) => setImmediate(r));

  check("the gate starts shut", throttle.gateOpen === false);
  tick();
  check("...and withholds frames while it is", state.emitted === 0);

  check("release() opens it and reports that it did", throttle.release("garment acknowledged") === true);
  tick();
  check("...and frames flow", state.emitted === 1);
  check("a second release is a no-op", throttle.release("again") === false);

  /* THE FIX. */
  check("THE FIX: rearm() shuts it again for a rebuilt transport",
    throttle.rearm("SDK reconnect in progress") === true,
    "this returned nothing at all before - the gate was one-shot");
  check("...and it really is shut", throttle.gateOpen === false);
  const before = state.emitted;
  tick();
  check("...so frames are withheld from the rejoined session too", state.emitted === before);
  check("...and a fresh self-release ceiling is armed behind it",
    ceilings().length >= 1 && ceilings().some((t) => t.ms === 5000),
    "a reconnect that never lands must cost a late resume, never a dead session");
  check("re-arming an already-shut gate is a no-op", throttle.rearm("twice") === false);

  check("...and the ordinary release re-opens it", throttle.release("applyActive") === true);
  tick();
  check("...frames resume", state.emitted === before + 1);

  /* The ceiling must still be able to rescue a gate nobody releases. */
  throttle.rearm("second reconnect");
  ceilings().forEach((t) => t.fn());
  check("the self-release ceiling still opens a gate nobody released",
    throttle.gateOpen === true,
    "the re-armed gate must inherit the same cannot-strand-a-session guarantee");

  /* AND IT RESPECTS THE KILL SWITCH: an ungated throttle has no gate to re-arm. */
  const ungated = fn(srcStream, { fps: 10, gated: false, gateMaxMs: 5000 });
  check("rearm() is a no-op when the gate is disabled by config",
    ungated.rearm("reconnect") === false && ungated.gateOpen === true,
    "a re-arm that ignored the flag would install a gate the config asked not to exist");

  /* WIRING: exactly one call site, at the earliest moment the transport is known to be
     going away. */
  const opts = extract("function buildRealtimeConnectOpts(gen)",
                       "\n/**\n * Single teardown that kills the server-side Decart session");
  check("the gate is re-armed the moment the SDK reports 'reconnecting'",
    /state === "reconnecting"[\s\S]{0,900}rearmInputGate\("SDK reconnect in progress"\)/.test(opts),
    "later than that and unconditioned frames have already been rendered");
  check("...and nothing else calls rearmInputGate",
    (SRC.match(/rearmInputGate\(/g) || []).length === 2,
    "exactly two: the declaration, and the single call site in onConnectionChange");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
