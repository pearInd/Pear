/* THE FLICKER regression test: an orientation flip must NOT re-upload the reference.

   ROOT CAUSE of "the back print flickers or disappears when I turn around". In composite
   mode the reference is byte-identical across a turn - one stitched FRONT|BACK image
   serves both sides, and only the clause naming the half changes. app.js claimed since
   the composite landed that "an orientation flip is a PROMPT-ONLY set()". It was not.
   rtClient.set({ image }) runs the Blob through imageToBase64() and ships the bytes every
   single time (verified against @decartai/sdk@0.1.5 realtime/methods.js), so every turn
   pushed a few hundred KB of base64 through the datachannel and swapped the model's
   reference out from under itself - mid-rotation, inside a 5s billed window. That is the
   window in which the print vanishes.

   FIX: applyGarment() tracks the exact object last handed to set({ image }). When the
   next application resolves to that SAME object and the session already has it, the
   update goes through setPrompt() - session.sendPrompt(), which never touches the image.

   This runs the REAL applyGarment() extracted from app.js against a recording rtClient. */
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

const applyGarmentSrc = extract("async function applyGarment(item) {", "\n/**\n * Reads the Screen 1 physical inputs");
check("extracted applyGarment", /rtClient\.setPrompt\(/.test(applyGarmentSrc) && /rtClient\.set\(payload\)/.test(applyGarmentSrc),
  "applyGarment no longer contains both a setPrompt and a set path - has it been restructured?");

/* The session-state variables are module-level `let`s that applyGarment MUTATES, so they
   are declared inside the evaluated code rather than passed in as (immutable) parameters,
   and read back through an accessor. */
function makeHarness({ composite = true } = {}) {
  const sent = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} },
    Blob,
    rtClient: {
      set: async (p) => { sent.push({ kind: "set", hasImage: p.image !== undefined, image: p.image, prompt: p.prompt }); },
      setPrompt: async (prompt, opts) => { sent.push({ kind: "setPrompt", prompt, opts }); },
    },
    currentAngle: "auto",
    AUTO_ANGLE: "auto",
    effectiveAngle: () => sandbox._angle,
    activeImageOf: () => "https://cdn.test/front.jpg",
    referenceImageFor: async (_i, _a, out) => { out.composite = composite; return sandbox._ref; },
    compositeActiveFor: () => composite,
    galleryOf: () => ({ front: "https://cdn.test/front.jpg", back: "https://cdn.test/back.jpg" }),
    distinctBackOf: () => "https://cdn.test/back.jpg",
    sameImage: (a, b) => a === b,
    activeBackIsReal: () => true,
    abbrevImg: (u) => String(u).slice(0, 24),
    vtonState: () => "BACK_MODE",
    hasDedicatedAngle: () => true,
    describeCompositeLayout: () => "layout",
    buildCompositePrompt: (_it, angle) => `COMPOSITE_PROMPT_${angle}`,
    buildPrompt: () => "PLAIN_PROMPT",
    angleClause: () => "_CLAUSE",
    _angle: "front",
    _ref: null,
  };
  const body =
    "let lastSentImageRef = null; let rtImageOnWire = false;\n" +
    applyGarmentSrc +
    "\nreturn { applyGarment, state: () => ({ lastSentImageRef, rtImageOnWire })," +
    " endSession: () => { lastSentImageRef = null; rtImageOnWire = false; } };";
  const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox));
  return { api, sent, sandbox };
}

const COMPOSITE = new Blob(["stitched-front-back"], { type: "image/jpeg" });
const item = { name: "Strata Tee", id: "strata", garmentType: "upper_body", subType: "tshirt", color: "#000" };

