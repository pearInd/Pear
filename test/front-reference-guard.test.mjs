#!/usr/bin/env node
/* REFERENCE STATE AFTER A FULL 360 - "I turned all the way round and came back wearing a
   Real Madrid shirt."
   =============================================================================
   THE REPORT: front renders correctly, the turn to BACK renders correctly, and completing
   the rotation back to FRONT produces a garment that was never in the catalog - a
   different shirt with sponsor logos. The wrong-garment class, but arriving only on the
   RETURN leg, after both sides have already proven they work.

   THE ASYMMETRY IS THE BUG, and it is visible by reading maybeSwap() top to bottom. The
   `next === "back"` branch does a full pre-flight before it commits to anything:
     1. GARMENT_BACK exists at all;
     2. garmentBlobCached() actually resolves it to a Blob - null means every route
        (proxy AND raw CDN) failed, and the swap is ABANDONED, holding FRONT;
     3. the decoded bitmap is not a flat placeholder.
   Any failure returns without touching autoOrientation, so the reference on the wire stays
   the one that is known good. That guard exists because committing first and discovering
   the asset was missing afterwards is what produced the blank back view.

   `next === "front"` HAS NONE OF IT. It falls straight through to `applying = true;
   autoOrientation = next; await applyActive()`. If the front bytes are not resident by
   then, referenceImageFor() logs "Blob pre-cache miss" and falls back to a URL - and a URL
   means DECART has to fetch it before it can condition on anything. app.js's own
   garmentImageRef() comment puts that fetch at up to 20-25s. Until it lands, the model has
   no reference and renders from its own prior, which is where a Real Madrid jersey comes
   from. The swap has already committed, so the shopper watches it happen.

   WHY THE BYTES CAN BE GONE ON THE RETURN LEG SPECIFICALLY. _assetBlobCache is an LRU
   capped at BLOB_CACHE_MAX = 10 entries, shared across front/back/composite/look-stitch
   and every colour variant touched in the session. The front entry is the OLDEST of the
   pair by definition - it was fetched at go-live, the back was fetched at the first turn -
   so it is the one eviction reaches first. A transient refetch failure does the same thing.
   Neither can happen on the outbound leg, because the guard above catches it there.

   THE FIX IS SYMMETRY, not a new mechanism: give the front leg the same pre-flight the
   back leg already has. If the front bytes cannot be resolved, do not commit the flip -
   leave the lock where it is and let a later tick retry, exactly as the back branch does.
   ============================================================================= */

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const start = SRC.indexOf("  async function maybeSwap(next, predictive = false) {");
const end   = SRC.indexOf("  /* The edge-on counterpart of maybeSwap");
if (start === -1 || end === -1) { console.log("FAIL  could not extract maybeSwap()"); process.exit(1); }
const swapSrc = SRC.slice(start, end);

const FRONT = "https://cdn.test/peak-front.jpg";
const BACK  = "https://cdn.test/peak-back.jpg";

/* Drives the REAL maybeSwap(). The closure variables it mutates are declared inside the
   generated function so the test can read them back through an accessor - injecting them
   as parameters would make every assignment invisible from out here. */
