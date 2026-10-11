/* ── THE PLAIN-BACK ANCHOR - "it drew scrambled black graphics on my back" ──────────
   REPORTED against a white tee: front carries "BE YOUR OWN Healer WORLDWIDE", the rear
   reference is 100% blank white fabric, and turning around produced scrambled black
   graphics across the shopper's back.

   THE REFERENCE WAS CORRECT. THE PROMPT ASKED FOR IT. BACK_CATEGORY_ANCHOR ships
   "Precisely lock the rear print, logos, and back seams" on EVERY back render, and on a
   blank rear that asserts a print and logos which do not exist. Decart's set() takes no
   negative_prompt, so "print" and "logos" reach the sampler as POSITIVE tokens to steer
   toward - the prompt instructs the model to invent rear graphics and it obliges. No
   amount of reference fidelity overrides a direct instruction.

   THE FIX IS THE SHAPE PLAIN_TEE_ANCHOR ALREADY PROVED ON THE FRONT: describe the
   plainness POSITIVELY and SELECT the anchor on positive evidence, rather than negating
   the graphic nouns. This suite pins both halves - the wording, and the abstention. */
import { readFileSync } from "node:fs";

/* The prompt engine moved server-side on 2026-09-26 (lib/prompts.js, CLAUDE.md §2.13). This
   reads it FIRST and app.js after it: the engine slices/checks find it where it lives now,
   and every app.js marker used here exists only in the app.js half. */
const APP = (readFileSync(new URL("../lib/prompts.js", import.meta.url), "utf8") + "\n" +
  readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}
/* Index-scanned rather than regex-matched. The sibling suites use a
   `^const NAME\s*=([\s\S]*?);\s*$` pattern, which is fragile for these two constants:
   they are multi-line Object.freeze({...}) literals, so the terminator is `});` on its
   own line and a non-greedy match has to cross ~1.2k characters of string concatenation
   and comment prose to reach it. Scanning for the declaration and then for the closing
   `\n});` is exact and cannot half-match. */
function constBlock(name) {
  const decl = `\nconst ${name} = Object.freeze({`;
  const i = APP.indexOf(decl);
  if (i === -1) throw new Error(`const ${name} not found in app.js (as an Object.freeze literal)`);
  const start = i + 1;
  const end = APP.indexOf("\n});", start);
  if (end === -1) throw new Error(`const ${name} is unterminated`);
  const block = APP.slice(start, end + "\n});".length);
  return block.slice(block.indexOf("=") + 1).replace(/;\s*$/, "");
}
const evalConst = (n) => new Function(`"use strict"; return (${constBlock(n)});`)();

const PLAIN = evalConst("PLAIN_BACK_ANCHOR");
const PRINTED = evalConst("BACK_CATEGORY_ANCHOR");

console.log("── §1 THE PLAIN VARIANT NAMES NO GRAPHIC NOUNS AT ALL ──");
{
  /* THE LOAD-BEARING ASSERTION OF THIS SUITE. The patch specified when this was reported
     was "the rear fabric is 100% PLAIN WHITE with ZERO text, zero logos, and zero black
     chest graphics; strictly forbid carrying over front chest text". Every one of those
     phrases puts a graphic noun on the wire - text, logos, graphics, chest text - and
     with no negative_prompt to attach them to, that wording is a RICHER instruction to
     draw graphics than the sentence it replaces. It would have made the report worse.
     "Smooth unbroken fabric" cannot be sampled into a logo. */
  for (const [region, s] of Object.entries(PLAIN)) {
    check(`${region}: no print/logo/graphic/text noun appears`,
      !/\b(print|logo|logos|graphic|graphics|lettering|text)\b/i.test(s), s);
    check(`${region}: describes the plainness POSITIVELY`,
      /smooth unbroken fabric/i.test(s), s);
    /* A negation is the tuxedo mechanism. "zero", "no", "without", "forbid" in front of a
       garment feature is the exact shape this file keeps re-learning not to ship. */
    check(`${region}: states no prohibition`,
      !/\b(zero|forbid|forbidden|must not|do not|never)\b/i.test(s), s);
  }
}

