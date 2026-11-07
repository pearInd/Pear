#!/usr/bin/env node
/* Try the garment kinds on yourself (CLAUDE.md §7.23) - prints links that open THIS branch's fitting room (its Vercel preview)
   in TEST mode, so a skirt gets the skirt's wording and a dress its dress wording and whole photos, on your own camera.

   usage:
     node scripts/try-on.mjs                         the preset links (a skirt, a dress, the PEAK tee to compare)
     node scripts/try-on.mjs <front> <back> <title>  a link for any product: its front photo URL, back photo URL, title
     node scripts/try-on.mjs --demo ...              adds pear_demo=1: no sign-in, but ONE measurement per browser
     node scripts/try-on.mjs --base=<origin> ...     another deployment (default: this branch's preview)
     node scripts/try-on.mjs --bookmarklet           a bookmarklet that adds the try-on button to any product page

   Every go-live is a billed render session on your account. The camera must see you head to feet - a maxi dress or skirt is
   drawn down to the ankles. The room's title decides the kind (garmentKindOf): "skirt"/"חצאית" and "dress"/"שמלה" in it. */
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const BASE = ((flag("base") || "").split("=")[1] || "https://pear-git-feat-garment-kinds-pear2.vercel.app").replace(/\/+$/, "");
const DEMO = !!flag("demo");
const rest = args.filter((a) => !a.startsWith("--"));

const PRESETS = [
  { label: "Skirt - FOX black knit maxi skirt", title: "חצאית מקסי סריג", page: "https://fox.co.il/products/2501940200",
    front: "https://fox.co.il/cdn/shop/files/2501940200-1.jpg?v=1&width=1000", back: "https://fox.co.il/cdn/shop/files/2501940200-4.jpg?v=1&width=1000" },
  { label: "Dress - baby-blue strapless A-line maxi", title: "So Far So Good Maxi Dress Baby Blue", page: "https://us.princesspolly.com/products/so-far-so-good-maxi-dress-baby-blue",
    front: "https://cdn.shopify.com/s/files/1/0061/8627/0804/files/1-modelinfo-selina-us2_84402d8a-6172-4491-b09f-d724dc0e600e.jpg?width=1000",
    back: "https://cdn.shopify.com/s/files/1/0061/8627/0804/files/4-modelinfo-selina-us2_0cc6a8f1-c9ab-4cc9-85dd-2a3a0ac5c2eb.jpg?width=1000" },
  { label: "Compare - the PEAK tee (no kind: today's wording)", title: "חולצת טי PEAK אוברסייז", page: "https://fox.co.il/products/1824346900",
    front: "https://fox.co.il/cdn/shop/files/1824346900-1.jpg?v=1&width=1000", back: "https://fox.co.il/cdn/shop/files/1824346900-3.jpg?v=1&width=1000" },
];

function roomLink({ front, back, title }) {
  const q = new URLSearchParams({ garment_url: front, garment_url_back: back, garment_name: title, pear_key: "TEST" });
  if (DEMO) q.set("pear_demo", "1");
  return `${BASE}/fitting-room/?${q}`;
}

if (flag("bookmarklet")) {
  const code = `(()=>{const s=document.createElement('script');s.src='${BASE}/widget/pear-widget.js';s.setAttribute('data-pear-key','TEST');` +
    `${DEMO ? "s.setAttribute('data-pear-demo','true');" : ""}document.body.appendChild(s);})();`;
  console.log("Bookmarklet (save as a bookmark's URL, then click it on a product page):\n");
  console.log("javascript:" + code);
  process.exit(0);
}
if (rest.length) {
  if (rest.length < 3) { console.error("need: <front photo URL> <back photo URL> <title>"); process.exit(2); }
  console.log(roomLink({ front: rest[0], back: rest[1], title: rest.slice(2).join(" ") }));
  process.exit(0);
}
/* THE STORE PAGE IS THE REAL PATH (2026-11-07): a direct room link skips the widget, so the classifier's facts (colour, print
   text, plain back) never reach the room and a TEST prompt goes without "Fabric: ...". On the store page, the bookmarklet loads
   this deployment's widget, which classifies the photos and sends those facts - the flow a shopper gets. */
console.log(`Fitting room: ${BASE} (TEST mode${DEMO ? ", demo - one measurement per browser" : ""})`);
console.log(`Best: open the store page, click the bookmarklet (node scripts/try-on.mjs --bookmarklet), then the try-on button.\n`);
for (const p of PRESETS) console.log(`${p.label}\n  store page:  ${p.page}\n  direct link (no colour/print facts): ${roomLink(p)}\n`);