function harness({ frontBlob = { size: 1, type: "image/jpeg" },
                   backBlob  = { size: 1, type: "image/jpeg" },
                   startOrientation = "back", flat = false, applyThrows = false,
                   blobLooksFlat = async () => flat, wire,
                   lastSwapAgoMs = null, lastSwapWasPredictive = false, gate = false } = {}) {
  const calls = [];
  const sandbox = {
    blobLooksFlat,
    /* Only when a test asks for the swap input hold - every other section runs with the name
       undefined, which is the sandbox shape maybeSwap() must tolerate (CLAUDE.md 2.7). */
    ...(gate ? {
      holdInputGate: (why, maxMs) => {
        calls.push({ op: "hold", why, maxMs });
        return { unhold: (w) => { calls.push({ op: "unhold", w }); return true; } };
      },
      ORIENT_SWAP_INPUT_HOLD_MAX_MS: 2000,
    } : {}),
    /* Only when a test states what the wire holds - the other sections run exactly as they did,
       with neither name defined, which is the shape the acquire shortcut must tolerate. */
    ...(wire ? { lastSentImageRef: wire.onWire,
                 garmentBlobIfWarm: (url) => (url === BACK ? backBlob : url === FRONT ? frontBlob : null) } : {}),
    ORIENT_COOLDOWN_MS: 1500, AUTO_ANGLE: "auto", currentAngle: "auto",
    ORIENT_FADE_HOLD_MS: 0,
    GARMENT_FRONT: FRONT, GARMENT_BACK: BACK,
    isLive: () => true,
    console: { log() {}, warn: (...a) => calls.push({ op: "warn", a }), error: (...a) => calls.push({ op: "error", a }) },
    garmentBlobCached: async (url) => {
      calls.push({ op: "fetch", url });
      return url === FRONT ? frontBlob : backBlob;
    },
    createImageBitmap: async () => ({ close() {} }),
    bitmapLooksFlat: async () => flat,
    _assetBlobCache: new Map(),
    logVtonState: () => {},
    renderPerspectiveSelector: () => {},
    orientHoldBegin: () => calls.push({ op: "holdBegin" }),
    /* Banking the frame and putting it on screen are separate calls as of the
       "the live view freezes whenever I move" fix - a confirmed swap does both, since
       the reference really is being replaced under the shopper. */
    orientHoldPromote: () => calls.push({ op: "holdPromote" }),
    orientHoldExtend: () => calls.push({ op: "holdExtend" }),
    orientHoldEnd: (r) => calls.push({ op: "holdEnd", r }),
    applyActive: async () => {
      calls.push({ op: "applyActive" });
      if (applyThrows) throw new Error("set() failed: ack timeout");
    },
    abbrevImg: (s) => String(s),
    toast: (t) => calls.push({ op: "toast", t }),
    setTimeout: (fn) => { fn(); return 0; },
  };
  const body =
    `let applying = false, disposed = false, autoOrientation = ${JSON.stringify(startOrientation)};\n` +
    `let lastSwapAt = ${lastSwapAgoMs === null ? 0 : `Date.now() - ${lastSwapAgoMs}`};\n` +
    `let lastSwapPredictive = ${lastSwapWasPredictive};\n` +
    swapSrc +
    `\nreturn { maybeSwap, state: () => ({ applying, autoOrientation, lastSwapPredictive }) };`;
  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { ...api, calls };
}

console.log("── §1 THE RETURN LEG: front bytes missing must NOT commit the flip ──");
{
  const { maybeSwap, state, calls } = await (async () => {
    const h = harness({ frontBlob: null, startOrientation: "back" });
    await h.maybeSwap("front");
    return h;
  })();
  check("the front asset is resolved BEFORE the flip is committed",
    calls.some((c) => c.op === "fetch" && c.url === FRONT),
    "the front leg must pre-flight its bytes, exactly as the back leg does");
  check("...and when they cannot be resolved the lock STAYS on back",
    state().autoOrientation === "back",
    "committing to a side whose reference is not on the wire is the whole bug");
  check("...and no apply is dispatched with a reference that is not there",
    !calls.some((c) => c.op === "applyActive"),
    "this dispatch is what falls back to a URL and renders the model's prior meanwhile");
  check("...and the failure is reported rather than passing silently",
    calls.some((c) => c.op === "error" || c.op === "warn"),
    "a silent degrade here is indistinguishable from the hallucination it causes");
  check("...and `applying` is left clear so a later tick can retry",
    state().applying === false,
    "a stuck applying flag would freeze the orientation for the rest of the session");
  void maybeSwap;
}

console.log("\n── §2 THE HAPPY PATH still commits, or the guard is just a blocker ──");
{
  const h = harness({ startOrientation: "back" });
  await h.maybeSwap("front");
  check("a resolvable front asset commits the flip",
    h.state().autoOrientation === "front");
  check("...and dispatches the apply",
    h.calls.some((c) => c.op === "applyActive"));
  check("...and releases the hold on completion",
    h.calls.some((c) => c.op === "holdEnd" && c.r === "swap-complete"));
}

console.log("\n── §3 THE BACK LEG is unchanged - its guard was already right ──");
{
  const h = harness({ backBlob: null, startOrientation: "front" });
  await h.maybeSwap("back");
  check("a missing back asset still holds FRONT and dispatches nothing",
    h.state().autoOrientation === "front" && !h.calls.some((c) => c.op === "applyActive"));

  const flat = harness({ startOrientation: "front", flat: true });
  await flat.maybeSwap("back");
  check("a flat/placeholder back is still rejected before committing",
    flat.state().autoOrientation === "front" && !flat.calls.some((c) => c.op === "applyActive"));

  const ok = harness({ startOrientation: "front" });
  await ok.maybeSwap("back");
  check("...and a good back still swaps normally",
    ok.state().autoOrientation === "back" && ok.calls.some((c) => c.op === "applyActive"));
}