console.log("\n── §1b THE PRINTED-REAR ANCHOR NAMES NO GRAPHIC NOUNS EITHER ──");
{
  /* §1 guarded ONLY the plain variant, and that asymmetry is exactly how the printed one
     kept a sentence that did the same damage. BACK_CATEGORY_ANCHOR read "Precisely lock
     the rear print, logos, and back seams", and once the classifier fix routed real rear
     photos onto it, a turn rendered "PEAK PEAK", blank white boxes and generic lines -
     one hallucination per noun. A garment WITH rear artwork is not exempt from the
     positive-token mechanism; it is the case where the model has the most to invent.
     So the same absence is now asserted on both anchors. */
  for (const [region, s] of Object.entries(PRINTED)) {
    check(`${region}: printed-rear anchor names no print/logo/seam/graphic noun`,
      !/\b(print|prints|logo|logos|seam|seams|graphic|graphics|lettering|typography)\b/i.test(s), s);
    check(`${region}: printed-rear anchor grounds on the reference instead`,
      /exactly as shown in the reference/i.test(s), s);
  }
}

console.log("\n── §2 IT SHRINKS THE WIRE, like every fidelity fix in this file ──");
{
  /* plain-tee-fidelity §7.3's rule, applied here: a fidelity fix that ADDS text is the
     text-volume mechanism reapplied. The plain variant replaces a 52-char clause with a
     41-char one, so it is strictly cheaper than the branch it stands in for. */
  for (const region of Object.keys(PLAIN)) {
    check(`${region}: shorter than the printed-rear anchor (${PLAIN[region].length} < ${PRINTED[region].length})`,
      PLAIN[region].length < PRINTED[region].length,
      `plain=${PLAIN[region].length} printed=${PRINTED[region].length}`);
  }
}

console.log("\n── §3 OTHERWISE BYTE-IDENTICAL - one clause swapped, nothing else ──");
{
  /* If the two anchors drift apart anywhere BUT the rear-print clause, a back render
     silently changes behaviour on an axis nobody reviewed. Normalising the one known
     difference must make them equal. */
  for (const region of Object.keys(PLAIN)) {
    const a = PRINTED[region].replace("Reproduce the rear panel exactly as shown in the reference.", "§");
    const b = PLAIN[region].replace("The rear panel is smooth unbroken fabric.", "§");
    check(`${region}: identical apart from the swapped clause`, a === b,
      `printed=${a}\n        plain=${b}`);
  }
}

