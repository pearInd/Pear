/* "Now fitting" chip thumbnail: it must show the COMBINED FRONT|BACK composite when
   one exists, fall back to the front photo when it does not, and pair each case with
   the right CSS class - a wide composite rendered in the default 60px square with
   object-fit:cover would be cropped down to a slice of the front panel. */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
  if (end === -1) throw new Error(`could not find end marker "${endMarker}"`);
  return SRC.slice(start, end);
}

const dom = new JSDOM(`<html><body>
  <div class="active-garment" id="activeGarment" hidden>
    <div class="active-garment__media" id="activeGarmentMedia"></div>
    <span class="active-garment__eyebrow"></span>
    <strong id="activeGarmentName"></strong>
    <span id="activeGarmentType"></span>
  </div>
  <span id="focusItemName"></span>
</body></html>`);
const { window } = dom;

const code = extract("/* The image the \"Now fitting\" chip should show", "/* =============================================================================\n   helpers");
const sandbox = {
  document: window.document, window,
  _garmentSVG: () => "<svg></svg>",
  SUBTYPE_LABEL_HE: {},
};
const api = new Function(...Object.keys(sandbox),
  code + "\nreturn { thumbSrcOf, thumbIsComposite, garmentThumb };")(...Object.values(sandbox));

const COMPOSITE = "data:image/jpeg;base64,/9j/COMPOSITE";
const FRONT = "https://cdn.shopify.com/s/files/tee-1.jpg";

console.log("── thumbnail source resolution ──");
check("composite handed over by the widget wins",
  api.thumbSrcOf({ composite: COMPOSITE, img: FRONT }) === COMPOSITE,
  api.thumbSrcOf({ composite: COMPOSITE, img: FRONT }));
check("locally-built composite used when there is no handover",
  api.thumbSrcOf({ _compositeObjectUrl: "blob:xyz", img: FRONT }) === "blob:xyz");
check("falls back to the front photo for a single-view garment",
  api.thumbSrcOf({ img: FRONT }) === FRONT);
check("empty when the item has no imagery at all", api.thumbSrcOf({}) === "");
check("null-safe", api.thumbSrcOf(null) === "");

console.log("\n── composite detection (drives the CSS class) ──");
check("true for a handed-over composite", api.thumbIsComposite({ composite: COMPOSITE }) === true);
check("true for a locally-built composite", api.thumbIsComposite({ _compositeObjectUrl: "blob:x" }) === true);
check("false for a front-only garment", api.thumbIsComposite({ img: FRONT }) === false);

console.log("\n── rendered markup ──");
const html = api.garmentThumb({ composite: COMPOSITE, img: FRONT, name: "Tee" });
check("img src is the composite, not the front photo",
  html.includes(`src="${COMPOSITE}"`) && !html.includes(FRONT), html);
check("front-only garment still renders its photo",
  api.garmentThumb({ img: FRONT, name: "Tee" }).includes(`src="${FRONT}"`));
check("no imagery falls back to the inline SVG placeholder",
  api.garmentThumb({ name: "Tee" }).includes("<svg>"));

console.log("\n── CSS contract for the wide composite thumbnail ──");
const rule = CSS.slice(CSS.indexOf(".active-garment.is-composite"), CSS.indexOf("/* Full-look duo chip */"));
check("is-composite widens the media box (fallback width, pre-aspect-ratio browsers)",
  /\.active-garment\.is-composite \.active-garment__media \{[^}]*width:/.test(CSS), rule.slice(0, 80));
check("aspect-ratio drives the wide layout in modern browsers",
  /\.active-garment\.is-composite \.active-garment__media \{[^}]*aspect-ratio:\s*2\s*\/\s*1/.test(CSS));
check("image switches to object-fit: contain (both panels visible)",
  /\.active-garment\.is-composite[^{]*img \{[^}]*object-fit:\s*contain/.test(CSS));
check("object-position overridden from the default `center top`",
  /\.active-garment\.is-composite[^{]*img \{[^}]*object-position:\s*center/.test(CSS));
check("background is a flat light color (design token), not a translucent overlay",
  /\.active-garment\.is-composite \.active-garment__media \{[^}]*background:\s*var\(--bg\)/.test(CSS));
check("default (non-composite) thumbnails still use cover",
  /\.active-garment__media img[^{]*\{[^}]*object-fit:\s*cover/.test(CSS.replace(/\.active-garment\.is-composite[\s\S]*?\}/g, "")));
check("a narrow-screen size is defined", /max-width:\s*380px/.test(CSS) && /is-composite/.test(rule));

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