console.log("\n── §4 ACQUISITION is still a state record, not a swap ──");
{
  /* PENDING → front at go-live already has the front reference on the wire from connect,
     so it must stay a bookkeeping update with no dispatch and no fetch. A front guard that
     forced a fetch here would put a network round trip on the go-live path. */
  const h = harness({ startOrientation: null, frontBlob: null });
  await h.maybeSwap("front");
  check("acquiring FRONT records the lock without dispatching",
    h.state().autoOrientation === "front" && !h.calls.some((c) => c.op === "applyActive"));
  check("...and without a fetch, even with no bytes resident",
    !h.calls.some((c) => c.op === "fetch"),
    "the reference is already on the wire from connect - re-resolving it buys nothing");
}
{
  /* THE ONE PLACE THE LOCK ADVANCED WITHOUT A DISPATCH. "Already rendered" is true at
     connect, and false after a mid-session watcher rebuild (a stop/start across an SDK
     reconnect, a mode round-trip) resets the lock to PENDING while GARMENT_BACK is still
     the reference on the wire. Recording FRONT there left the back on the shopper's front
     until the next re-anchor happened to notice. The shortcut now checks the wire first. */
  const back = { size: 9, type: "image/jpeg" };
  const h = harness({ startOrientation: null, backBlob: back, wire: { onWire: back } });
  await h.maybeSwap("front");
  check("acquiring FRONT while GARMENT_BACK is on the wire DISPATCHES the front instead of recording it",
    h.state().autoOrientation === "front" && h.calls.some((c) => c.op === "applyActive"),
    JSON.stringify(h.calls.map((c) => c.op)));
  check("...through the normal front leg, so its bytes are pre-flighted like any return",
    h.calls.some((c) => c.op === "fetch" && c.url === FRONT));
  const front = { size: 8, type: "image/jpeg" };
  const ok = harness({ startOrientation: null, frontBlob: front, wire: { onWire: front } });
  await ok.maybeSwap("front");
  check("...while the front already on the wire stays a bookkeeping update",
    ok.state().autoOrientation === "front" && !ok.calls.some((c) => c.op === "applyActive"));
  const unknown = harness({ startOrientation: null, wire: { onWire: null } });
  await unknown.maybeSwap("front");
  check("...and an UNKNOWN wire (go-live's first apply still in flight) is not a reason to stack a second set()",
    !unknown.calls.some((c) => c.op === "applyActive"),
    "two concurrent set() calls at go-live is the hang the wire mutex exists for");
}

console.log("\n── §5 NO OUTPUT FRAME IS EVER USED AS AN INPUT REFERENCE ──");
{
  /* Asserted as an ABSENCE, which is the only form that catches a well-meant future edit.
     #aiVideo is Decart's OUTPUT; feeding it back as conditioning would compound the model's
     own prior frame over frame. It is read only for display and capture. */
  /* Comments stripped first: this file's header legitimately DESCRIBES the set() signature
     and #aiVideo within a few lines of each other, and a check that trips over the
     documentation would force whoever reads it to delete the explanation. */
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const dispatches = codeOnly.split("rtClient.set(").slice(1).map((s) => s.slice(0, 200)).join("\n");
  check("no set() payload is built from the AI output element",
    !/aiVideo/i.test(dispatches), dispatches.slice(0, 200));
  check("the frozen turn overlay is display-only - it never becomes a reference",
    !/image:\s*_orientFadeCanvas/.test(SRC) && !/orientFadeEl\(\)[\s\S]{0,80}image:/.test(SRC));
}

