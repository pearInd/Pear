/* Regression test for the "Now fitting chip still shows the front photo" bug.

   ROOT CAUSE: the PEAR_UPDATE_GARMENT message listener in fitting-room/app.js used to
   bail out whenever front/back URLs matched what activeItem already held, WITHOUT
   checking whether a NEW composite had arrived in the same message. The widget builds
   the composite AFTER /api/classify-images resolves - strictly later than the initial
   DOM-order guess the room opens on - so on any store where DOM back-detection already
   agrees with the classifier (common - see findGalleryBack in pear-widget.js),
   img/imgBack never change between the initial open and this message. That message was
   nonetheless the ONLY delivery of garment_composite, and the old guard discarded it,
   unread, before ever looking at it.

   This isolates just the listener's decision logic (extracted from app.js, not
   reimplemented) against a minimal stand-in for activeItem + the functions it calls, and
   asserts: front/back unchanged + a genuinely new composite arriving must NOT be treated
   as a no-op. */
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
  if (end === -1) throw new Error(`could not find end marker "${endMarker}"`);
  return SRC.slice(start, end);
}

// Pull the actual listener body (the callback passed to addEventListener), not a
// reimplementation - so a regression in app.js itself fails this test.
const listenerSrc = extract(
  'window.addEventListener("message", (e) => {\n  if (e.source !== window.parent) return;\n  if (!e.data || e.data.type !== "PEAR_UPDATE_GARMENT") return;',
  "\n});"
);
check("extracted the PEAR_UPDATE_GARMENT listener body", listenerSrc.includes("garment_composite"),
  "marker text not found - has the listener been restructured?");

/* The listener also records the widget's panel geometry and logs it through the REAL
   describeCompositeLayout(), so pull that in rather than stubbing it - it is the check
   that catches a stitcher whose panel order stopped matching the LEFT=FRONT / RIGHT=BACK
   contract the Decart prompt asserts, and a stub would assert nothing about it. */
const describeSrc = extract("function describeCompositeLayout(L) {", "\n}\n");
const describeCompositeLayout = new Function(describeSrc + "\n}\nreturn describeCompositeLayout;")();

// The listener mutates `activeItem` properties (not the binding itself), and reads the
// module-level `activeItem` directly - so run it with `activeItem` as a real closure
// variable via `with`-free substitution: build a tiny module wrapper.
function run(activeItemInit, messageData) {
  let activeItem = activeItemInit;
  const localCalls = [];
  const sandbox = {
    get activeItem() { return activeItem; },
    set activeItem(v) { activeItem = v; },
    window: { parent: "PARENT" },
    renderActiveGarment: () => localCalls.push("renderActiveGarment"),
    renderPerspectiveSelector: () => localCalls.push("renderPerspectiveSelector"),
    prewarmOrientationAssets: () => localCalls.push("prewarmOrientationAssets"),
    hotSwapIfLive: (msg) => localCalls.push("hotSwapIfLive:" + msg),
    // Real behaviour (build a local composite when only imgBack arrived) is covered
    // by test/eager-composite.test.mjs; this suite is specifically about the
    // early-return/change-detection logic, so a call-recording stub is enough here.
    ensureActiveGarmentComposite: (item) => localCalls.push("ensureActiveGarmentComposite:" + (item && item.name)),
    abbrevImg: (u) => (u ? String(u).slice(0, 20) : "(none)"),
    describeCompositeLayout,   // the real one, extracted above
    currentAngle: "auto",   // read only for the trailing console.log line
    console,
    Array,
  };
  const body = listenerSrc
    .replace(/^window\.addEventListener\("message", \(e\) => \{/, "")
    .replace(/\}\);?\s*$/, "");
  // NOT `return scope.activeItem` after the `with` block: the listener's own early
  // `return;` (the exact line this test exists to check) exits this wrapper function
  // immediately, so a trailing return statement would never run in that path. Read
  // the mutated state back off `sandbox` instead, which the listener body mutates via
  // `activeItem.img = ...` property writes regardless of how the function exits.
  const fn = new Function("scope", "e", `with (scope) { ${body} }`);
  fn(sandbox, { source: "PARENT", data: messageData });
  return { activeItem: sandbox.activeItem, calls: localCalls };
}

console.log("── THE BUG: composite arrives with front/back unchanged ──");
{
  const item = { img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg" };
  const { activeItem: after, calls } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",     // SAME as before
    garment_back: "https://cdn.test/back.jpg",      // SAME as before
    garment_composite: "data:image/jpeg;base64,/9j/NEWCOMPOSITE",
    garment_composite_layout: { w: 2048, h: 1200, front_x: 0, front_w: 992, back_x: 1056, back_w: 992, divider_x: 1024 },
  });
  check("composite IS applied even though front/back did not change",
    after.composite === "data:image/jpeg;base64,/9j/NEWCOMPOSITE", after.composite);
  check("renderActiveGarment WAS called (the chip actually updates)",
    calls.includes("renderActiveGarment"), JSON.stringify(calls));
  /* The widget's panel geometry rides along with the composite and is kept on the item,
     so applyGarment()'s payload log can state which half the prompt selected AND whether
     the pixels back that claim up. */
  check("widget panel layout captured on the item",
    after._compositeLayout && after._compositeLayout.front_x < after._compositeLayout.back_x,
    JSON.stringify(after._compositeLayout));
}

