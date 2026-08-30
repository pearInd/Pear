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

const start = SRC.indexOf("  async function maybeSwap(next) {");
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
                   startOrientation = "back", flat = false, applyThrows = false } = {}) {
  const calls = [];
  const sandbox = {
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
    orientHoldExtend: () => calls.push({ op: "holdExtend" }),
    orientHoldEnd: (r) => calls.push({ op: "holdEnd", r }),
    applyActive: async () => {
      calls.push({ op: "applyActive" });
      if (applyThrows) throw new Error("set() failed: ack timeout");
    },
    bodyTopology: { reset: () => calls.push({ op: "topologyReset" }) },
    abbrevImg: (s) => String(s),
    toast: (t) => calls.push({ op: "toast", t }),
    setTimeout: (fn) => { fn(); return 0; },
  };
  const body =
    `let applying = false, lastSwapAt = 0, disposed = false, autoOrientation = ${JSON.stringify(startOrientation)};\n` +
    swapSrc +
    `\nreturn { maybeSwap, state: () => ({ applying, autoOrientation }) };`;
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

console.log("\n── §7 A SWAP RE-CONDITIONS THE RENDER, so the topology baseline is stale ──");
/* THE REPORT: after the panel split fixed the front/back binding, the small chest logo
   still erodes on the RETURN leg of a 360 - the front comes back as a plain garment while
   the large back graphic survives every turn.

   THE MECHANISM IS REPEATED RE-DERIVATION, not a wrong reference. Every full set({ image })
   makes the model re-derive the garment from the reference, and fine, low-contrast marks
   degrade a little each time; a large high-contrast graphic does not. So the question is
   not "is the front asset bound" (it is - §1 and §2) but "how many times is this session
   re-conditioned for no reason".

   ONE OF THOSE IS AVOIDABLE AND THIS IS IT. makeBodyTopologyTracker() holds a BASELINE -
   "the topology the CURRENT render was conditioned against" - and dispatches a full
   re-upload when the live body has moved away from it. maybeSwap() performs exactly such a
   re-conditioning, and left the baseline describing the body from BEFORE the turn. The next
   comparison therefore measures the new frame against a shape the render has already moved
   off, which on a 360 is a large delta that has nothing to do with movement since the
   render was made - so it trips the threshold and fires a redundant re-upload immediately
   after the swap. Another re-derivation, another pass of erosion.

   THE PRECEDENT IS THREE LINES AWAY. reconditionForPresence() already calls
   bodyTopology.reset() for this exact reason, and says so: "That dispatch re-conditioned
   the render, so whatever shape the tracker was holding is no longer the shape on screen.
   Re-acquire rather than compare the next frame against a baseline the render has already
   moved off." The orientation swap is the same kind of dispatch and was the one that did
   not do it.

   NO PROMPT CHANGE, deliberately. A clause naming the chest logo was tried and withdrawn -
   it rendered a large print the reference never had (see front-print-lock.test.mjs). The
   erosion is fought by re-conditioning LESS, not by describing the logo more. */
{
  const h = harness({ startOrientation: "back" });
  await h.maybeSwap("front");
  check("a completed swap re-acquires the topology baseline",
    h.calls.some((c) => c.op === "topologyReset"),
    "a stale baseline fires a redundant re-upload right after the swap - one more erosion pass");
  check("...AFTER the apply, not before it",
    h.calls.findIndex((c) => c.op === "topologyReset") >
      h.calls.findIndex((c) => c.op === "applyActive"),
    "resetting before the dispatch re-acquires against the shape being replaced");
}
{
  const h = harness({ startOrientation: "front" });
  await h.maybeSwap("back");
  check("the outbound leg does it too - the erosion is per re-conditioning, not per side",
    h.calls.some((c) => c.op === "topologyReset"));
}
{
  /* A dispatch that FAILED conditioned nothing, so the baseline still describes what is
     genuinely on screen. Resetting there would discard a valid baseline and re-acquire
     against an unchanged render - a wasted cycle, and a lie about what was applied. */
  const h = harness({ startOrientation: "front", applyThrows: true });
  await h.maybeSwap("back");
  check("a FAILED swap does NOT reset - nothing was re-conditioned",
    !h.calls.some((c) => c.op === "topologyReset"),
    "the baseline is a claim about the render; a failed dispatch did not change the render");
}

console.log(fails === 0 ? "\nfront-reference-guard: OK" : `\nfront-reference-guard: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
