/* Body-adaptive prompt anchor - deriveBuild() + getAnatomicalAnchor() (fitting-room/app.js).
   The anchor is the EARLY, high-leverage position in every Decart Lucy prompt (see the
   ordering note in buildCompositePrompt), and it is where a heavier shopper's body mass
   is either stated or silently lost. These tests pin the contract that raw cm/kg is
   always converted into a build the text encoder can act on, that the wording stays
   physical rather than clinical, and that garbage input degrades to the raw numbers
   instead of a confidently wrong verdict. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(name, endMarker) {
  const start = SRC.indexOf(name);
  if (start === -1) throw new Error(`could not find "${name}" in app.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${name}"`);
  return SRC.slice(start, end);
}
const code = extract("const BUILD_BANDS", "/**\n * Return the signed delta");

// The form inputs the anchor reads. Setting a field to null models "left blank".
let form = {};
const sandbox = {
  console, Math, Number, isFinite,
  $: (id) => (form[id] == null ? null : { value: String(form[id]) }),
};
const fn = new Function(...Object.keys(sandbox),
  code + "\nreturn { deriveBuild, getAnatomicalAnchor, BUILD_BANDS, WHTR_CENTRAL, " +
  "BUILD_H_MIN, BUILD_H_MAX, BUILD_W_MIN, BUILD_W_MAX };");
const M = fn(...Object.values(sandbox));

const anchorFor = (f) => { form = f; return M.getAnatomicalAnchor(); };

/* ── 1. Band selection across the BMI range ──────────────────────────────────── */
const bmiCase = (h, w) => M.deriveBuild(h, w);
check("BMI 17.3 → leanest band", bmiCase(180, 56) === M.BUILD_BANDS[0], `bmi=${56 / 1.8 ** 2}`);
check("BMI 22.5 → average band", bmiCase(180, 73) === M.BUILD_BANDS[1]);
check("BMI 27.8 → full build band", bmiCase(180, 90) === M.BUILD_BANDS[2]);
check("BMI 33.6 → heavy-set band", bmiCase(180, 109) === M.BUILD_BANDS[3]);
check("BMI 46.3 → largest band", bmiCase(180, 150) === M.BUILD_BANDS[4]);
check("every band is reachable and distinct",
  new Set(M.BUILD_BANDS.map((b) => b.build)).size === M.BUILD_BANDS.length);
check("every band carries BOTH a build and a drape consequence",
  M.BUILD_BANDS.every((b) => b.build && b.drape && b.drape.length > 20));

/* Boundaries are exclusive-upper (bmi < maxBmi), so a shopper exactly on a cut line
   must land in the LIGHTER band - never silently promoted a category. */
check("BMI exactly 25.0 lands in the band above average, not average",
  bmiCase(200, 100) === M.BUILD_BANDS[2], "bmi=25 → must not stay in the <25 band");

/* ── 2. Invalid / missing input degrades gracefully ─────────────────────────── */
check("missing weight → no build derived", M.deriveBuild(180, null) === null);
check("missing height → no build derived", M.deriveBuild(null, 90) === null);
check("height typed in metres (1.8) → rejected, not a BMI of 27777",
  M.deriveBuild(1.8, 90) === null);
check("weight typed in pounds (240) → rejected as out of range",
  M.deriveBuild(180, 240) === null);
check("height above BUILD_H_MAX → rejected", M.deriveBuild(M.BUILD_H_MAX + 1, 90) === null);
check("zero height → rejected, no division blow-up", M.deriveBuild(0, 90) === null);

/* ── 3. The anchor sentence ─────────────────────────────────────────────────── */
const heavy = anchorFor({ height: 175, weight: 115 });
check("heavy shopper: exact numbers still present", /175cm/.test(heavy) && /115kg/.test(heavy), heavy);
check("heavy shopper: build is stated in WORDS, not left as arithmetic",
  /heavy-set|broad build|large, heavy/.test(heavy), heavy);
check("heavy shopper: fabric consequence is stated (tension / wrinkles / stretch)",
  /stress wrinkles|tension|stretch|taut/.test(heavy), heavy);
check("heavy shopper: anchor carries its own anti-slimming pin",
  /no slimming, narrowing or idealising/.test(heavy), heavy);

const average = anchorFor({ height: 178, weight: 72 });
check("average shopper: average band wording", /average, proportionate/.test(average), average);
check("average shopper: still gets the anti-slimming pin",
  /no slimming, narrowing or idealising/.test(average));

