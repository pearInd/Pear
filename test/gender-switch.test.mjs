/* =============================================================================
   THE GENDER SWITCH - Liquid Glass tap + press-and-drag, one state path
   -----------------------------------------------------------------------------
   #genderToggle was restyled to the language switch's glass language and given
   press-and-drag physics (setupGenderSwitch in app.js). The risk in adding a gesture
   layer to a control that already had a click handler is the STATE, not the look:
   a tap counted twice toggles a choice straight back off, and a drag's trailing click
   does the same. This suite runs the REAL setGender() + setupGenderSwitch() in jsdom
   (layout stubbed - jsdom has none) and pins:
     §1  a tap is one setGender(), and tapping the active option still clears it
         (the selector is optional - CLAUDE.md §2.5);
     §2  a drag past half commits, short of half springs back, never clears a choice,
         and its trailing click is swallowed;
     §3  rubber-band past the ends, pointercancel re-settles, a drag from unset picks
         the side it ends on, a press under the slop stays a tap;
     §4  RTL (men on the right) drags correctly with no mirrored math;
     §5  markup and CSS contract: the radiogroup setGender() reads, centred, glass,
         spring snap, pan-y, reduced motion - and exactly one click listener.
   ============================================================================= */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
function extract(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

const logic = extract(SRC, "function setGender(gender) {", "function updateProgress()");
const groupStart = HTML.indexOf('<div class="form-group gender-group">');
const groupMarkup = HTML.slice(groupStart, HTML.indexOf('<div class="form-group">', groupStart));

/* A fresh page, the real markup, stubbed geometry: a 288px track at x=100 with a 1px border,
   4px pad, two 140px columns. `rtl` mirrors the columns the way the browser lays them out. */
function mount({ rtl = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html dir="${rtl ? "rtl" : "ltr"}"><body><form id="sizeForm">${groupMarkup}</form></body></html>`);
  const { window } = dom, { document } = window;
  const track = document.getElementById("genderToggle");
  const pill = track.querySelector(".liquid-glass-pill");
  const men = track.querySelector('[data-gender="men"]'), women = track.querySelector('[data-gender="women"]');
  const def = (el, props) => { for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { configurable: true, get: () => v }); };
  def(track, { clientLeft: 1 });
  track.getBoundingClientRect = () => ({ left: 100, right: 390, top: 0, bottom: 44, width: 290, height: 44 });
  def(men, { offsetLeft: rtl ? 144 : 4, offsetWidth: 140 });
  def(women, { offsetLeft: rtl ? 4 : 144, offsetWidth: 140 });
  def(pill, { offsetLeft: rtl ? 144 : 4, offsetWidth: 140 });   // inset-inline-start: the first slot in reading order

  let calcCalls = 0;
  const api = new Function("document", "$", "calculateSize",
    "let currentUserGender = null;\n" + logic +
    "\nreturn { setGender, setupGenderSwitch, get gender() { return currentUserGender; } };")(
    document, (id) => document.getElementById(id), () => { calcCalls++; });
  api.setupGenderSwitch(track);

  const pe = (type, x, target = track, id = 1) => {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
    Object.defineProperty(ev, "pointerId", { value: id });
    Object.defineProperty(ev, "pointerType", { value: "mouse" });
    target.dispatchEvent(ev);
  };
  const click = (btn) => btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const tap = (btn, x) => { pe("pointerdown", x, btn); pe("pointerup", x, btn); click(btn); };
  const drag = (from, to, { target = track, end = "pointerup", steps = 4 } = {}) => {
    pe("pointerdown", from, target);
    for (let i = 1; i <= steps; i++) pe("pointermove", from + ((to - from) * i) / steps, target);
    pe(end, to, target);
  };
  return { window, track, pill, men, women, api, pe, click, tap, drag,
    get calcCalls() { return calcCalls; } };
}
const state = (m) => ({ gender: m.api.gender, active: m.track.dataset.active, menChecked: m.men.getAttribute("aria-checked"),
  womenChecked: m.women.getAttribute("aria-checked"), transform: m.pill.style.transform, dragging: m.track.classList.contains("is-dragging"),
  preview: m.track.dataset.preview });

console.log("── §1 A TAP IS ONE setGender() ──");
{
  const m = mount();
  m.tap(m.men, 170);
  check("tapping MEN selects men - once, not toggled back off by a second handler",
    m.api.gender === "men" && m.track.dataset.active === "men" && m.men.getAttribute("aria-checked") === "true" && m.men.classList.contains("is-active"),
    JSON.stringify(state(m)));
  check("...and recomputes the size through setGender(), with no inline transform left behind",
    m.calcCalls === 1 && m.pill.style.transform === "", JSON.stringify(state(m)));
  m.tap(m.men, 170);
  check("tapping the ACTIVE option still clears it back to unset (optional field, CLAUDE.md §2.5)",
    m.api.gender === null && m.track.dataset.active === "" && m.men.getAttribute("aria-checked") === "false", JSON.stringify(state(m)));
  m.click(m.women);
  check("a click with no pointer before it (Enter/Space on a focused option) still selects",
    m.api.gender === "women", JSON.stringify(state(m)));
}

console.log("\n── §2 A DRAG PAST HALF COMMITS, SHORT OF HALF SPRINGS BACK ──");
{
  const m = mount();
  m.tap(m.men, 170);
  m.pe("pointerdown", 170, m.men);
  m.pe("pointermove", 220, m.men);
  m.pe("pointermove", 260, m.men);
  const live = state(m);
  check("mid-drag the pill follows the pointer 1:1 (inline translate3d), under .is-dragging, previewing the half it is over",
    live.dragging && live.transform === "translate3d(90.0px, 0, 0)" && live.preview === "women" && live.gender === "men", JSON.stringify(live));
  m.pe("pointerup", 260, m.men);
  m.click(m.men);   // the click a browser may still dispatch where the press began
  check("released past half: WOMEN is committed, and the trailing click did not toggle it (or men) back",
    m.api.gender === "women" && m.track.dataset.active === "women" && m.women.getAttribute("aria-checked") === "true", JSON.stringify(state(m)));
  check("...and the inline transform and drag state are gone, so the CSS spring snaps it to the slot",
    m.pill.style.transform === "" && !m.track.classList.contains("is-dragging") && m.track.dataset.preview === undefined, JSON.stringify(state(m)));

  const calcBefore = m.calcCalls;
  m.drag(300, 240, { target: m.women });   // women slot starts at 144: 144-60 = 84, centre 154 - still nearer women
  check("released SHORT of half: nothing is committed, no recompute - it springs back",
    m.api.gender === "women" && m.calcCalls === calcBefore && m.pill.style.transform === "", JSON.stringify(state(m)));
  m.drag(300, 320, { target: m.women });   // dragged further onto its own side
  check("releasing over the side ALREADY chosen never clears it - only a tap clears",
    m.api.gender === "women", JSON.stringify(state(m)));
}

console.log("\n── §3 RUBBER BAND, CANCEL, UNSET, SLOP ──");
{
  const m = mount();
  m.tap(m.women, 300);
  m.pe("pointerdown", 300, m.women);
  m.pe("pointermove", 400, m.women);
  const t = m.pill.style.transform;
  check("past the end of the track the pill resists: 100px of overshoot moves it 28px, not 100",
    t === "translate3d(168.0px, 0, 0)", t);
  m.pe("pointerup", 400, m.women);

  m.pe("pointerdown", 300, m.women);
  m.pe("pointermove", 250, m.women);
  m.pe("pointermove", 180, m.women);
  m.pe("pointercancel", 180, m.women);
  check("pointercancel (a vertical swipe taking the gesture to scroll) re-settles without committing",
    m.api.gender === "women" && m.pill.style.transform === "" && !m.track.classList.contains("is-dragging"), JSON.stringify(state(m)));

  const u = mount();
  u.drag(175, 275);
  check("with NOTHING chosen, a drag picks up the pill under the finger and commits the side it ends on",
    u.api.gender === "women", JSON.stringify(state(u)));

  const s = mount();
  s.pe("pointerdown", 170, s.men);
  s.pe("pointermove", 174, s.men);   // 4px - under the 6px slop
  s.pe("pointerup", 174, s.men);
  check("a press that moves under the slop is not a drag - no drag state, no inline transform",
    !s.track.classList.contains("is-dragging") && s.pill.style.transform === "", JSON.stringify(state(s)));
  s.click(s.men);
  check("...and its click is NOT swallowed - it selects, like any tap", s.api.gender === "men", JSON.stringify(state(s)));

  const w = mount();
  w.drag(170, 260, { target: w.men });   // a drag with no trailing click at all
  w.tap(w.men, 170);                      // a real tap straight after it
  check("a real tap straight after a drag that produced no trailing click is not eaten",
    w.api.gender === "men", JSON.stringify(state(w)));
}

console.log("\n── §4 RTL - the Hebrew layout, men on the right ──");
{
  const m = mount({ rtl: true });
  m.tap(m.men, 320);
  m.pe("pointerdown", 320, m.men);
  m.pe("pointermove", 260, m.men);
  m.pe("pointermove", 210, m.men);
  const live = state(m);
  check("dragging LEFT from men (the right-hand slot) moves the pill left from its right-hand anchor",
    live.transform === "translate3d(-110.0px, 0, 0)" && live.preview === "women", JSON.stringify(live));
  m.pe("pointerup", 210, m.men);
  check("...and commits WOMEN - the half it is over, measured, not assumed from reading order",
    m.api.gender === "women", JSON.stringify(state(m)));
}

console.log("\n── §5 THE CONTRACT - markup, CSS, wiring ──");
{
  check("#genderToggle keeps the radiogroup setGender() reads: role, data-active, two .gender-tab radios with data-gender",
    /id="genderToggle" role="radiogroup"[^>]*data-active=""/.test(groupMarkup) &&
    (groupMarkup.match(/class="gender-tab gender-option" type="button" role="radio" aria-checked="false" data-gender="(men|women)"/g) || []).length === 2);
  check("the pill is decorative and the icons are hidden from assistive tech",
    /class="liquid-glass-pill" aria-hidden="true"/.test(groupMarkup) && (groupMarkup.match(/<svg class="gender-option__icon"[^>]*aria-hidden="true"/g) || []).length === 2);
  check("the labels stay translatable (data-i18n on both options)",
    /data-i18n="genderMen"/.test(groupMarkup) && /data-i18n="genderWomen"/.test(groupMarkup));
  const rule = (sel) => { const i = CSS.indexOf(sel + " {"); return i === -1 ? "" : CSS.slice(i, CSS.indexOf("}", i)); };
  check("centred: the wrapper is a centring flex row",
    /display: flex; justify-content: center; align-items: center;/.test(rule(".gender-switch-wrapper")));
  const trackRule = rule(".gender-toggle.liquid-glass-track");
  check("the track is frosted glass with a specular rim, and pans vertically for page scroll",
    /backdrop-filter: blur\(20px\) saturate\(190%\)/.test(trackRule) && /border: 1px solid rgba\(255, 255, 255/.test(trackRule) && /touch-action: pan-y/.test(trackRule));
  const pillRule = rule(".liquid-glass-pill");
  check("the release snap plays on --spring, which is the tactile overshoot curve",
    /transition: transform \.55s var\(--spring\)/.test(pillRule) && /--spring: cubic-bezier\(\.34, 1\.56, \.64, 1\)/.test(CSS));
  check("...and is suspended while dragging, so the pill tracks the pointer without lag",
    /\.liquid-glass-track\.is-dragging \.liquid-glass-pill \{ transition: opacity/.test(CSS));
  check("the resting slot is CSS-owned per direction, so a language flip mirrors the pill",
    /\[dir="rtl"\] \.liquid-glass-track\[data-active="women"\] \.liquid-glass-pill \{ transform: translate3d\(-100%/.test(CSS));
  check("reduced motion drops the spring", /prefers-reduced-motion: reduce\) \{\s*\n\s*\.liquid-glass-pill, \.gender-option, \.gender-option__icon \{ transition: none; \}/.test(CSS));
  check("the old dark-pill rules are gone, not left fighting the new ones",
    !/\.gender-toggle__ind|\.gender-tab\.is-active \{ color: #fff; \}/.test(CSS + HTML));
  const initWiring = SRC.slice(SRC.indexOf("function setupGenderSwitch("));
  check("init wires the switch through setupGenderSwitch() - and nothing else adds a second click listener to it",
    /setupGenderSwitch\(\$\("genderToggle"\)\);/.test(SRC) &&
    !/genderToggle[^\n]*addEventListener\("click"/.test(SRC) &&
    (initWiring.match(/track\.addEventListener\("click"/g) || []).length === 1);
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
