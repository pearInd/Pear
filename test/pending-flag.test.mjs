/* setActiveItem()'s "waiting for a back view" flag - the SETTING side. (The clearing
   side, in the PEAR_UPDATE_GARMENT listener, is covered by composite-handoff.test.mjs;
   the CSS/render-predicate side by thumbnail.test.mjs.)

   Extracts the exact lines out of setActiveItem() that decide whether to arm
   item._awaitingBackCorrection and its 35s give-up timer - not a reimplementation,
   the real source between two fixed markers - and runs them in isolation, since the
   surrounding function pulls in a large, unrelated dependency graph ($, activeOutfit,
   renderCompleteTheLook, toast, isLive, ...) that this specific logic does not need. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const START = '$("focusItemName").innerText = item.name;';
const END   = 'renderActiveGarment();             // shows either the single item or the full look';
const startIdx = SRC.indexOf(START);
const endIdx = SRC.indexOf(END, startIdx);
if (startIdx === -1) throw new Error(`could not find start marker in app.js - has setActiveItem() been refactored?`);
if (endIdx === -1) throw new Error(`could not find end marker in app.js - has setActiveItem() been refactored?`);
const snippet = SRC.slice(startIdx, endIdx);
check("extracted the flag-arming snippet", /_awaitingBackCorrection/.test(snippet) && /35000/.test(snippet),
  "markers matched, but the expected flag/timeout code wasn't in between - check the extraction window");

/* Controllable setTimeout/clearTimeout: captures the real callback the extracted code
   registers instead of letting 35 real seconds pass, so the "give up and repaint" test
   below can invoke the ACTUAL code path synchronously rather than re-describing what
   it's expected to do. Mirrors the deferred-promise pattern used for
   createGarmentComposite's bitmap loads elsewhere in this test suite. */
function makeTimerMock() {
  let nextId = 1;
  const timers = new Map();   // id -> { fn, cleared }
  return {
    setTimeout: (fn) => { const id = nextId++; timers.set(id, { fn, cleared: false }); return id; },
    clearTimeout: (id) => { const t = timers.get(id); if (t) t.cleared = true; },
    fire: (id) => { const t = timers.get(id); if (t && !t.cleared) t.fn(); },
  };
}

function run(item, { distinctBack = undefined, timers = makeTimerMock() } = {}) {
  const calls = [];
  const sandbox = {
    item,
    get activeItem() { return sandbox._activeItem; },
    set activeItem(v) { sandbox._activeItem = v; },
    _activeItem: item,   // setActiveItem() has already assigned activeItem = item by this point
    $: () => ({ set innerText(_) {} }),
    distinctBackOf: () => distinctBack,
    renderActiveGarment: () => calls.push("renderActiveGarment"),
    console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  };
  const fn = new Function("scope", `with (scope) { ${snippet} }`);
  fn(sandbox);
  return { item, calls, timers };
}

console.log("── widget handoff, no back at all: arms the waiting flag ──");
{
  const item = { name: "Tee", custom: true, img: "https://cdn.test/front.jpg" };
  run(item, { distinctBack: undefined });
  check("flag armed", item._awaitingBackCorrection === true);
  check("a timer handle was captured", item._awaitingBackTimer != null);
}

console.log("\n── widget handoff that ALREADY has a distinct back: no flag, nothing to wait for ──");
{
  const item = { name: "Tee", custom: true, img: "https://cdn.test/front.jpg", imgBack: "https://cdn.test/back.jpg" };
  run(item, { distinctBack: "https://cdn.test/back.jpg" });
  check("flag NOT armed", item._awaitingBackCorrection === false);
  check("no timer started", item._awaitingBackTimer == null);
}

console.log("\n── widget handoff that already carries a composite: no flag, already done ──");
{
  const item = { name: "Tee", custom: true, img: "https://cdn.test/front.jpg", composite: "data:image/jpeg;base64,X" };
  run(item, { distinctBack: undefined });
  check("flag NOT armed - a composite already answers the question", item._awaitingBackCorrection === false);
}

console.log("\n── catalog / non-widget item: never armed, regardless of back state ──");
{
  const item = { name: "Catalog Tee", custom: false, img: "https://cdn.test/front.jpg" };
  run(item, { distinctBack: undefined });
  check("flag NOT armed for a non-widget item (nothing external is ever going to correct it)",
    item._awaitingBackCorrection === false);
}

console.log("\n── re-entering setActiveItem for the SAME item cancels any previous timer ──");
{
  // ONE shared timer mock across both calls - matching the real page, which has a
  // single global setTimeout/clearTimeout namespace shared by every call.
  const timers = makeTimerMock();
  const item = { name: "Tee", custom: true, img: "https://cdn.test/front.jpg" };
  run(item, { distinctBack: undefined, timers });
  const firstTimer = item._awaitingBackTimer;
  check("first pass armed a timer", firstTimer != null);
  run(item, { distinctBack: undefined, timers });   // e.g. a second setActiveItem() call before the first message ever arrived
  check("a NEW timer replaces the old one (no stacked/duplicate timers)",
    item._awaitingBackTimer != null && item._awaitingBackTimer !== firstTimer);
  // Prove it's not just a different id but a genuinely CANCELLED one: firing the old
  // id must do nothing now that setActiveItem() has moved on.
  timers.fire(firstTimer);
  check("the OLD timer was actually cancelled, not just replaced", item._awaitingBackCorrection === true,
    "if the stale timer fired for real, it would have wrongly cleared the flag the second pass just armed");
}

console.log("\n── THE GIVE-UP TIMEOUT: clears itself and repaints if nothing ever arrives ──");
{
  const item = { name: "Tee", custom: true, img: "https://cdn.test/front.jpg" };
  const { calls, timers } = run(item, { distinctBack: undefined });
  check("flag armed before the timeout fires", item._awaitingBackCorrection === true);
  const timerId = item._awaitingBackTimer;
  check("a timer id was captured", timerId != null);

  // Fire the REAL captured callback - the actual give-up code path, not a re-description
  // of it - simulating 35s elapsing with no PEAR_UPDATE_GARMENT ever arriving.
  timers.fire(timerId);

  check("give-up path clears the flag", item._awaitingBackCorrection === false);
  check("give-up path clears its own timer reference", item._awaitingBackTimer === null);
  check("give-up path repaints so the spinner actually disappears",
    calls.includes("renderActiveGarment"), JSON.stringify(calls));
}

console.log("\n── the give-up timeout is a no-op if the flag was already resolved first ──");
{
  // The realistic race: PEAR_UPDATE_GARMENT arrives (the listener clears the flag via
  // clearTimeout) a moment before this fake 35s mark - but prove the CALLBACK BODY's
  // own internal guard also holds even if clearTimeout somehow didn't run.
  const item = { name: "Tee", custom: true, img: "https://cdn.test/front.jpg" };
  const { calls, timers } = run(item, { distinctBack: undefined });
  const timerId = item._awaitingBackTimer;

  item._awaitingBackCorrection = false;   // simulate the listener having already resolved this

  timers.fire(timerId);
  check("no spurious repaint for a timer that fired after the wait was already over",
    calls.length === 0, JSON.stringify(calls));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