console.log("\n── §6 A FAILED DISPATCH MUST NOT LEAVE THE LOCK LYING ──");
/* THE REPORT: "I turn 180 degrees and the big back graphic is gone - just plain brown."
   The garment renders, the colour is right, and the rear print is simply absent.

   THE LOCK AND THE WIRE CAN DISAGREE, and that is the whole bug. maybeSwap() sets
   `autoOrientation = next` BEFORE it dispatches, then awaits applyActive(). If that throws
   - an ack timeout, a wire error, a dropped set() - the catch logs, releases the hold, and
   leaves autoOrientation pointing at a side whose reference never reached Decart.

   WHAT THAT PRODUCES IS EXACTLY A PRINT-LESS BACK. effectiveAngle() now resolves "back", so
   every subsequent prompt - the periodic re-anchor and every topology re-drape - is built
   from BACK_CATEGORY_ANCHOR, which says "Precisely lock the rear print, logos, and back
   seams". That instruction is sent against the FRONT photo still on the wire, which has no
   rear print in it. app.js already records what the model does when told to reproduce a
   back it cannot see: it suppresses the graphic rather than inventing one. Brown fabric,
   no print.

   AND THE SESSION NEVER RECOVERS. The sampler keeps voting "back", which now AGREES with
   the (wrong) lock, so needsSwitch is false and maybeSwap is never called again. One failed
   dispatch strands the orientation for the rest of the session.

   THE FIX: the lock is a claim about what is on the wire, so it may only be advanced by a
   dispatch that actually succeeded. On failure it goes back to what it was, the vote
   disagrees again, and the next tick past the cooldown retries. */
{
  const h = harness({ startOrientation: "front", applyThrows: true });
  await h.maybeSwap("back");
  check("a back swap whose dispatch throws rolls the lock back to FRONT",
    h.state().autoOrientation === "front",
    "a lock claiming BACK over a front reference is what suppresses the rear print");
  check("...and the apply was genuinely attempted, so this is a rollback not a skip",
    h.calls.some((c) => c.op === "applyActive"));
  check("...and the frozen overlay is released rather than left up",
    h.calls.some((c) => c.op === "holdEnd"));
  check("...and `applying` is cleared so the retry is not blocked",
    h.state().applying === false);
}
{
  const h = harness({ startOrientation: "back", applyThrows: true });
  await h.maybeSwap("front");
  check("the return leg rolls back the same way - the rule is about the wire, not a side",
    h.state().autoOrientation === "back");
}
{
  /* The rollback must not make a later good swap impossible: after a failure the vote
     disagrees with the restored lock again, which is exactly what lets the next tick retry. */
  const h = harness({ startOrientation: "front" });
  await h.maybeSwap("back");
  check("a dispatch that succeeds still advances the lock",
    h.state().autoOrientation === "back" && h.calls.some((c) => c.op === "applyActive"));
}

console.log("\n── §7 THE BACK LEG READS A SETTLED VERDICT, NOT A FRESH DECODE ──");
/* "There is a visible gap while it swaps sides." The bytes were already in RAM, but every
   turn to the back still ran createImageBitmap() over the full packshot plus a canvas
   readback before the set() could even be issued - work preloadGarmentAssets() had already
   done on the SAME Blob before connect. The flatness verdict is a property of the bytes, so
   it is settled once per Blob and every later flip reads it. */
{
  const h0 = SRC.indexOf("const _flatVerdicts = new WeakMap();");
  const h1 = SRC.indexOf("\nasync function blobLooksFlat(", h0);
  const h2 = SRC.indexOf("\n}\n", h1);
  if (h0 === -1 || h1 === -1 || h2 === -1) {
    check("blobLooksFlat() and its verdict memo exist in app.js", false, "not implemented");
  } else {
    let decodes = 0, failNextDecode = false, flatAnswer = false;
    const probeSrc = SRC.slice(h0, h2 + 2);
    const realProbe = new Function("createImageBitmap", "bitmapLooksFlat",
      probeSrc + "\nreturn blobLooksFlat;")(
      async () => { decodes++; if (failNextDecode) { failNextDecode = false; throw new Error("decode hiccup"); } return { close() {} }; },
      async () => flatAnswer);

    const back = { size: 1, type: "image/jpeg" };
    await realProbe(back);                                     // what preloadGarmentAssets() does
    const afterPreload = decodes;
    const first = harness({ startOrientation: "front", backBlob: back, blobLooksFlat: realProbe });
    await first.maybeSwap("back");
    const second = harness({ startOrientation: "front", backBlob: back, blobLooksFlat: realProbe });
    await second.maybeSwap("back");
    check("a back flip after preload issues the swap without decoding the packshot again",
      afterPreload === 1 && decodes === 1 &&
      first.state().autoOrientation === "back" && second.state().autoOrientation === "back",
      `decodes=${decodes}`);

    const other = { size: 2, type: "image/jpeg" };
    await realProbe(other);
    check("...a different Blob (a refetch, another item) gets its own probe", decodes === 2);

    const hiccup = { size: 3, type: "image/jpeg" };
    failNextDecode = true;
    const failedOpen = await realProbe(hiccup);
    await realProbe(hiccup);
    check("a decode failure fails OPEN and is not memoized - the next flip probes again",
      failedOpen === false && decodes === 4, `decodes=${decodes}`);

    flatAnswer = true;
    const placeholder = { size: 4, type: "image/jpeg" };
    const flatHarness = harness({ startOrientation: "front", backBlob: placeholder, blobLooksFlat: realProbe });
    await flatHarness.maybeSwap("back");
    check("a flat placeholder is still rejected through the memoized probe",
      flatHarness.state().autoOrientation === "front" &&
      !flatHarness.calls.some((c) => c.op === "applyActive"));
  }
  const preload = SRC.slice(SRC.indexOf("async function preloadGarmentAssets"),
    SRC.indexOf("/* ── Context-Aware Asset Switching - OrientationWatcher"));
  check("preload settles the verdict through the SAME probe the flip reads",
    /await blobLooksFlat\(backBlob\)/.test(preload) && /await blobLooksFlat\(backBlob\)/.test(swapSrc));
  check("...and neither site decodes the back itself any more",
    !/createImageBitmap\(backBlob\)/.test(preload) && !/createImageBitmap\(backBlob\)/.test(swapSrc));
}