/* The clinical-vocabulary guard. This is a real output-quality constraint, not a style
   preference: these words are bound in training data to caricature and stock "before"
   imagery, so they degrade the render for exactly the shoppers this band exists for. */
const BANNED = /\b(obese|obesity|overweight|fat|morbid|chubby|flab|unhealthy|plus-size)\b/i;
check("no clinical or pejorative body vocabulary in any band",
  !M.BUILD_BANDS.some((b) => BANNED.test(b.build) || BANNED.test(b.drape)),
  M.BUILD_BANDS.map((b) => b.build).join(" | "));
check("no clinical or pejorative vocabulary in a rendered heavy anchor", !BANNED.test(heavy), heavy);

/* ── 4. Waist-to-height midsection clause ───────────────────────────────────── */
const central = anchorFor({ height: 170, weight: 110, waist: 110 });   // WHtR 0.65
check("high waist-to-height → midsection clause present",
  /hem and waistband sit where they truly fall/.test(central), central);
check("...and it adds the hem/waistband behaviour the band does not cover",
  /front hem rides higher than the back/.test(central) && /never a flat straight line/.test(central));

/* The clause must EARN its tokens. The heaviest band already describes the abdomen's
   outward curve, so the midsection clause repeating that phrase would be pure budget
   waste in a prompt regenerated every frame - guard against a future edit reintroducing it. */
const heavyBandDrape = M.BUILD_BANDS[4].drape;
const midsectionClause = central.slice(central.indexOf("The hem and waistband"));
check("the split actually isolated the midsection clause (guards a vacuous assertion)",
  central.includes("The hem and waistband") && midsectionClause.length > 80, midsectionClause);
check("midsection clause does not restate the band's own outward-curve wording",
  /outward curve/.test(heavyBandDrape) && !/outward curve/.test(midsectionClause), midsectionClause);

const slimWaist = anchorFor({ height: 180, weight: 75, waist: 82 });   // WHtR 0.46
check("normal waist-to-height → no midsection clause (prompt not diluted)",
  !/hem and waistband sit where/.test(slimWaist), slimWaist);
check("waist is still reported as an exact measurement either way",
  /waist 82cm/.test(slimWaist), slimWaist);

// WHtR needs a trustworthy height; a metres-typo must not fabricate a ratio of 47.
const badHeight = anchorFor({ height: 1.75, waist: 82, weight: 90 });
check("metres-typo height → no midsection clause fabricated from a bogus ratio",
  !/hem and waistband sit where/.test(badHeight), badHeight);
check("metres-typo height → no build band either", !/heavy-set|average, proportionate/.test(badHeight), badHeight);

/* ── 5. Optional measurements and the no-data path ──────────────────────────── */
const full = anchorFor({ height: 182, weight: 95, chest: 108, waist: 96, legs: 84 });
check("all optional measurements are listed",
  /chest 108cm/.test(full) && /waist 96cm/.test(full) && /inseam 84cm/.test(full), full);

const none = anchorFor({});
check("no measurements → defers to the live camera frame as the size evidence",
  /live camera frame/.test(none), none);
check("no measurements → explicitly size-agnostic rather than silent about volume",
  /whatever size and shape/.test(none), none);
check("no measurements → no fabricated build band",
  !/heavy-set|average, proportionate|lean, light/.test(none), none);

const weightOnly = anchorFor({ weight: 88 });
check("weight without height → reports the weight, derives no build",
  /88kg/.test(weightOnly) && !/heavy-set|average, proportionate/.test(weightOnly), weightOnly);

/* ── 6. Prompt-budget sanity ────────────────────────────────────────────────── */
/* The anchor is one fragment of a ~2,200-char realtime prompt that is regenerated every
   frame; an anchor that balloons would push the panel contract out of its tuned lead
   position. Cap the TRUE worst case - every optional field filled, heaviest band, and
   the midsection clause active - so a future band edit cannot silently blow the budget. */
const worstCase = anchorFor({ height: 170, weight: 145, chest: 130, waist: 125, legs: 78 });
check("worst case really is the heaviest band with every clause active",
  /large, heavy build/.test(worstCase) && /hem and waistband sit where/.test(worstCase) &&
  /chest 130cm/.test(worstCase) && /inseam 78cm/.test(worstCase), worstCase);
check("worst-case anchor stays under 800 chars", worstCase.length < 800, `len=${worstCase.length}`);
check("anchor is a single normalised line (no stray newlines/tabs)", !/[\n\t]/.test(worstCase));

console.log("\n" + (fails ? `${fails} check(s) FAILED` : "All body-anchor checks passed."));
process.exit(fails ? 1 : 0);
