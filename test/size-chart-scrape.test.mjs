/* THE SIZE-CHART SCRAPE, RUN FOR REAL - widget/pear-widget.js in jsdom against
   storefront markup, no reimplementation.
   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS FILE EXISTS SEPARATELY FROM size-chart-overlay.test.mjs. That suite proves
   what the room is ALLOWED to do with a chart once it has one (the kernel stays ours,
   every refusal lands on the default matrix). This one proves the widget can actually
   read a chart off a real page, and - far more important - that it stays SILENT on the
   pages that do not have one.

   THE DIRECTION THAT MATTERS. A missing chart costs nothing: the room uses its own
   vetted matrix, which is byte-for-byte the behaviour that shipped before this feature.
   A WRONG chart is the expensive failure - it re-bands a shopper against numbers that
   came out of a price column, a colour swatch table, or a centimetre chart read as
   inches. So the silent cases below (§5) are not filler: they are the tests this
   feature exists to keep passing, and every one of them is a table that a naive "find
   a <table>, read some numbers" scraper would happily have swallowed.

   Run in jsdom against the DOM rather than by regex over the source for the same reason
   stock-dom-scrape.test.mjs is: the DOM tier's bugs live in things that read perfectly
   on the page - an attribute accessor that returns "" instead of null, a units regex
   that matches an apostrophe - and a source-level check cannot see any of them.
   ============================================================================= */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const WIDGET = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8");
const PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";

let fails = 0;
const errors = [];
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log("        " + detail);
}

/* The chart as it reaches the room: "<unit>;<source>;SIZE:chest:waist:hips:legs|..." */
function decode(param) {
  if (!param) return null;
  const head = param.split(";");
  if (head.length < 3) return null;
  const out = { unit: head[0], source: head[1], rows: {} };
  for (const chunk of head.slice(2).join(";").split("|")) {
    const c = chunk.split(":");
    if (!c[0]) continue;
    out.rows[c[0]] = { chest: c[1] || "", waist: c[2] || "", hips: c[3] || "", legs: c[4] || "" };
  }
  return out;
}

async function run(name, html, assertions) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(`[${name}] jsdomError: ${e.message}`));
  vc.on("error", (...a) => errors.push(`[${name}] console.error: ${a.join(" ")}`));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://shop.example.com/products/tee", virtualConsole: vc,
  });
  const { window } = dom;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes("/api/classify-images")) {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        results: body.images.map((x) => (/back|rear/i.test(x) ? "back" : "front")),
        front_image_url: body.front_image_url, back_image_url: "", back_source: "none",
      }) });
    }
    if (u.endsWith("/products/tee.js")) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };

  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST_KEY");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 40));       // the rAF-coalesced inject pass

  /* ZERO PAGE-LOAD COST, asserted rather than asserted-about: nothing has been clicked
     yet, so no chart may have been read. The param is built in openModal(); if a future
     edit moves the scrape to the boot path this snapshot is the thing that notices. */
  const beforeClick = window.document.querySelector(".pear-widget-frame");

  const btn = window.document.querySelector(".pear-widget-btn");
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = new URLSearchParams(iframe ? (iframe.src.split("?")[1] || "") : "");

  console.log(`\n=== ${name} ===`);
  assertions({
    params,
    chart: decode(params.get("garment_size_chart")),
    raw: params.get("garment_size_chart"),
    beforeClick,
    window,
  });
  window.close();
}

const PAGE = (extra) => `<html lang="en"><head>
  <meta property="og:image" content="${SHOP}-1.jpg?width=1400"></head><body>
  <h1>Classic Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1.jpg?width=800" alt="front"></li>
    <li><img src="${PX}" data-src="${SHOP}-2_back.jpg?width=800" alt="back"></li>
  </ul>
  ${extra}
  <form action="/cart/add" method="post"><input name="id" value="99"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

/* The chart every storefront ships, in the orientation most of them ship it. */
const CM_TABLE = `<table>
  <tr><th>Size</th><th>Chest (cm)</th><th>Waist (cm)</th></tr>
  <tr><td>S</td><td>90-95</td><td>76-81</td></tr>
  <tr><td>M</td><td>96-101</td><td>82-87</td></tr>
  <tr><td>L</td><td>102-107</td><td>88-93</td></tr>
