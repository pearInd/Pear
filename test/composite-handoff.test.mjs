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
  });
  check("composite IS applied even though front/back did not change",
    after.composite === "data:image/jpeg;base64,/9j/NEWCOMPOSITE", after.composite);
  check("renderActiveGarment WAS called (the chip actually updates)",
    calls.includes("renderActiveGarment"), JSON.stringify(calls));
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

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