console.log("\n── §4 SELECTED ON POSITIVE EVIDENCE ONLY (the §2.1 discipline) ──");
{
  const resolver = (() => {
    const i = APP.indexOf("function imageOnlyPrompt");
    return APP.slice(i, APP.indexOf("\n}", i));
  })();
  /* `=== true`, not a truthy test. undefined means nobody looked (an older widget, a
     rate-limited classify, a pre-v12 cache row) and false means the garment has a REAL
     rear print. Both must keep BACK_CATEGORY_ANCHOR: guessing "plain" on a printed back
     would suppress the one graphic the shopper turned around to see - the print-less-back
     bug, inverted. */
  check("the plain anchor requires backIsPlain === true, never a truthy value",
    /item\.backIsPlain === true/.test(resolver) &&
    !/item\.backIsPlain\s*\)/.test(resolver) &&
    !/!!item\.backIsPlain/.test(resolver),
    resolver);
  /* RESTATED when the pixels gained a veto (§6): still scoped to the BACK angle, still `=== true`
     on the verdict. The added term can only ever REFUSE a plain claim, never assert one, and it is
     itself `!== true` so an unprobed rear behaves exactly as before. */
  check("...and it is scoped to the BACK angle, where a rear anchor is what ships",
    /const plainBack = angle === "back" && item && item\.backIsPlain === true && item\._backLooksPrinted !== true;/.test(resolver),
    resolver);
  /* Still a SELECTOR. Concatenating the plain clause onto the printed anchor would put
     both wordings on the wire - the print nouns included - which is the bug plus a patch. */
  check("...and it SELECTS a frozen anchor rather than being appended",
    !/PLAIN_BACK_ANCHOR\s*\+/.test(APP) && !/\+\s*PLAIN_BACK_ANCHOR/.test(APP) &&
    /const PLAIN_BACK_ANCHOR = Object\.freeze\(\{/.test(APP) &&
    !/PLAIN_BACK_ANCHOR = Object\.freeze\(\{[\s\S]{0,1200}?\$\{/.test(APP),
    "a template hole or a concatenation re-opens what the selector prevents");
}

console.log("\n── §6 THE PIXELS VETO A WRONG 'PLAIN' VERDICT - the probe, executed on real pixel arrays ──");
{
  /* REPORTED three times, latest 2026-09-16: the rear graphic renders for a beat and then the
     shirt goes plain. PLAIN_BACK_ANCHOR is the only thing that can assert "smooth unbroken
     fabric", and it fires on a SERVER verdict about the rear photo. The direction asked for was
     "if a dedicated back image exists, force backIsPlain = false" - which cannot ship, because a
     genuinely blank rear photo IS a dedicated back image and that is precisely the case the
     anchor exists for. So the pixels get a veto instead: measured, one-sided, and only ever able
     to REFUSE a plain claim. This section runs the real energy function over arrays it builds. */
  const src = (() => {
    const i = APP.indexOf("function bitmapBoxEnergy(bitmap, x0, y0, x1, y1) {");
    return i === -1 ? "" : APP.slice(i, APP.indexOf("\n}", i) + 2);
  })();
  check("bitmapBoxEnergy() exists as a pure, synchronous measurement", src.length > 0);

  /* A fake bitmap whose two boxes carry DIFFERENT content, because the ratio between them is what
     the code computes - fabric texture, lighting and codec noise cancel in it, and only a ratio
     can be compared against a fixed bar across garments. The fake context remembers which source
     rect was asked for, so the real box-mapping arithmetic is exercised rather than stubbed. */
  const makeBitmapCtx = (patternFor) => {
    let current = null;
    return {
      drawImage(_bm, sx, sy) { current = patternFor(sx, sy); },
      getImageData(_x, _y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const v = current(x, y, w, h);
            const p = (y * w + x) * 4;
            data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255;
          }
        }
        return { data };
      },
    };
  };
  /* Fabric: a smooth shading gradient plus ±1 of codec noise. Graphic: lettering-shaped structure -
     repeated hard edges, which is what a Laplacian sees in a real print (a single large rectangle
     has almost none, which is why the bar is a ratio and not an absolute). */
  const fabric = (x, y) => 90 + Math.round(6 * (y / 96)) + ((x + y) % 2);
  const graphic = (x, y, w, h) =>
    (x > w * 0.1 && x < w * 0.9 && y > h * 0.15 && y < h * 0.85)
      ? (Math.floor(y / 6) % 2 ? 235 : 60)
      : 90;
  const W = 1000, HH = 1500;
  const runPair = (rearIsPrinted) => {
    const ctx = makeBitmapCtx((sx, sy) => {
      /* The graphic box starts at 0.34*W, 0.42*H; the fabric box at 0.26*W, 0.40*H. */
      const isGraphicBox = sx >= 0.30 * W && sy >= 0.41 * HH;
      return isGraphicBox && rearIsPrinted ? graphic : fabric;
    });
    const fn = new Function("OffscreenCanvas", "document", src + "\nreturn bitmapBoxEnergy;")(
      undefined, { createElement: () => ({ getContext: () => ctx }) });
    const bm = { width: W, height: HH };
    const g = fn(bm, 0.34, 0.42, 0.66, 0.68);
    const f = fn(bm, 0.26, 0.40, 0.33, 0.46);
    return { g, f, ratio: g / Math.max(f, 0.01) };
  };
  const printedRear = runPair(true), blankRear = runPair(false);
  console.log(`        printed rear: graphic ${printedRear.g.toFixed(2)} / fabric ${printedRear.f.toFixed(2)} = ${printedRear.ratio.toFixed(2)}x` +
    ` | blank rear: ${blankRear.g.toFixed(2)} / ${blankRear.f.toFixed(2)} = ${blankRear.ratio.toFixed(2)}x`);
  check("a blank rear measures ~1x its own plain fabric - the two boxes are the same cloth",
    blankRear.ratio < 2.5, `${blankRear.ratio}x`);
  check("...and a rear carrying a graphic measures far above the bar",
    printedRear.ratio >= 2.5 && printedRear.ratio > blankRear.ratio * 2,
    `${printedRear.ratio}x vs ${blankRear.ratio}x - the real garment measured 6.59x`);

  /* THE BAR, and the real numbers it was set from. The garment this was reported against
     (fox.co.il 1824346900): printed rear 12.44 against 1.89 on its own shoulder = 6.59x; its three
     FRONT photos, whose chest text is small, 1.35-3.05x. A blank rear is the same fabric as the
     reference box, so ~1x by construction. */
  check("BACK_PRINT_ENERGY_RATIO sits between flat fabric and a measured rear print",
    /const BACK_PRINT_ENERGY_RATIO = 2\.5;/.test(APP),
    "2.5: under the 6.59x measured on the reported garment, over flat fabric plus noise");
  check("the probe is memoised per Blob, like the flat probe beside it",
    /const _rearPrintVerdicts = new WeakMap\(\);/.test(APP) &&
    /_rearPrintVerdicts\.set\(blob, printed\)/.test(APP),
    "the selector runs on every dispatch and can never decode anything itself");
  check("...and every failure path returns 'not proven printed', so a probe error changes nothing",
    /printed = false;[\s\S]{0,200}?\}\s*\n\s*try \{ bitmap && bitmap\.close/.test(APP),
    "fail-open in the direction that preserves the existing behaviour");
  check("it is settled at pre-load, where the rear is already decoded for the flat probe",
    /item\._backLooksPrinted = await blobLooksPrinted\(backBlob\);/.test(APP));
  check("...and a contradiction between the verdict and the pixels is logged, not silently swallowed",
    /rear-print probe CONTRADICTS the classifier/.test(APP),
    "a classifier that calls a printed back plain is a server-side defect and must be findable");
}

console.log("\n── §5 THE VERDICT IS TRACEABLE - it is the only thing that changes what a BACK dispatch asserts ──");
{
  /* REPORTED 2026-09-16: "the back print rendered for a split second then vanished into a plain
     brown shirt", filed as the prompt builder dropping a descriptor mid-turn. It cannot: the angle
     SELECTS one frozen anchor, and the back string is 521/650 with every size rung fitting, so it
     sheds nothing. This verdict is the one mechanism that CAN change it - and it arrives from the
     widget's post-open correction, which lands after go-live. It was never logged anywhere, so the
     report could only be answered from pixels. These pin the trace, not the behaviour. */
  const fn = (() => {
    const i = APP.indexOf("function describeRearConstruction(item) {");
    return i === -1 ? "" : APP.slice(i, APP.indexOf("\n}", i));
  })();
  check("describeRearConstruction() reports the verdict in words, including 'nobody looked'",
    /item\.backIsPlain === true/.test(fn) && /item\.backIsPlain === false/.test(fn) &&
    /not established/.test(fn) && /smooth unbroken fabric/.test(fn),
    "undefined and false are different facts and must read differently");
  check("...and it says out loud what a wrong 'plain' verdict costs",
    /suppresses it/.test(fn), "the next reader must not have to infer the consequence");
  /* The sentence the verdict selects is built server-side since 2026-09-26
     (describeRearConstruction() in lib/prompts.js), so both log sites now print the raw flags
     that select it. The lock log is typeof-guarded on activeItem because the orientation
     watcher runs standalone in side-profile.test.mjs (CLAUDE.md 2.7). */
  check("the verdict is logged where it LANDS - the widget's post-open correction",
    /PEAR_UPDATE_GARMENT applied[\s\S]{0,700}?"\| rear: backIsPlain=" \+ activeItem\.backIsPlain \+ " looksPrinted=" \+ activeItem\._backLooksPrinted/.test(APP),
    "it can arrive mid-session; a silent change to what the wire asserts is what made this unanswerable");
  check("...and where the BACK lock is reported, but only on that lock",
    /autoOrientation === "back" && typeof activeItem !== "undefined" && activeItem\s*\n?\s*\? ` \| rear: backIsPlain=/.test(APP),
    "logVtonState fires on lock changes, not on the ~625ms re-anchor cadence - this must not spam");
  /* The trace must stay a trace: the builders are what trace:prompt executes, and a console
     line inside one of them would pollute that output as well as every dispatch. */
  const resolverSrc = (() => {
    const i = APP.indexOf("function imageOnlyPrompt");
    return APP.slice(i, APP.indexOf("\n}", i));
  })();
  check("...and nothing was added to the prompt builder itself",
    !/console\./.test(resolverSrc) && !/describeRearConstruction/.test(resolverSrc),
    "imageOnlyPrompt is executed by trace:prompt and on every dispatch - it stays silent");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
