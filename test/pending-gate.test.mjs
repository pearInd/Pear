/* The go-live gate for "still loading a back view", and its visual half.

   Two real pieces of app.js, extracted verbatim (not reimplemented):
     - itemPendingReason()/livePendingReason() - the predicate goLive() checks BEFORE
       opening any session; a non-null result blocks the click with a toast.
     - syncCaptureButtonPendingState() - the visual half, called from
       renderActiveGarment() so the button's greyed/spinner state tracks the exact
       same predicate the functional gate uses (one predicate, two effects - they
       cannot disagree about whether something is pending). */
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

const code =
  extract("function resolveLook()", "/* =============================================================================\n   Camera + engine bootstrap") +
  extract("function syncCaptureButtonPendingState", "/* =============================================================================\n   \"Complete the Look\"") +
  extract("function itemPendingReason", "/* The EXACT source image fed to the AI");

check("extracted itemPendingReason/livePendingReason", /function itemPendingReason/.test(code) && /function livePendingReason/.test(code));
check("extracted syncCaptureButtonPendingState", /function syncCaptureButtonPendingState/.test(code));

function makeBtn() {
  const classes = new Set();
  return {
    classList: {
      toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); },
      has: (c) => classes.has(c),
    },
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; },
  };
}

function run({ activeItem, activeOutfit = { top: null, bottom: null } }) {
  const btn = makeBtn();
  const sandbox = { activeOutfit, activeItem, $: () => btn };
  const fn = new Function(...Object.keys(sandbox), code +
    "\nreturn { itemPendingReason, livePendingReason, syncCaptureButtonPendingState };");
  const api = fn(...Object.values(sandbox));
  return { api, btn };
}

console.log("── itemPendingReason: the predicate itself ──");
{
  const { api } = run({ activeItem: null });
  check("null item -> not pending", api.itemPendingReason(null) === null);
  check("plain item, no flags -> not pending", api.itemPendingReason({ name: "Tee" }) === null);
  check("awaiting the widget's correction -> pending (non-null reason)",
    typeof api.itemPendingReason({ name: "Tee", _awaitingBackCorrection: true }) === "string");
  check("local composite building -> pending (non-null reason)",
    typeof api.itemPendingReason({ name: "Tee", _compositeBuilding: true }) === "string");
  check("both flags -> still just one reason, no crash",
    typeof api.itemPendingReason({ name: "Tee", _awaitingBackCorrection: true, _compositeBuilding: true }) === "string");
}

console.log("\n── livePendingReason: single item vs. a full look (both slots checked) ──");
{
  const pendingTop = { name: "Shirt", garmentType: "upper_body", _awaitingBackCorrection: true };
  const readyBottom = { name: "Pants", garmentType: "lower_body" };
  const { api: apiLook } = run({ activeItem: null, activeOutfit: { top: pendingTop, bottom: readyBottom } });
  check("a full look with ONE pending half still blocks go-live",
    typeof apiLook.livePendingReason() === "string");

  const readyTop = { name: "Shirt", garmentType: "upper_body" };
  const { api: apiReadyLook } = run({ activeItem: null, activeOutfit: { top: readyTop, bottom: readyBottom } });
  check("a full look with NEITHER half pending does not block",
    apiReadyLook.livePendingReason() === null);

  const { api: apiSingle } = run({ activeItem: { name: "Tee", _awaitingBackCorrection: true } });
  check("single-item mode (no look) reads activeItem directly",
    typeof apiSingle.livePendingReason() === "string");
}

console.log("\n── syncCaptureButtonPendingState: the visual half tracks the SAME predicate ──");
{
  const { api, btn } = run({ activeItem: { name: "Tee", _awaitingBackCorrection: true } });
  api.syncCaptureButtonPendingState();
  check("button gets the pending class while blocked", btn.classList.has("is-pending-back"));
  check("aria-busy reflects it for assistive tech", btn._attrs["aria-busy"] === "true");
}
{
  const { api, btn } = run({ activeItem: { name: "Tee" } });
  api.syncCaptureButtonPendingState();
  check("button does NOT get the pending class once nothing is pending",
    !btn.classList.has("is-pending-back"));
  check("aria-busy false when not pending", btn._attrs["aria-busy"] === "false");
}
{
  // $("captureBtn") returning null (page not fully loaded, or a different screen) must
  // not throw - this runs on every renderActiveGarment() call, including ones that can
  // happen before the DOM is fully wired.
  const sandbox = { activeOutfit: { top: null, bottom: null }, activeItem: { name: "Tee" }, $: () => null };
  const fn = new Function(...Object.keys(sandbox), code + "\nreturn { syncCaptureButtonPendingState };");
  let threw = false;
  try { fn(...Object.values(sandbox)).syncCaptureButtonPendingState(); } catch (_) { threw = true; }
  check("does not throw when the button element is not found", !threw);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
