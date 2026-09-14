/* The Liquid Glass asset-preparation gate - the overlay that replaced the premature
   thumbnail, and the widened go-live preload gate behind it.

   THE BUG THESE CLOSE
   ───────────────────
   A widget handover opens the room with ?garment_url=imgs[0] - the first image in DOM
   order, validated by nobody - and the real front/back verdict lands 2.5s warm / ~27s
   cold as a PEAR_UPDATE_GARMENT correction. The chip painted that unvalidated photo at
   full opacity for the whole window and then visibly mutated when the correction came,
   which reads as a glitch. Separately, the hard preload gate in goLive() was scoped to
   `currentAngle === AUTO_ANGLE`, so front-only runs - most of the catalog - reached
   connectRealtime() with their reference never fetched, decoded or validated at all.

   Extracts the REAL controller and the REAL goLive() gate, not reimplementations. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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

const code = extract("const PREP_PHASE_IDLE", "\n/**\n * Mandatory Pre-load & Validation Gate");
check("extracted the real asset-prep controller",
  /function assetPrepReady/.test(code) && /function syncAssetPrep/.test(code));

/* A fake chip + a MANUALLY PUMPED rAF, so the eased counter is stepped deterministically
   instead of raced against a real frame clock. */
function harness({ pending = null, compositeBuilding = false, now = 0 } = {}) {
  const els = {};
  const mk = (id) => (els[id] = {
    id, hidden: true, style: {}, _attrs: {}, _cls: new Set(),
    firstChild: { nodeValue: "" }, textContent: "",
    classList: {
      toggle: (c, on) => { on ? els[id]._cls.add(c) : els[id]._cls.delete(c); },
      has: (c) => els[id]._cls.has(c),
    },
    setAttribute(k, v) { this._attrs[k] = v; },
  });
  ["activeGarment", "agPrep", "agPrepPct", "agPrepFill", "agPrepPhase"].forEach(mk);

  const frames = [];
  const timers = [];
  const renderCalls = [];
  let clock = now;

  const sandbox = {
    $: (id) => els[id] || null,
    document: {},
    console: { log() {}, warn() {}, error() {} },
    activeItem: { _compositeBuilding: compositeBuilding },
    livePendingReason: () => pending,
    renderActiveGarment: () => renderCalls.push({ agPrepHidden: els.agPrep.hidden }),
    CLASSIFY_GATE_MAX_MS: 30000,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date: { now: () => clock },
  };
  const api = new Function(...Object.keys(sandbox), code +
    "\nreturn { assetPrepSet, assetPrepStep, assetPrepReady, syncAssetPrep," +
    " get phase(){return assetPrepPhase}, get target(){return assetPrepTarget}," +
    " get shown(){return assetPrepShown}, get visible(){return assetPrepVisible} };")
    (...Object.values(sandbox));

  return {
    api, els, renderCalls, timers,
    advance: (ms) => { clock += ms; },
    /* Drain the rAF queue up to `max` frames - each callback may enqueue the next. */
    pump: (max = 400) => { let n = 0; while (frames.length && n++ < max) frames.shift()(); },
    fireTimers: () => { while (timers.length) timers.shift().fn(); },
  };
}

console.log("── the counter never lies: 100 is reserved for a validated asset ──");
{
  const h = harness({ pending: "still classifying" });
  h.api.syncAssetPrep();
  check("an outstanding verdict puts the machine in CLASSIFYING_ASSETS",
    h.api.phase === "CLASSIFYING_ASSETS", h.api.phase);

  // 60s of an opaque round trip - twice the classify gate's own timeout.
  for (let i = 0; i < 60; i++) { h.advance(1000); h.pump(20); }
  check("...and the creep NEVER reaches 100 while work is outstanding",
    h.api.target < 100 && h.api.shown < 100, `target=${h.api.target} shown=${h.api.shown}`);
  check("...nor even crosses the classify band's ceiling",
    h.api.target <= 55, `target=${h.api.target}`);
}

console.log("\n── progress is monotonic: a late correction holds, never rewinds ──");
{
  const h = harness({ pending: null });
  h.api.assetPrepStep(3, 3);                 // preload finished: 99
  const high = h.api.target;
  h.api.assetPrepSet("CLASSIFYING_ASSETS", 5);   // a correction re-opens classification
  check("a lower claim cannot pull the bar backwards",
    h.api.target >= high, `was ${high}, now ${h.api.target}`);
}

console.log("\n── the single-step transition ──");
{
  const h = harness({ pending: "classifying" });
  h.api.syncAssetPrep();
  h.advance(1000); h.pump();                 // past the debounce, panel earned
  check("the overlay is showing while work is outstanding", h.els.agPrep.hidden === false);
  check("...and the chip hides its garment media meanwhile",
    h.els.activeGarment.classList.has("is-preparing"));

  h.api.assetPrepReady();
  h.pump();                                  // ease all the way to 100
  check("the counter actually LANDS on 100 before anything is revealed",
    h.api.shown === 100, `shown=${h.api.shown}`);
  check("...and the reveal is armed only once it has", h.timers.length === 1);

  h.fireTimers();
  check("the card is repainted with the final asset BEFORE the overlay lifts",
    h.renderCalls.length === 1 && h.renderCalls[0].agPrepHidden === false,
    JSON.stringify(h.renderCalls));
  check("...and the overlay is gone afterwards", h.els.agPrep.hidden === true);
  check("...leaving the chip back in its normal state",
    !h.els.activeGarment.classList.has("is-preparing"));
  check("the machine returns to IDLE, ready for the next item", h.api.phase === "IDLE");
}