console.log("\n── §8 A PREDICTIVE BACK IS WITHDRAWN AT ONCE, AND NOTHING ELSE SKIPS THE COOLDOWN ──");
/* A predictive BACK goes on the wire before any back vote (see ORIENT_PREDICTIVE_BACK). When the
   face comes back the shopper never finished the turn, and the back reference is on their front:
   ORIENT_COOLDOWN_MS must not keep it there. Every OTHER swap still honours the cooldown - it is
   the anti-flap defence, and a bypass that leaked beyond this one case would re-open flapping. */
{
  const pred = harness({ startOrientation: "front" });
  await pred.maybeSwap("back", true);
  check("a predictive BACK commits and is remembered as predictive",
    pred.state().autoOrientation === "back" && pred.state().lastSwapPredictive === true &&
    pred.calls.some((c) => c.op === "applyActive"));

  const withdraw = harness({ startOrientation: "back", lastSwapAgoMs: 300, lastSwapWasPredictive: true });
  await withdraw.maybeSwap("front");
  check("300ms after a PREDICTIVE back, a face return dispatches FRONT inside the cooldown",
    withdraw.state().autoOrientation === "front" && withdraw.calls.some((c) => c.op === "applyActive"),
    JSON.stringify(withdraw.calls.map((c) => c.op)));
  check("...and the swap that replaced it is an ordinary one again",
    withdraw.state().lastSwapPredictive === false);

  const confirmedBack = harness({ startOrientation: "back", lastSwapAgoMs: 300, lastSwapWasPredictive: false });
  await confirmedBack.maybeSwap("front");
  check("300ms after a VOTE-CONFIRMED back, the cooldown still holds the front",
    confirmedBack.state().autoOrientation === "back" && !confirmedBack.calls.some((c) => c.op === "applyActive"));

  const reBack = harness({ startOrientation: "front", lastSwapAgoMs: 300, lastSwapWasPredictive: true });
  await reBack.maybeSwap("back", true);
  check("...and the bypass never applies toward BACK - a second prediction waits like any swap",
    reBack.state().autoOrientation === "front" && !reBack.calls.some((c) => c.op === "applyActive"));
}

console.log("\n── §9 A SWAP HOLDS DECART'S INPUT UNTIL ITS OWN SET() RESOLVES ──");
/* The blank/untextured shirt during a turn is Decart rendering camera frames from its prior while
   the reference is being replaced (first-frame-integrity.test.mjs §7). maybeSwap() owns that
   window, so it takes the hold before the dispatch and gives it back when the dispatch settles -
   on success AND on failure, or a failed swap would freeze the feed until the ceiling. */
{
  const ok = harness({ startOrientation: "front", gate: true });
  await ok.maybeSwap("back", true);
  const ops = ok.calls.map((c) => c.op);
  check("the hold is taken BEFORE the set() and given back AFTER it",
    ops.indexOf("hold") !== -1 && ops.indexOf("hold") < ops.indexOf("applyActive") &&
    ops.indexOf("applyActive") < ops.indexOf("unhold"), ops.join(" > "));
  check("...bounded by ORIENT_SWAP_INPUT_HOLD_MAX_MS",
    ok.calls.find((c) => c.op === "hold").maxMs === 2000);

  const failed = harness({ startOrientation: "front", gate: true, applyThrows: true });
  await failed.maybeSwap("back");
  check("a swap whose set() FAILS still gives the hold back - the old reference is on the wire, let frames flow",
    failed.calls.some((c) => c.op === "unhold"), failed.calls.map((c) => c.op).join(" > "));

  const flat = harness({ startOrientation: "front", gate: true, flat: true });
  await flat.maybeSwap("back");
  check("a swap abandoned before dispatch never takes the hold at all",
    !flat.calls.some((c) => c.op === "hold"));
}

console.log(fails === 0 ? "\nfront-reference-guard: OK" : `\nfront-reference-guard: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
