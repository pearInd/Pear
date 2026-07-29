/* Extracts canonicalImageUrl/sameImage from server.js and tests the pairs that
   caused the front image to be bound as the back reference. */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = src.indexOf("/* Resizer endpoints keep the REAL asset");
const end = src.indexOf("function resolveGarmentViews");
const mod = await import("data:text/javascript," + encodeURIComponent(
  "const PRESENTATION_PARAMS = new Set(['width','height','w','h','size','quality','q','dpr','format','fm','crop','fit','scale','v','ver','version','t','cache','_']);\n" +
  src.slice(start, end) + "\nexport { canonicalImageUrl, sameImage };"
));
const { sameImage, canonicalImageUrl } = mod;

let fails = 0;
const t = (a, b, want, label) => {
  const got = sameImage(a, b);
  if (got !== want) fails++;
  console.log(`${got === want ? "PASS" : "FAIL"}  ${label}`);
  if (got !== want) console.log(`        ${canonicalImageUrl(a)}\n        ${canonicalImageUrl(b)}`);
};

const B = "https://cdn.shopify.com/s/files/1/0/tee";
console.log("── SAME photo, different spelling (must be true) ──");
t(`${B}.jpg?width=1400`, `${B}.jpg?width=800`, true, "width param differs");
t(`${B}.jpg?v=1699&width=1400`, `${B}.jpg?v=1701`, true, "version + width differ");
t(`${B}_800x.jpg`, `${B}.jpg`, true, "shopify size suffix vs base");
t(`${B}_100x100_crop_center.jpg`, `${B}_grande.jpg`, true, "two different size suffixes");
t(`http://cdn.shopify.com/s/files/1/0/tee.jpg`, `${B}.jpg`, true, "http vs https");
t(`https://CDN.Shopify.com/s/files/1/0/tee.jpg`, `${B}.jpg`, true, "host case");
t(`${B}.jpg#zoom`, `${B}.jpg`, true, "hash fragment");
t("https://s.com/wp/uploads/tee-300x300.jpg", "https://s.com/wp/uploads/tee.jpg", true, "woo thumb suffix");

console.log("\n── GENUINELY different photos (must be false) ──");
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

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
