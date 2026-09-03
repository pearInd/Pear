/* canonicalPhoto()/samePhoto() in widget/pear-widget.js - the WIDGET's half of the
   lockstep pair with canonicalImageUrl()/sameImage() in fitting-room/app.js (CLAUDE.md §3).

   url-identity.test.mjs already pins the app.js/server.js side against 18 fixture pairs.
   This suite had NO equivalent for the widget's own copy - meaning canonicalPhoto() could
   silently diverge from canonicalImageUrl() with nothing to catch it, which is exactly the
   failure mode §3 exists to prevent: "the widget's verdict is explicit, so it outranks the
   room's own classifier" applies just as much to "is this the same photo" as it does to
   garment category.

   THE BUG THIS CLOSES: canonicalPhoto() dropped the ENTIRE query string
   (`.split("?")[0]`) where canonicalImageUrl() only strips known PRESENTATION_PARAMS
   (width/height/v/quality/...), keeping everything else. A store serving distinct photos
   as `img.php?asset=front` / `img.php?asset=back` has its identity ENTIRELY in the query
   string - the widget collapsed both to the same bare path and treated a real back photo
   as a duplicate of the front, which fails toward the print-less-back bug (CLAUDE.md §2.1)
   even though it "fails safe" in the sense of never binding a front AS a back. */
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* RESIZER_RE through the end of samePhoto() - self-contained (regexes + pure string/URL
   functions), no DOM access needed to reach canonicalPhoto/samePhoto themselves. */
const wsrc = WIDGET.slice(WIDGET.indexOf("var RESIZER_RE"), WIDGET.indexOf("function abbrevUrl"));
const api = new Function("w", wsrc + "\nreturn { canonicalPhoto, samePhoto };")({});
const { sameImage: samePhoto, canonicalImageUrl: canonicalPhoto } = { sameImage: api.samePhoto, canonicalImageUrl: api.canonicalPhoto };

let fails = 0;
const t = (a, b, want, label) => {
  const got = samePhoto(a, b);
  if (got !== want) fails++;
  console.log(`${got === want ? "PASS" : "FAIL"}  ${label}`);
  if (got !== want) console.log(`        ${canonicalPhoto(a)}\n        ${canonicalPhoto(b)}`);
};

/* THE SAME 8 "same photo" FIXTURES url-identity.test.mjs runs against app.js/server.js,
   run here against the widget's copy - the direct lockstep check. */
const B = "https://cdn.shopify.com/s/files/1/0/tee";
console.log("── SAME photo, different spelling (must be true) - mirrors url-identity.test.mjs ──");
t(`${B}.jpg?width=1400`, `${B}.jpg?width=800`, true, "width param differs");
t(`${B}.jpg?v=1699&width=1400`, `${B}.jpg?v=1701`, true, "version + width differ");
t(`${B}_800x.jpg`, `${B}.jpg`, true, "shopify size suffix vs base");
t(`${B}_100x100_crop_center.jpg`, `${B}_grande.jpg`, true, "two different size suffixes");
t(`http://cdn.shopify.com/s/files/1/0/tee.jpg`, `${B}.jpg`, true, "http vs https");
t(`https://CDN.Shopify.com/s/files/1/0/tee.jpg`, `${B}.jpg`, true, "host case");
t(`${B}.jpg#zoom`, `${B}.jpg`, true, "hash fragment");
t("https://s.com/wp/uploads/tee-300x300.jpg", "https://s.com/wp/uploads/tee.jpg", true, "woo thumb suffix");

console.log("\n── GENUINELY different photos (must be false) - mirrors url-identity.test.mjs ──");
t(`${B}-1.jpg`, `${B}-2.jpg`, false, "different asset index");
t(`${B}_front.jpg`, `${B}_back.jpg`, false, "front vs back filename");
t(`${B}.jpg`, "https://cdn.shopify.com/s/files/1/0/hoodie.jpg", false, "different product");
t("https://a.com/tee.jpg", "https://b.com/tee.jpg", false, "different host");
t("https://s.com/img/poster-1920x1080.jpg", "https://s.com/img/poster.jpg", false, "full-res dims are part of the name");
t(`${B}.jpg`, "data:image/png;base64,AAAA", false, "generated rear vs real photo");
t("", `${B}.jpg`, false, "empty is never a match");

console.log("\n── image-resizer URLs (identity is the url= param, NOT the path) ──");
const N = "https://shop.example.com/_next/image?url=";
t(`${N}%2Fp%2Ftee.jpg&w=1920&q=75`, `${N}%2Fp%2Ftee.jpg&w=640&q=50`, true, "same asset, different w/q");
t(`${N}%2Fp%2Ftee.jpg&w=1920`, `${N}%2Fp%2Ftee-back.jpg&w=1920`, false,
  "DIFFERENT assets behind the same endpoint (the gallery-collapse bug)");
t(`${N}%2Fp%2Ftee.jpg&w=64`, "https://shop.example.com/p/tee.jpg", true, "resizer vs direct URL of the same asset");
t("https://s.com/cdn-cgi/image/width=80/p/tee.jpg", "https://s.com/cdn-cgi/image/width=80/p/tee.jpg", true,
  "path-encoded transform compares whole");

console.log("\n── THE REGRESSION: query-string-only identity, dropped whole by the OLD canonicalPhoto ──");
{
  /* This is the case the old `.split("?")[0]` could never pass: the ONLY thing that
     distinguishes these two photos is the query string, which used to be discarded
     entirely. A store like this would have every back photo read as a duplicate front. */
  t("https://s.com/img.php?asset=front", "https://s.com/img.php?asset=back", false,
    "query-string-only identity: a real front/back pair, not a duplicate");
  t("https://s.com/img.php?id=42&asset=front", "https://s.com/img.php?id=42&asset=front", true,
    "same query-string identity, byte-identical, is still recognised as the same photo");
  t("https://s.com/img.php?id=42&asset=front&width=800", "https://s.com/img.php?id=42&asset=front&width=1400", true,
    "a presentation param differing alongside a real identity param is still the same photo");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