console.log("\n── a warm prep never flashes the panel at all ──");
{
  const h = harness({ pending: null });
  h.api.assetPrepStep(0, 1);                 // gate opens
  h.advance(5);                              // resolves inside the debounce
  h.api.assetPrepStep(1, 1);
  h.api.assetPrepReady();
  h.pump(); h.fireTimers();
  check("nothing was ever painted, so there is no flash of chrome",
    h.api.visible === false && h.els.agPrep.hidden === true);
  check("...and it still settles to IDLE rather than wedging", h.api.phase === "IDLE");
}

console.log("\n── the preload gate does not fight the derived phase ──");
{
  const h = harness({ pending: null });
  h.api.assetPrepStep(1, 3);                 // gate mid-flight, nothing "pending"
  const t = h.api.target;
  h.api.syncAssetPrep();                     // an incidental repaint
  check("an incidental repaint cannot slam the bar to 100 mid-preload",
    h.api.phase === "PRELOADING_BLOBS" && h.api.target === t, `phase=${h.api.phase} target=${h.api.target}`);
}

console.log("\n── a composite build is preload work, not classification ──");
{
  const h = harness({ pending: "preparing the combined view", compositeBuilding: true });
  h.api.syncAssetPrep();
  check("a local composite build reports PRELOADING_BLOBS",
    h.api.phase === "PRELOADING_BLOBS", h.api.phase);
}

console.log("\n── goLive(): the gate is no longer scoped to AI Auto ──");
{
  const gate = extract("const wantedAutoView = currentAngle === AUTO_ANGLE;", "startScanTimer();");
  check("preloadGarmentAssets() is awaited unconditionally, not inside an AUTO_ANGLE branch",
    /^\s*const preload = await preloadGarmentAssets\(\);/m.test(gate) &&
    !/if \(currentAngle === AUTO_ANGLE\) \{\s*\n\s*\$\("scanOverlay"\)/.test(gate),
    "a front-only run must not reach connectRealtime() on an unvalidated reference");
  check("...and it still blocks BEFORE the session opens",
    SRC.indexOf("const preload = await preloadGarmentAssets();") < SRC.indexOf("await connectRealtime();"),
    "validating after connect would bill for a session conditioned on nothing");
  check("a missing front still aborts the whole run", /if \(!preload\.ok\)/.test(gate) && /return;/.test(gate));
  check("the front-only DOWNGRADE stays unconditional", /if \(!preload\.hasBack\) \{[\s\S]*currentAngle = "front";/.test(gate));
  check("...but its toast is scoped to a run that actually wanted AI Auto",
    /if \(wantedAutoView\) toast\(/.test(gate),
    "a garment that never had a back must not announce that its back view is unavailable");
}

console.log("\n── the overlay actually hides the unvalidated photo ──");
{
  check("CSS hides the garment media while preparing",
    /\.active-garment\.is-preparing > \.active-garment__media[\s\S]{0,160}visibility: hidden/.test(CSS));
  check("...via visibility, not display - the tile must not reflow on reveal",
    !/\.active-garment\.is-preparing > \.active-garment__media[\s\S]{0,160}display:\s*none/.test(CSS));
  check("the glass spec is the one that was asked for (blur 20px / saturate 180%)",
    /\.ag-prep \{[\s\S]{0,700}backdrop-filter: blur\(20px\) saturate\(180%\)/.test(CSS));
  check("...with the specified translucency and border",
    /\.ag-prep \{[\s\S]{0,700}background: rgba\(255, 255, 255, \.25\)/.test(CSS) &&
    /\.ag-prep \{[\s\S]{0,700}border: 1px solid rgba\(255, 255, 255, \.3\)/.test(CSS));
  check("...and specular inset highlights, not just a flat drop shadow",
    /\.ag-prep \{[\s\S]{0,900}inset 0\s+1px 0 rgba\(255, 255, 255, \.75\)/.test(CSS));
  check("the counter uses tabular figures so the row cannot jitter",
    /\.ag-prep__pct \{[\s\S]{0,400}font-variant-numeric: tabular-nums/.test(CSS));
  check("reduced-motion drops the sweep but keeps the readout",
    /prefers-reduced-motion[\s\S]{0,260}\.ag-prep__sheen \{ animation: none/.test(CSS));
}

console.log("\n── the markup contract the renderer depends on ──");
{
  const chip = HTML.slice(HTML.indexOf('id="activeGarment"'), HTML.indexOf('Camera stage'));
  check("the overlay lives INSIDE the chip it covers", /id="agPrep"/.test(chip));
  check("it starts hidden, so a pre-JS paint shows the normal card", /id="agPrep"[\s\S]{0,160}hidden/.test(chip));
  check("it is an accessible progressbar", /role="progressbar"/.test(chip) && /aria-valuemax="100"/.test(chip));
  check("the % sign is a SEPARATE child of the counter",
    /id="agPrepPct">0<i class="ag-prep__sign">%<\/i>/.test(chip),
    "app.js rewrites the leading text node - an inline % would be overwritten");
  check("the fill and phase targets exist", /id="agPrepFill"/.test(chip) && /id="agPrepPhase"/.test(chip));
}

console.log(fails === 0 ? "\nall green" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