</table>`;

/* ══════════════════════════════════════════════════════════════════════════════
   §1 TIER 1 - the three platforms' own size-guide containers
   ═════════════════════════════════════════════════════════════════════════════ */
await run("§1 Shopify - a hidden size-guide modal",
  PAGE(`<modal-dialog id="SizeGuide-modal" style="display:none">
         <div class="size-guide">${CM_TABLE}</div></modal-dialog>`),
  ({ chart, beforeClick }) => {
    /* HIDDEN IS THE NORMAL CASE and it has to work: the markup ships in the DOM and CSS
       hides it until the shopper opens the drawer. querySelectorAll does not care about
       visibility, which is exactly why this can stay passive - no click, no
       showModal(), no fetch. */
    check("the chart reaches the room", !!chart, "no garment_size_chart param");
    check("...tagged with the platform it was found on", chart && chart.source === "shopify",
      chart && chart.source);
    check("...in centimetres", chart && chart.unit === "cm", chart && chart.unit);
    check("...with every size row", chart && Object.keys(chart.rows).join("/") === "S/M/L",
      chart && Object.keys(chart.rows).join("/"));
    check("...and the bands as published", chart && chart.rows.M.chest === "96-101" &&
      chart.rows.M.waist === "82-87", chart && JSON.stringify(chart.rows.M));
    check("nothing was scraped before the shopper clicked", beforeClick === null);
  });

await run("§2 WooCommerce - the size-guide tab panel",
  PAGE(`<div id="tab-size_guide" class="panel">${CM_TABLE}</div>`),
  ({ chart }) => {
    check("the chart reaches the room", !!chart);
    check("...tagged woocommerce", chart && chart.source === "woocommerce", chart && chart.source);
    check("...with the S band intact", chart && chart.rows.S.chest === "90-95",
      chart && chart.rows.S.chest);
  });

await run("§3 Magento - .size-guide-content",
  PAGE(`<div class="size-guide-content">${CM_TABLE}</div>`),
  ({ chart }) => {
    check("the chart reaches the room", !!chart);
    check("...tagged magento", chart && chart.source === "magento", chart && chart.source);
  });

/* ══════════════════════════════════════════════════════════════════════════════
   §4 TIER 2 - the universal fallback, and the shapes charts actually come in
   ═════════════════════════════════════════════════════════════════════════════ */
await run("§4 a bare table with no platform container at all",
  PAGE(CM_TABLE),
  ({ chart }) => {
    check("the generic tier still reads it", !!chart);
    check("...and says so rather than claiming a platform",
      chart && chart.source === "generic", chart && chart.source);
    check("...with all three rows", chart && Object.keys(chart.rows).length === 3);
  });

/* TRANSPOSED. Plenty of charts run sizes across the header with measurement names down
   the first column. Decided by counting size tokens per axis, never guessed from the
   header text - which is what stops a price table being read sideways in §5. */
await run("§5 a transposed chart - sizes across the header",
  PAGE(`<div class="size-chart"><table>
    <tr><th></th><th>S</th><th>M</th><th>L</th></tr>
    <tr><td>Chest (cm)</td><td>90-95</td><td>96-101</td><td>102-107</td></tr>
    <tr><td>Waist (cm)</td><td>76-81</td><td>82-87</td><td>88-93</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("the grid is transposed before parsing", !!chart);
    check("...yielding the same three sizes",
      chart && Object.keys(chart.rows).join("/") === "S/M/L",
      chart && Object.keys(chart.rows).join("/"));
    check("...and the same bands", chart && chart.rows.L.chest === "102-107",
      chart && JSON.stringify(chart.rows));
  });

/* INCHES. A US storefront publishes 36-38, not 91-97. Converted at the COLUMN level off
   that column's median, so one mistyped cell cannot flip a whole column's units. */
