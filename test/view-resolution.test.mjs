/* Tests resolveGarmentViews() from server.js - the function that decides which photo
   is the front, which is the back, and where the back came from. */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = src.indexOf("/* Resizer endpoints keep the REAL asset");
const end = src.indexOf("/* POST /api/classify-images");
const mod = await import("data:text/javascript," + encodeURIComponent(
  "const PRESENTATION_PARAMS = new Set(['width','height','w','h','size','quality','q','dpr','format','fm','crop','fit','scale','v','ver','version','t','cache','_']);\n" +
  src.slice(start, end) + "\nexport { resolveGarmentViews };"
));
const { resolveGarmentViews } = mod;

let fails = 0;
function eq(got, want, label) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}
const rec = (...views) => views.map((v) => ({ view: v }));
const F = "https://cdn.shopify.com/s/files/tee-1.jpg";
const BK = "https://cdn.shopify.com/s/files/tee-2_back.jpg";

eq(resolveGarmentViews({ images: [F, BK], records: rec("front", "back"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: BK, back_source: "classifier" }, "classifier finds the back");

eq(resolveGarmentViews({ images: [F, BK], records: rec("front", "front"), scrapedFront: F, scrapedBack: BK }),
   { front: F, back: BK, back_source: "dom" }, "DOM hint outranks the classifier");

eq(resolveGarmentViews({ images: [F], records: rec("front"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: "", back_source: "none" }, "single-view product -> no back, ready to synthesize");

eq(resolveGarmentViews({ images: [F, F + "?width=800"], records: rec("front", "back"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: "", back_source: "none" },
   "REGRESSION: a 'back' that is the front under another spelling is rejected");

eq(resolveGarmentViews({ images: [F], records: rec("front"), scrapedFront: F, scrapedBack: F + "?v=99" }),
   { front: F, back: "", back_source: "none" },
   "REGRESSION: a DOM hint equal to the front is rejected, not trusted");

eq(resolveGarmentViews({ images: [F, BK], records: rec("uncertain", "uncertain"), scrapedFront: F, scrapedBack: "" }),
   { front: F, back: "", back_source: "none" },
   "all-uncertain never fabricates a back from position");

eq(resolveGarmentViews({ images: [BK, F], records: rec("back", "front"), scrapedFront: BK, scrapedBack: "" }),
   { front: F, back: BK, back_source: "classifier" },
   "DOM order ignored: classifier's front wins even when it is second");

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
