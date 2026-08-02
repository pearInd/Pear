/* "I tried on a shirt and it changed my trousers."

   ROOT CAUSE: setActiveItem()'s outfit-slot write was ADDITIVE unconditionally. Two
   very different actions went through it - "try this on" (a catalog card, a store
   handoff, a custom upload, a replay) and "Add to Look" (the shopper explicitly
   assembling an outfit) - and only the second one wants the opposite slot to survive.

   So a shopper who had EVER selected trousers left activeOutfit.bottom populated for
   the rest of the session. Picking a shirt afterwards made resolveLook() return a
   COMPLETE look, applyActive() routed to applyLook(), and the payload substituted BOTH
   layers - replacing real trousers the shopper never asked to try on. The
   single-garment prompt that carries KEEP_BOTTOMS ("do not change, recolor, restyle or
   re-render the trousers") was never the one on the wire.

   It reads as a model hallucination and it is not: it is deterministic state leakage,
   and it surfaces on stepping back purely because that is when the lower body enters
   frame and the substitution becomes visible.

   FIX: replace is the default, additive is opt-in from addToLook() alone. This drives
   the REAL slot-write and the REAL resolveLook()/applyActive() routing predicate
   extracted from app.js - not a re-implementation of them. */
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

/* The real slot-write, lifted verbatim out of setActiveItem() together with the real
   slotOf() and resolveLook(). If any of the three is edited in a way that lets a
   "try this on" leave the opposite slot populated, these tests fail. */
const slotWrite = extract("  const slot = slotOf(item);", "  $(\"focusItemName\")");
check("extracted the real slot write", /activeOutfit\[slot\] = item/.test(slotWrite) && /opts\.additive/.test(slotWrite));

const slotOfSrc     = extract("const slotOf = (item)", "\nconst outfitComplete");
const resolveLookSrc = extract("function resolveLook()", "\n/* ====");
check("extracted the real resolveLook()", /activeOutfit/.test(resolveLookSrc));

function harness() {
  const activeOutfit = { top: null, bottom: null };
  const completeLook = { classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, has(c) { return this._c.has(c); } } };
  const sandbox = {
    activeOutfit,
    $: (id) => (id === "completeLook" ? completeLook : null),
  };
  const api = new Function(...Object.keys(sandbox),
    slotOfSrc + "\n" + resolveLookSrc + "\n" +
    "function setSlot(item, opts) {\n" + slotWrite + "\n}\n" +
    "return { setSlot, resolveLook };"
  )(...Object.values(sandbox));
  return { ...api, activeOutfit, completeLook };
}

const SHIRT  = { id: 3, name: "Ion Crew Tee", garmentType: "upper_body" };
const SHIRT2 = { id: 6, name: "Strata",       garmentType: "upper_body" };
const PANTS  = { id: 9, name: "Glide Slim",   garmentType: "lower_body" };

console.log("\n── THE BUG: picking a shirt after browsing trousers ──");
{
  const h = harness();
  h.setSlot(PANTS, {});                       // shopper tries trousers (a catalog pick)
  check("trousers land in the bottom slot", h.activeOutfit.bottom === PANTS);

  h.setSlot(SHIRT, {});                       // shopper now tries a shirt - ONE garment
  check("the shirt lands in the top slot", h.activeOutfit.top === SHIRT);
  /* The whole point. Before the fix this was still PANTS, resolveLook() returned a
     complete look, and applyLook() substituted the shopper's real trousers too. */
  check("the trouser slot is CLEARED - zero mutation of the untargeted layer",
    h.activeOutfit.bottom === null, `bottom = ${h.activeOutfit.bottom && h.activeOutfit.bottom.name}`);
  check("resolveLook() therefore returns null → the SINGLE-garment prompt (with KEEP_BOTTOMS) is sent",
    h.resolveLook() === null, JSON.stringify(h.resolveLook()));
}

console.log("\n── the mirror case: picking trousers after a shirt ──");
{
  const h = harness();
  h.setSlot(SHIRT, {});
  h.setSlot(PANTS, {});
  check("the shirt slot is cleared", h.activeOutfit.top === null);
  check("resolveLook() returns null → the prompt carries KEEP_TOP", h.resolveLook() === null);
}

console.log("\n── swapping WITHIN a category never touches the other slot ──");
{
  const h = harness();
  h.setSlot(SHIRT, {});
  h.setSlot(SHIRT2, {});
  check("the new shirt replaces the old one", h.activeOutfit.top === SHIRT2);
  check("the bottom slot stays empty (nothing to clear, nothing invented)", h.activeOutfit.bottom === null);
}

console.log("\n── 'Add to Look' is the ONE additive caller, and still works ──");
{
  const h = harness();
  h.setSlot(SHIRT, {});
  h.setSlot(PANTS, { additive: true });       // addToLook()
  check("the shirt SURVIVES an explicit add-to-look", h.activeOutfit.top === SHIRT);
  check("the trousers fill the bottom slot", h.activeOutfit.bottom === PANTS);
  const look = h.resolveLook();
  check("resolveLook() returns the complete look → ONE combined payload", !!look);
  check("look halves are correctly categorised", look && look.top === SHIRT && look.bottom === PANTS);
}

console.log("\n── leaving a complete look via a plain catalog pick ──");
{
  const h = harness();
  h.setSlot(SHIRT, {});
  h.setSlot(PANTS, { additive: true });
  h.completeLook.classList.add("is-complete");

  h.setSlot(SHIRT2, {});                      // shopper picks a different shirt to try alone
  check("the look is broken back to a single garment", h.activeOutfit.bottom === null);
  /* A stale .is-complete would leave the UI claiming a full look while the payload
     sends one garment - the chip and the wire must agree. */
  check("the 'complete look' UI flag is cleared with it",
    !h.completeLook.classList.has("is-complete"));
}

console.log("\n── the call sites: additive must remain opt-in, from addToLook() alone ──");
{
  const callers = [...SRC.matchAll(/setActiveItem\(([^;]*?)\);/g)].map((m) => m[1]);
  const additive = callers.filter((c) => /additive/.test(c));
  check("exactly ONE setActiveItem() call site opts into additive",
    additive.length === 1, `${additive.length} found: ${JSON.stringify(additive)}`);

  const addToLookSrc = extract("function addToLook(piece)", "function resolveLook");
  check("...and it is addToLook()", /setActiveItem\(piece, \{[^}]*additive: true/.test(addToLookSrc));
}

console.log(fails ? `\n${fails} check(s) FAILED` : "\nAll checks passed.");
process.exit(fails ? 1 : 0);