console.log("\n── go-live, then a turn: the image is uploaded ONCE ──");
{
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = COMPOSITE;

  sandbox._angle = "front";
  await api.applyGarment(item);          // go-live
  check("first application uses set() and carries the image",
    sent[0].kind === "set" && sent[0].hasImage === true, JSON.stringify(sent[0] && sent[0].kind));
  check("the reference is recorded as on the wire",
    api.state().rtImageOnWire === true && api.state().lastSentImageRef === COMPOSITE);

  sandbox._angle = "back";
  await api.applyGarment(item);          // the shopper turns around
  check("THE FIX: the turn is a setPrompt(), not a set() - no image re-upload",
    sent[1].kind === "setPrompt", JSON.stringify(sent[1] && sent[1].kind));
  check("...and it carries the BACK prompt", sent[1].prompt === "COMPOSITE_PROMPT_back", sent[1].prompt);
  /* setPromptInputSchema defaults enhance to TRUE, unlike set(). Letting it default would
     silently turn prompt enhancement on for every turn - a different generation config on
     the back than on the front, which is its own source of visible inconsistency. */
  check("enhance:false is passed EXPLICITLY (setPrompt defaults it to true)",
    sent[1].opts && sent[1].opts.enhance === false, JSON.stringify(sent[1].opts));

  sandbox._angle = "front";
  await api.applyGarment(item);          // and back again
  check("turning back is also prompt-only", sent[2].kind === "setPrompt", sent[2].kind);
  check("exactly ONE image upload across two full turns",
    sent.filter((s) => s.kind === "set").length === 1, JSON.stringify(sent.map((s) => s.kind)));
}

console.log("\n── a genuinely different reference still re-uploads ──");
{
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = COMPOSITE;
  sandbox._angle = "front";
  await api.applyGarment(item);

  // e.g. the shopper switched colour/garment, or the composite was rebuilt after a failure
  sandbox._ref = new Blob(["a-different-stitch"], { type: "image/jpeg" });
  await api.applyGarment(item);
  check("a new Blob forces a full set() with the image",
    sent[1].kind === "set" && sent[1].hasImage === true, JSON.stringify(sent.map((s) => s.kind)));
  check("the tracker follows the new reference", api.state().lastSentImageRef === sandbox._ref);
}

console.log("\n── a NEW session must never inherit 'already on the wire' ──");
{
  /* The composite Blob is memoized across sessions, so without an explicit reset the first
     applyGarment() of a reconnect would match lastSentImageRef and take the prompt-only
     path - leaving Decart generating against no garment reference at all. connectRealtime()
     and both teardown paths clear it; this proves applyGarment() honours the cleared state. */
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = COMPOSITE;
  sandbox._angle = "front";
  await api.applyGarment(item);
  api.endSession();                       // what connectRealtime()/teardown()/stopBilling() do
  await api.applyGarment(item);
  check("after a session reset the image is sent again, in full",
    sent[1].kind === "set" && sent[1].hasImage === true, JSON.stringify(sent.map((s) => s.kind)));
}

console.log("\n── single-asset mode: each flip changes the picture, so it must NOT be skipped ──");
{
  /* Composite off (?composite=0, or the stitch failed): the reference is a DIFFERENT
     per-orientation photo on each side. Taking the prompt-only path there would steer
     "render the back" at the front photo - the exact bug the composite binding fixed. */
  const { api, sent, sandbox } = makeHarness({ composite: false });
  const frontBlob = new Blob(["front"], { type: "image/jpeg" });
  const backBlob  = new Blob(["back"],  { type: "image/jpeg" });

  sandbox._ref = frontBlob; sandbox._angle = "front";
  await api.applyGarment(item);
  sandbox._ref = backBlob;  sandbox._angle = "back";
  await api.applyGarment(item);
  check("both applications send their own image",
    sent.every((s) => s.kind === "set" && s.hasImage), JSON.stringify(sent.map((s) => s.kind)));
}

console.log("\n── a prompt-only path must never be taken with no image on the wire ──");
{
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = null;                    // prompt-only payload (no reference resolved at all)
  sandbox._angle = "front";
  await api.applyGarment(item);
  await api.applyGarment(item);
  check("null references never collapse into setPrompt()",
    sent.every((s) => s.kind === "set"), JSON.stringify(sent.map((s) => s.kind)));
  check("and nothing is recorded as being on the wire", api.state().rtImageOnWire === false);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