await run("§6 an inch chart is converted to centimetres",
  PAGE(`<div class="size-guide"><table>
    <tr><th>Size</th><th>Chest</th></tr>
    <tr><td>S</td><td>36-38</td></tr>
    <tr><td>M</td><td>38-40</td></tr>
    <tr><td>L</td><td>40-42</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("the chart is read", !!chart);
    check("...and arrives in cm, never in the source units",
      chart && chart.unit === "cm", chart && chart.unit);
    /* 36in = 91.44 -> 91.4 (one decimal, so the wire stays short). */
    check("...with 36-38in converted to ~91-97cm",
      chart && chart.rows.S.chest === "91.4-96.5", chart && chart.rows.S.chest);
  });

/* POINT VALUES. "M = 96cm" is a real chart shape, and a zero-width band would penalise
   every shopper whose chest is not exactly the published number - the fine-tune pass
   scores DISTANCE OUTSIDE a band. Banded +/-2cm, the half-step between adjacent sizes. */
await run("§7 a point-value chart is banded, not left zero-width",
  PAGE(`<div class="size-chart"><table>
    <tr><th>Size</th><th>Chest (cm)</th></tr>
    <tr><td>S</td><td>92</td></tr>
    <tr><td>M</td><td>98</td></tr>
    <tr><td>L</td><td>104</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("the chart is read", !!chart);
    check("...and each point became a +/-2cm band",
      chart && chart.rows.M.chest === "96-100", chart && chart.rows.M.chest);
  });

/* Word sizes and decorated size cells - "Medium", "L (EU 40)". A chart discarded for a
   spelling is a chart lost for no reason. */
await run("§8 word sizes and decorated size cells",
  PAGE(`<div class="size-guide"><table>
    <tr><th>Size</th><th>Chest (cm)</th></tr>
    <tr><td>Small</td><td>90-95</td></tr>
    <tr><td>Medium</td><td>96-101</td></tr>
    <tr><td>L (EU 40)</td><td>102-107</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("'Small'/'Medium' map onto the ladder's own tokens",
      chart && Object.keys(chart.rows).join("/") === "S/M/L",
      chart && Object.keys(chart.rows).join("/"));
  });

/* A Hebrew RTL chart. ס"מ contains a double-quote, which is also the inch mark - the
   reason the cm test runs before the inch test everywhere in this feature. Read it as
   inches and the whole store's bands get divided by 2.54. */
await run("§9 a Hebrew chart is read in centimetres, not inches",
  PAGE(`<div class="size-chart" dir="rtl"><table>
    <tr><th>מידה</th><th>היקף חזה (ס"מ)</th><th>היקף מותן (ס"מ)</th></tr>
    <tr><td>S</td><td>90-95</td><td>76-81</td></tr>
    <tr><td>M</td><td>96-101</td><td>82-87</td></tr>
    <tr><td>L</td><td>102-107</td><td>88-93</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("the Hebrew headers map to chest and waist", !!chart && !!chart.rows.M.chest,
      chart && JSON.stringify(chart.rows));
    check("...and the values are NOT divided by 2.54",
      chart && chart.rows.M.chest === "96-101", chart && chart.rows.M.chest);
  });

/* ══════════════════════════════════════════════════════════════════════════════
   §10 THE SILENT CASES - the tests this feature exists to keep passing
   ═════════════════════════════════════════════════════════════════════════════ */
