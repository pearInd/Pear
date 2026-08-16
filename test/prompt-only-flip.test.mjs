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
    /* The wire guard applyGarment() now wraps its prompt in. Identity here, not a stub
       that shortens: this suite asserts WHICH payload shape goes out (prompt-only vs
       prompt+image), so the guard must be transparent to it. Its own truncation
       behaviour is covered in composite.test.mjs. */
    clampPromptForWire: (p) => p,
    /* The wire mutex, as a TRANSPARENT pass-through - not a no-op stub. This suite is
       about WHICH payload shape reaches the wire (prompt-only vs prompt+image), so the
       send must actually happen; the mutex's own serialise/skip behaviour is covered by
       composite.test.mjs and apply-timeout.test.mjs. */
    sendCondition: (_label, send) => send(),
    rtClient: {
      set: async (p) => { sent.push({ kind: "set", hasImage: p.image !== undefined, image: p.image, prompt: p.prompt }); },
      setPrompt: async (prompt, opts) => { sent.push({ kind: "setPrompt", prompt, opts }); },
    },
    currentAngle: "auto",
    AUTO_ANGLE: "auto",
    effectiveAngle: () => sandbox._angle,
    /* The edge-on pose axis. applyGarment() snapshots it beside the angle and threads it
       into the prompt builders; driven from sandbox._profile so the cases below can prove
       a pose change is prompt-only too - the reference image must not move for it. */
    profileActive: () => sandbox._profile,
    activeImageOf: () => "https://cdn.test/front.jpg",
    referenceImageFor: async (_i, _a, out) => { out.composite = composite; return sandbox._ref; },
    compositeActiveFor: () => composite,
    galleryOf: () => sandbox._gallery,
    /* Reached only by applyGarment()'s last-ditch recovery sweep - the real one proxies an
       http(s) URL and passes a data:/blob: one through, so identity is a faithful stub for
       "this URL is usable as a reference". */
    garmentImageRef: (u) => u || undefined,
    distinctBackOf: () => "https://cdn.test/back.jpg",
    sameImage: (a, b) => a === b,
    activeBackIsReal: () => true,
    abbrevImg: (u) => String(u).slice(0, 24),
    vtonState: () => "BACK_MODE",
    hasDedicatedAngle: () => true,
    describeCompositeLayout: () => "layout",
    // Both builders echo the profile flag so the assertions can read what was actually sent.
    buildCompositePrompt: (_it, angle, inProfile) => `COMPOSITE_PROMPT_${angle}${inProfile ? "_PROFILE" : ""}`,
    buildPrompt: () => "PLAIN_PROMPT",
    angleClause: (_it, _a, _c, inProfile) => `_CLAUSE${inProfile ? "_PROFILE" : ""}`,
    _angle: "front",
    _profile: false,
    _ref: null,
    _gallery: { front: "https://cdn.test/front.jpg", back: "https://cdn.test/back.jpg" },
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

console.log("\n── a POSE change (square-on → edge-on) is prompt-only: the reference must not move ──");
{
  /* The 90-degree side-profile fix rides this exact path, and it is the reason it costs no
     rendering latency. Turning sideways changes only what the prompt asserts about the
     body - the garment reference is byte-identical - so it must go out as a setPrompt()
     control message, never a re-upload. If this ever regresses to a full set(), the
     depth-fidelity fix starts pushing a few hundred KB of base64 through the datachannel
     at the precise moment the shopper is mid-rotation, which is the window the flicker
     fix above exists to keep quiet: the pose fix would then reintroduce the print-vanishing
     bug it was never meant to touch. */
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = COMPOSITE;

  sandbox._angle = "front"; sandbox._profile = false;
  await api.applyGarment(item);                        // go-live, square-on
  check("go-live sends the image once", sent[0].kind === "set" && sent[0].hasImage === true);
  check("...and the square-on prompt carries no profile marker",
    sent[0].prompt === "COMPOSITE_PROMPT_front", sent[0].prompt);

  sandbox._profile = true;                             // the shopper turns 90 degrees
  await api.applyGarment(item);
  check("THE POSE CHANGE IS PROMPT-ONLY - no image re-upload mid-turn",
    sent[1].kind === "setPrompt", JSON.stringify(sent[1] && sent[1].kind));
  check("...and the new prompt actually carries the edge-on pose",
    sent[1].prompt === "COMPOSITE_PROMPT_front_PROFILE", sent[1].prompt);

  sandbox._profile = false;                            // ...and turns back square-on
  await api.applyGarment(item);
  check("leaving profile is prompt-only too", sent[2].kind === "setPrompt");
  check("...and drops the profile marker again",
    sent[2].prompt === "COMPOSITE_PROMPT_front", sent[2].prompt);

  check("exactly ONE image upload across a full turn out and back",
    sent.filter((s) => s.kind === "set").length === 1, JSON.stringify(sent.map((s) => s.kind)));
}

console.log("\n── the pose snapshot is independent of the angle snapshot ──");
{
  /* Both axes must be able to move without the other. A profile update while the lock sits
     on BACK has to keep selecting the back panel - see side-profile.test.mjs §4 for the
     clause-level proof; this is the payload-level one. */
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = COMPOSITE;
  sandbox._angle = "back"; sandbox._profile = false;
  await api.applyGarment(item);
  sandbox._profile = true;
  await api.applyGarment(item);
  check("edge-on while the lock is BACK still builds the BACK prompt",
    sent[1].prompt === "COMPOSITE_PROMPT_back_PROFILE", sent[1].prompt);
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
  /* THE ITEM STILL HAS ASSETS - referenceImageFor() just came back empty. Since the
     image-first refactor the prompt no longer describes the garment at all (it says "the
     exact provided image asset" and stops), so shipping this dispatch with no image would
     leave Decart conditioning on nothing but its own prior - the tuxedo. applyGarment()
     now sweeps the item's gallery rather than accepting the empty payload. */
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = null;
  sandbox._angle = "front";
  await api.applyGarment(item);
  check("a failed resolve recovers from the item's own gallery instead of shipping empty",
    sent[0].kind === "set" && sent[0].hasImage === true &&
    sent[0].image === "https://cdn.test/front.jpg", JSON.stringify(sent[0]));
  check("...and the recovered reference is recorded on the wire like any other",
    api.state().rtImageOnWire === true);
}
{
  /* NOTHING TO RECOVER: an item with no gallery, no img and no composite - a malformed
     catalog entry or a half-built handover. The original invariant still has to hold on
     this path, and it is the one that matters most here: a payload with no image must
     never take the setPrompt() fast path, because that path exists ONLY to avoid
     re-uploading a reference that is already on the wire, and here there is none. Taking
     it would leave a session permanently undressed with no set() ever attempting a fix. */
  const { api, sent, sandbox } = makeHarness();
  sandbox._ref = null;
  sandbox._gallery = {};
  sandbox._angle = "front";
  const bare = { ...item, img: undefined, composite: undefined };
  await api.applyGarment(bare);
  await api.applyGarment(bare);
  check("null references never collapse into setPrompt()",
    sent.every((s) => s.kind === "set"), JSON.stringify(sent.map((s) => s.kind)));
  check("...and no image is invented onto the payload either",
    sent.every((s) => s.hasImage === false), JSON.stringify(sent.map((s) => s.hasImage)));
  check("and nothing is recorded as being on the wire", api.state().rtImageOnWire === false);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