console.log("\n── the layout is optional: an older widget build sends none ──");
{
  const item = { img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg" };
  const { activeItem: after } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",
    garment_back: "https://cdn.test/back.jpg",
    garment_composite: "data:image/jpeg;base64,/9j/NOLAYOUT",
  });
  check("composite still applied with no layout attached", after.composite.endsWith("NOLAYOUT"));
  check("layout recorded as absent rather than undefined-by-accident", after._compositeLayout === null,
    JSON.stringify(after._compositeLayout));
  check("describeCompositeLayout says so instead of throwing",
    describeCompositeLayout(after._compositeLayout) === "layout: not reported",
    describeCompositeLayout(after._compositeLayout));
}

console.log("\n── a REVERSED stitch is called out, since the prompt asserts LEFT=FRONT ──");
{
  const reversed = { w: 2048, h: 1200, front_x: 1056, front_w: 992, back_x: 0, back_w: 992, divider_x: 1024 };
  check("panel-order drift surfaces as a warning in the description",
    /PANELS REVERSED/.test(describeCompositeLayout(reversed)), describeCompositeLayout(reversed));
}

console.log("\n── a genuine no-op (same front/back, no composite, nothing new) is still skipped ──");
{
  const item = { img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg" };
  const { activeItem: after, calls } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",
    garment_back: "https://cdn.test/back.jpg",
  });
  check("no spurious re-render when nothing actually changed",
    calls.length === 0, JSON.stringify(calls));
  check("activeItem left untouched", after === item);
}

console.log("\n── a composite that was ALREADY applied does not re-trigger ──");
{
  const item = {
    img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg",
    composite: "data:image/jpeg;base64,/9j/SAME",
  };
  const { calls } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",
    garment_back: "https://cdn.test/back.jpg",
    garment_composite: "data:image/jpeg;base64,/9j/SAME",
  });
  check("no re-render for an identical repeat message", calls.length === 0, JSON.stringify(calls));
}

console.log("\n── ordinary case: front/back DO change (pre-existing behaviour, not broken) ──");
{
  const item = { img: "https://cdn.test/guess-front.jpg", imgBack: undefined };
  const { activeItem: after, calls } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/real-front.jpg",
    garment_back: "https://cdn.test/real-back.jpg",
  });
  check("front/back updated", after.img === "https://cdn.test/real-front.jpg" &&
    after.imgBack === "https://cdn.test/real-back.jpg");
  check("still re-renders with no composite involved", calls.includes("renderActiveGarment"));
}

console.log("\n── the \"waiting for a back view\" flag is cleared the instant a message arrives ──");
{
  // Awaiting AND the message brings a real change - covered by the "THE BUG" case
  // above (renderActiveGarment fires regardless). This isolates the flag itself.
  const item = {
    img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg",
    _awaitingBackCorrection: true, _awaitingBackTimer: "FAKE_TIMER_ID",
  };
  const { activeItem: after } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",
    garment_back: "https://cdn.test/back.jpg",
    garment_composite: "data:image/jpeg;base64,/9j/NEW",
  });
  check("flag cleared once the round trip's answer arrives", after._awaitingBackCorrection === false);
  check("pending timer reference cleared (no dangling handle)", after._awaitingBackTimer === null);
}

console.log("\n── THE SPINNER FIX: an 'unchanged' message must still clear a visible spinner ──");
{
  // The widget's round trip finished and found NOTHING to correct (e.g. back_source:
  // "none" - a genuinely single-view product with synthesis declined/failed). Front/
  // back/composite are all identical to what's already showing, so the OLD unchanged
  // early-return would skip the render entirely - leaving the spinner spinning forever
  // even though the wait is actually over.
  const item = {
    img: "https://cdn.test/front.jpg", imgBack: undefined,
    _awaitingBackCorrection: true,
  };
  const { calls } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",
    garment_back: undefined,
  });
  check("a repaint IS issued purely to clear the spinner", calls.includes("renderActiveGarment"),
    JSON.stringify(calls));
}

console.log("\n── the ORIGINAL no-op case still issues zero repaints (not a regression) ──");
{
  // Same as above, but the flag was NOT set (a normal, already-settled item) - the
  // fix above must not turn every unchanged message into a repaint.
  const item = { img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg" };
  const { calls } = run(item, {
    type: "PEAR_UPDATE_GARMENT",
    garment_url: "https://cdn.test/front.jpg",
    garment_back: "https://cdn.test/back.jpg",
  });
  check("no repaint when nothing changed AND nothing was pending", calls.length === 0, JSON.stringify(calls));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