await run("§10 no size guide on the page - the param is absent, not empty",
  PAGE(""),
  ({ params }) => {
    /* An absent param reads as "no chart evidence" and the room uses its vetted matrix.
       That equivalence is what makes every scrape failure harmless. */
    check("no garment_size_chart param at all",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
    check("...and the rest of the handoff is unaffected",
      params.get("garment_url") !== null && params.get("garment_title") === "Classic Tee");
  });

await run("§11 a colour/fabric table is not a size chart",
  PAGE(`<table>
    <tr><th>Colour</th><th>Fabric</th></tr>
    <tr><td>Black</td><td>Cotton</td></tr>
    <tr><td>Blue</td><td>Linen</td></tr>
  </table>`),
  ({ params }) => {
    check("nothing is sent - no measurement column mapped",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

/* THE TRAP. A size column AND numbers, so the shape is right - but the numbers are
   prices. Monotonicity is what catches it: a real chest ladder never wanders. */
await run("§12 a non-monotonic 'chest' column is refused",
  PAGE(`<div class="size-chart"><table>
    <tr><th>Size</th><th>Chest</th></tr>
    <tr><td>S</td><td>99</td></tr>
    <tr><td>M</td><td>129</td></tr>
    <tr><td>L</td><td>89</td></tr>
    <tr><td>XL</td><td>149</td></tr>
  </table></div>`),
  ({ params }) => {
    check("nothing is sent - the ladder wanders, so it is not a ladder",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

await run("§13 an out-of-human-range column is refused",
  PAGE(`<div class="size-chart"><table>
    <tr><th>Size</th><th>Chest</th></tr>
    <tr><td>S</td><td>4</td></tr>
    <tr><td>M</td><td>6</td></tr>
    <tr><td>L</td><td>8</td></tr>
  </table></div>`),
  ({ params }) => {
    /* Ascending and plausibly shaped, but 4-8 of anything is not a chest. The clamp is
       applied AFTER unit inference, so the inches reading (10-20cm) fails it too. */
    check("nothing is sent - the clamp rejects it in either unit",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

await run("§14 a one-row table is refused",
  PAGE(`<div class="size-chart"><table>
    <tr><th>Size</th><th>Chest (cm)</th></tr>
    <tr><td>M</td><td>96-101</td></tr>
  </table></div>`),
  ({ params }) => {
    check("nothing is sent - a single row is not a ladder",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

/* GARMENT LENGTH IS NOT BODY LENGTH, and "inseam" is not this file's "legs" (which is
   the outseam convention - see ZARA_SIZE_CHART's comment in app.js). Both headers are
   deliberately unmapped; a chart carrying only those is a chart with nothing to say. */
await run("§15 'Length' and 'Inseam' columns are deliberately unmapped",
  PAGE(`<div class="size-chart"><table>
    <tr><th>Size</th><th>Length</th><th>Inseam</th></tr>
    <tr><td>S</td><td>68</td><td>76</td></tr>
    <tr><td>M</td><td>70</td><td>78</td></tr>
    <tr><td>L</td><td>72</td><td>80</td></tr>
  </table></div>`),
  ({ params }) => {
    check("nothing is sent - neither header describes a body measurement we score",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

/* ── §15b THE HAZARD CLASS THAT MATTERS MOST: a body WORD in a garment column ──────
   A real fashion spec sheet carries "Waist to Hem" (a drop length), "Half Chest" and
   "Chest Width" (FLAT half-circumferences, i.e. half the number they look like) beside
   the genuine body columns. Every one of them contains a body part's name, and an
   unanchored keyword match reads all three as body circumferences.

   THIS IS THE EXPENSIVE FAILURE, not a cosmetic one. Every other refusal in §10-§15
   produces no chart, which costs nothing - the room keeps its vetted matrix. These
   produce a FULL, well-formed, monotonic, in-clamp chart that is simply wrong, and the
   fine-tune pass scores a shopper's 94cm waist against a 63cm hem drop. Caught by
   refusing any header that also names a garment dimension. */
await run("§15b a 'Waist to Hem' column is not a waist",
  PAGE(`<div class="size-guide"><table>
    <tr><th>Size</th><th>Chest (cm)</th><th>Waist to Hem (cm)</th></tr>
    <tr><td>S</td><td>90-95</td><td>60-62</td></tr>
    <tr><td>M</td><td>96-101</td><td>63-65</td></tr>
    <tr><td>L</td><td>102-107</td><td>66-68</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("the genuine chest column is still read", chart && chart.rows.M.chest === "96-101",
      chart && JSON.stringify(chart.rows));
    check("...and the hem drop is NOT sent as a waist band",
      chart && chart.rows.M.waist === "", chart && chart.rows.M.waist);
  });

await run("§15c 'Half Chest' / 'Chest Width' are flat measurements, not circumferences",
  PAGE(`<div class="size-guide"><table>
    <tr><th>Size</th><th>Half Chest (cm)</th><th>Chest Width</th></tr>
    <tr><td>S</td><td>48</td><td>49</td></tr>
    <tr><td>M</td><td>51</td><td>52</td></tr>
    <tr><td>L</td><td>54</td><td>55</td></tr>
  </table></div>`),
  ({ params }) => {
    /* Half of a 96-108cm chest, and in-clamp as a "chest" the whole way - which is
       exactly why a value check could never catch this and the HEADER has to. */
    check("nothing is sent - a half-chest scored as a chest is a 2x error",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

/* The pure substring bug, in the one column where nothing reads the value today
   (there is no hip input on the form yet) - so it would have sat dormant on the pants
   chart's real hips column until someone wired that input, and then gone live silently. */
await run("§15d 'Ship Weight' is not a hip measurement",
  PAGE(`<div class="size-chart"><table>
    <tr><th>Size</th><th>Ship Weight</th></tr>
    <tr><td>S</td><td>150</td></tr>
    <tr><td>M</td><td>170</td></tr>
    <tr><td>L</td><td>190</td></tr>
  </table></div>`),
  ({ params }) => {
    check("nothing is sent - 'hips' must not match inside 'Ship'",
      params.get("garment_size_chart") === null, String(params.get("garment_size_chart")));
  });

/* The other half of the same fix: \b is an ASCII notion in JavaScript, so adding it to
   the Hebrew alternatives would unmap every Hebrew chart in the catalog. §9 already
   covers the happy path; this pins the reason it still works after the \b change. */
await run("§15e the Hebrew headers still map after the word-boundary fix",
  PAGE(`<div class="size-chart" dir="rtl"><table>
    <tr><th>מידה</th><th>היקף חזה</th><th>היקף מותן</th></tr>
    <tr><td>S</td><td>90-95</td><td>76-81</td></tr>
    <tr><td>M</td><td>96-101</td><td>82-87</td></tr>
    <tr><td>L</td><td>102-107</td><td>88-93</td></tr>
  </table></div>`),
  ({ chart }) => {
    check("chest and waist both still map", chart && chart.rows.M.chest === "96-101" &&
      chart.rows.M.waist === "82-87", chart && JSON.stringify(chart.rows));
  });

/* Free prose containing the word "in" must not turn a centimetre chart into inches -
   the container tier uses a stricter test than the cell/header tiers for exactly this. */
await run("§16 prose around the table cannot flip the units",
  PAGE(`<div class="size-guide">
    <p>Shown in blue. Made in Portugal. Model is 185 tall and wears a M.</p>
    <table>
      <tr><th>Size</th><th>Chest</th></tr>
      <tr><td>S</td><td>90-95</td></tr>
      <tr><td>M</td><td>96-101</td></tr>
      <tr><td>L</td><td>102-107</td></tr>
    </table></div>`),
  ({ chart }) => {
    check("the chart is read", !!chart);
    check("...and 96-101 stays 96-101, not 244-257",
      chart && chart.rows.M.chest === "96-101", chart && chart.rows.M.chest);
  });

/* Two tables, one of them a real chart: the container bonus and the content score have
   to land on the right one. */
await run("§17 a shipping table next to a size chart - the chart wins",
  PAGE(`<table>
      <tr><th>Size</th><th>Price</th></tr>
      <tr><td>S</td><td>99</td></tr>
      <tr><td>M</td><td>109</td></tr>
      <tr><td>L</td><td>119</td></tr>
    </table>
    <div class="size-guide">${CM_TABLE}</div>`),
  ({ chart }) => {
    check("the platform container's table is chosen",
      chart && chart.source === "shopify", chart && chart.source);
    check("...and it is the measurement table, not the price one",
      chart && chart.rows.M.chest === "96-101", chart && JSON.stringify(chart.rows));
  });

console.log("");
if (errors.length) { errors.forEach((e) => console.log("FAIL  " + e)); fails += errors.length; }
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log("size-chart-scrape: all checks passed.");
