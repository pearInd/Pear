/* RETURNING-USER SIZE-MISMATCH CARD - proactive counterpart to the goLive() gate
   tested in kids-adult-size-guard.test.mjs.

   THE BUG THIS CLOSES: a returning shopper with a saved adult profile never sees
   Screen 1 at all - routeUser()'s instant-skip fast path (hasProfile && not refresh-
   due) calls calculateSize() directly and lands straight in the camera room via
   goToFitting({instant:true}). Before this, nothing painted ANY warning until that
   shopper actually pressed Go Live and hit the goLive() gate's toast - the camera
   modal itself stayed silent and the Start Fitting button stayed enabled the whole
   time a kids-only garment was incompatible with their profile. updateSizeMismatchUI()
   keeps a persistent card + a disabled button in sync with the SAME
   isCompatibleSizeCategory() check goLive() uses, from every point that check's
   inputs can change - not only on the one click that was always going to be blocked
   anyway. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
/* The kids/adult rules are server-side since 2026-09-26 (lib/sizing.js). The card is the
   browser's; it is driven here against the REAL rules through the sanitiser and a JSON
   round trip, exactly as POST /api/size answers it. */
const SIZING = await import("../lib/sizing.js");
const requestSizeVerdict = (ev) =>
  Promise.resolve(SIZING.computeSizeVerdict(SIZING.sanitizeSizeEvidence(JSON.parse(JSON.stringify(ev)))));

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in app.js`);
  const end = APP.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return APP.slice(start, end);
}

console.log("── §1 updateSizeMismatchUI(): real DOM state, real message, real button gating ──");
{
  const code = extract("function resolvedGarmentAgeGroup(", "function calculateSize()");

  /* Resolved: the product verdict has landed (see kids-adult-size-guard §1 for the window
     before it does). */
  async function harness(opts = {}) {
    const h = rawHarness(opts);
    await h.api.loadProductVerdict();
    return h;
  }
  function rawHarness({ activeItem = null, pendingAgeGroup = undefined, pendingSizes = undefined,
                        currentBodyCategory = null, localStream = null, missingView = false } = {}) {
    const view = { hidden: true };
    const textEl = { textContent: "" };
    const captureBtn = { disabled: false };
    const cardClasses = new Set();
    const cameraCard = { classList: {
      toggle: (c, on) => { if (on) cardClasses.add(c); else cardClasses.delete(c); },
    } };
    let selectorRemoved = false;
    const pearSizeSelector = { remove: () => { selectorRemoved = true; } };
    const els = {
      sizeMismatchView: missingView ? null : view, sizeMismatchText: textEl,
      captureBtn, cameraCard, pearSizeSelector,
    };
    const $ = (id) => els[id] ?? null;
    const fn = new Function("activeItem", "pendingAgeGroup", "pendingSizes",
      "currentBodyCategory", "localStream", "$", "requestSizeVerdict",
      code + "\nreturn { updateSizeMismatchUI, loadProductVerdict };");
    const api = fn(activeItem, pendingAgeGroup, pendingSizes, currentBodyCategory, localStream, $,
                   requestSizeVerdict);
    return { api, view, textEl, captureBtn, cardClasses, selectorRemoved: () => selectorRemoved };
  }

  /* The REPORTED product: kids-only numeric sizes, and a classifier that abstained -
     the combination that previously sailed through. */
  const blocked = await harness({
    activeItem: { ageGroup: "uncertain", sizes: ["8", "10", "12", "14", "16"] },
    currentBodyCategory: "adult", localStream: {},
  });
  blocked.api.updateSizeMismatchUI();
  check("adult body + kids-only sizes (classifier 'uncertain'): the card is shown",
    blocked.view.hidden === false);
  check("...Start Fitting is disabled", blocked.captureBtn.disabled === true);
  check("...the live stage is suppressed, not just overlaid",
    blocked.cardClasses.has("size-mismatched"));
  check("...and the adult size selector is removed outright",
    blocked.selectorRemoved() === true);
  check("...the card carries the required Hebrew text",
    blocked.textEl.textContent.includes("הפריט אינו בטווח המידות שלך (פריט במידות ילדים)") &&
    blocked.textEl.textContent.includes("אינך יכול למדוד פריט זה במידה הנוכחית"),
    blocked.textEl.textContent);
  check("...and the English fallback",
    blocked.textEl.textContent.includes("This item is not within your size range (Kids item)"),
    blocked.textEl.textContent);

  const okAdult = await harness({
    activeItem: { ageGroup: "uncertain", sizes: ["S", "M", "L", "XL"] },
    currentBodyCategory: "adult", localStream: {},
  });
  okAdult.api.updateSizeMismatchUI();
  check("adult body + adult sizes: the card stays hidden", okAdult.view.hidden === true);
  check("...Start Fitting is enabled (camera already running)", okAdult.captureBtn.disabled === false);
  check("...and the live stage is NOT suppressed", !okAdult.cardClasses.has("size-mismatched"));

  const noCamera = await harness({
    activeItem: { ageGroup: "adult" }, currentBodyCategory: "adult", localStream: null,
  });
  noCamera.api.updateSizeMismatchUI();
  check("compatible item but no camera stream yet: Start Fitting still disabled\n" +
        "        (this function must not fight the existing !localStream gate)",
    noCamera.view.hidden === true && noCamera.captureBtn.disabled === true);

  const noView = await harness({
    activeItem: { ageGroup: "kids" }, currentBodyCategory: "adult", missingView: true,
  });
  let threw = false;
  try { noView.api.updateSizeMismatchUI(); } catch (_) { threw = true; }
  check("missing #sizeMismatchView (older cached DOM/markup) - degrades safely, never throws",
    threw === false);

  /* THE LATE VERDICT REPAINTS THE CARD BY ITSELF. A garment swap reads the card before the
     server has answered for the new product, and paints "no mismatch" (never block on
     ambiguity). The answer must then correct it without waiting for another event. */
  const late = rawHarness({
    activeItem: { ageGroup: "uncertain", sizes: ["8", "10", "12", "14", "16"] },
    currentBodyCategory: "adult", localStream: {},
  });
  late.api.updateSizeMismatchUI();
  check("before the product verdict lands: the card is hidden and Start Fitting enabled",
    late.view.hidden === true && late.captureBtn.disabled === false);
  await late.api.loadProductVerdict();
  check("...and when it lands the card is shown and Start Fitting disabled, with no further call",
    late.view.hidden === false && late.captureBtn.disabled === true && late.selectorRemoved() === true);
}

console.log("\n── §2 WIRING: every point the mismatch inputs can change re-checks the card ──");
{
  const calc = extract("function calculateSize() {", "\nfunction updateProgress()");
  check("calculateSize() re-checks the card on its resolved-size path - the ONLY place\n" +
        "        the returning-user fast path (routeUser -> calculateSize -> goToFitting,\n" +
        "        Screen 1 never shown) ever reaches",
    /updateSizeMismatchUI\(\);/.test(calc), calc.slice(-400));

  const room = extract("function enterRoom() {", "\nfunction releaseCompositePreview");
  check("enterRoom() re-checks the card before the room is shown",
    /updateSizeMismatchUI\(\);/.test(room));

  const listener = extract('e.data.type !== "PEAR_UPDATE_GARMENT"', "const front = e.data.garment_url;");
  check("the PEAR_UPDATE_GARMENT listener re-checks the card when a late kids/adult\n" +
        "        verdict arrives (the room may already be open by then)",
    /updateSizeMismatchUI\(\);/.test(listener));

  /* THE BUG THIS CLOSES: setActiveItem() - the mid-session catalog-panel swap, reachable
     while the room is already open - was the one point this file's own header comment
     ("from every point that check's inputs can change") demonstrably lied about: it
     changes activeItem, which is exactly what resolvedGarmentSizes()/
     resolvedGarmentAgeGroup() read, and it never re-ran the check. A shopper who opened
     a kids-only item (card shown, captureBtn disabled) and then swapped to a genuinely
     compatible adult item via the catalog was left with the stale card up and the
     button still disabled - a dead end, since a disabled button never fires the click
     that would reach goLive()'s own fresh recompute. Found in the adult-numeric-pants
     sizing audit (2026-09-12) while re-tracing every caller of hasSizeCategoryMismatch()/
     updateSizeMismatchUI(), independent of that audit's actual pants-vs-letters scope. */
  const swap = extract("function setActiveItem(item, opts = {}) {", "\nwindow.pearGetActiveGarment");
  check("setActiveItem() (mid-session catalog swap) re-checks the card too, so a stale\n" +
        "        mismatch can't survive a swap into a now-compatible garment",
    /updateSizeMismatchUI\(\);/.test(swap), swap.slice(-500));

  const wiring = extract('$("captureBtn").addEventListener("click", onLiveToggle);', "\n\n");
  check("the card's CTA button is wired to the SAME screen the 'Edit Measurements'\n" +
        "        button already sends shoppers to (backToCalculator)",
    /sizeMismatchUpdateBtn.*addEventListener\("click",\s*backToCalculator\)/.test(wiring), wiring);
}

console.log("\n── §3 MARKUP: the card lives inside the camera modal, not bolted on elsewhere ──");
{
  const errIdx = HTML.indexOf('id="camError"');
  const viewIdx = HTML.indexOf('id="sizeMismatchView"');
  const textIdx = HTML.indexOf('id="sizeMismatchText"');
  const btnIdx = HTML.indexOf('id="sizeMismatchUpdateBtn"');
  const cameraCardCloseIdx = HTML.indexOf("<!-- ░░ Live try-on controls ░░ -->");
  check("the card follows #camError, inside #cameraCard's own markup block",
    errIdx !== -1 && viewIdx > errIdx && viewIdx < cameraCardCloseIdx);
  check("the message paragraph and the CTA button are both present inside the card",
    textIdx > viewIdx && btnIdx > textIdx);
  check("the card ships hidden by default - JS alone decides when it's shown",
    /id="sizeMismatchView"[^>]*\bhidden\b/.test(HTML));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
