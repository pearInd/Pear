/* THE "MIXING" BUG regression test.

   Root cause: applyGarment() resolved the reference image via an AWAITED call
   (referenceImageFor), then computed the prompt clause via a SEPARATE, later call to
   angleClause() that internally re-read the live effectiveAngle(). The
   OrientationWatcher samples the camera on its own independent 250ms interval and can
   confirm a flip (mutating the live autoOrientation lock) at any moment - including
   during that await. If it did, angleClause() picked up the NEW angle while the
   already-resolved imageRef still reflected the OLD one: a FRONT reference paired
   with "reproduce the BACK, do NOT render the front" steering - the model then
   faithfully reproduces the only content it can see (the front chest print) as the
   back. Exactly the failure class this file has fixed once already for a URL-
   matching reason; this is the SAME failure, caused by a bare time-of-check-to-
   time-of-use race instead.

   Fix: angleClause(item, angleOverride) accepts a frozen angle snapshot, and
   applyGarment() takes that snapshot BEFORE its own await and threads it through -
   this test proves the override actually wins over a live, changed effectiveAngle(),
   using the REAL angleClause()/compositeActiveFor() extracted from app.js. */
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

// One contiguous slice: ANGLE_CLAUSE / COMPOSITE_CLAUSE / CUSTOM_BACK_INFERRED /
// activeBackIsReal / compositeActiveFor / angleClause all sit back-to-back in app.js,
// so a single extract avoids assembling mismatched fragments.
const code = extract("const ANGLE_CLAUSE", "/**\n * Resolve the reference image handed to rtClient.set");

check("extracted angleClause with the angleOverride parameter", /function angleClause\(item, angleOverride\)/.test(code));
check("extracted compositeActiveFor", /function compositeActiveFor/.test(code));

function run({ effectiveAngleReturns, distinctBack, resolveLookReturns = null, custom = false, angleOverride }) {
  const sandbox = {
    COMPOSITE_MODE: true,
    currentAngle: "auto",
    AUTO_ANGLE: "auto",
    effectiveAngle: () => effectiveAngleReturns,
    resolveLook: () => resolveLookReturns,
    distinctBackOf: () => distinctBack,
    galleryOf: () => ({ front: "https://cdn.test/front.jpg", back: distinctBack }),
  };
  const fn = new Function(...Object.keys(sandbox), code + "\nreturn { angleClause, compositeActiveFor };");
  const api = fn(...Object.values(sandbox));
  const item = { name: "Tee", custom, img: "https://cdn.test/front.jpg" };
  return api.angleClause(item, angleOverride);
}

console.log("── THE RACE: a live effectiveAngle() that changed AFTER the snapshot must NOT win ──");
{
  // Simulates: applyGarment() snapshotted "front" (angleAtStart), then the watcher
  // flipped autoOrientation to "back" DURING the await - effectiveAngle() now
  // returns "back" if re-read live, but the frozen snapshot must still govern.
  const clause = run({
    effectiveAngleReturns: "back",       // what a LIVE re-read would now return (the race)
    angleOverride: "front",              // what was actually snapshotted before the await
    distinctBack: "https://cdn.test/back.jpg",
  });
  check("the FRONT snapshot wins - clause names the FRONT panel, not the back",
    clause.includes("LEFT panel marked 'FRONT'") && !clause.includes("RIGHT panel marked 'BACK'"),
    clause.slice(0, 120));
}
{
  // The mirror case: snapshotted "back", live re-read would (incorrectly) say "front".
  const clause = run({
    effectiveAngleReturns: "front",
    angleOverride: "back",
    distinctBack: "https://cdn.test/back.jpg",
  });
  check("the BACK snapshot wins - clause names the BACK panel, not the front",
    clause.includes("RIGHT panel marked 'BACK'") && !clause.includes("LEFT panel marked 'FRONT'"),
    clause.slice(0, 120));
}

console.log("\n── no override supplied: falls back to a live read (applyLook(), unaffected) ──");
{
  const clause = run({ effectiveAngleReturns: "back", distinctBack: "https://cdn.test/back.jpg", angleOverride: undefined });
  check("omitting the override still reads effectiveAngle() live - existing callers unaffected",
    clause.includes("RIGHT panel marked 'BACK'"), clause.slice(0, 120));
}

console.log("\n── the override applies in NON-composite mode too (per-orientation single asset) ──");
{
  const clause = run({
    effectiveAngleReturns: "back",   // live value - must be ignored
    angleOverride: "front",          // frozen snapshot - must win
    distinctBack: undefined,         // no real back -> compositeActiveFor() is false, exercises the OTHER branch
  });
  check("non-composite branch also honours the frozen snapshot",
    !clause.toLowerCase().includes("behind") && !clause.toLowerCase().includes("rear view"),
    clause.slice(0, 160));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
