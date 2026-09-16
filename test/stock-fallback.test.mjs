/* REAL-TIME STOCK + INTELLIGENT FALLBACK RECOMMENDATIONS
   ─────────────────────────────────────────────────────────────────────────────
   THE REPORT THIS CLOSES: the size recommendation is computed from the BODY alone.
   A shopper who measures to an L is shown "L" on a product whose L sold out days
   ago - they go live, like it, press "הוסף לסל", and the storefront's own cart call
   is the first thing that tells them. Every step before that is the room confidently
   recommending a garment it cannot sell.

   THE SHAPE OF THE FIX, and what these tests are really pinning:

   · The widget reads stock off the PDP the shopper is already looking at (Shopify's
     own variant `available` first, the size control's DOM state second) and forwards
     ONLY a SOLD-OUT list - never an in-stock one. That direction is the entire safety
     argument and §1/§2 exist to hold it: every way the scrape can fail converges on an
     EMPTY list, and empty means "nothing known to be gone", i.e. byte-for-byte the
     behaviour that shipped before this feature. An in-stock list would have turned each
     of those same failures into "every size is sold out" on a fully stocked product -
     a wrong block, which CLAUDE.md §2.5 exists to forbid.

   · The recommendation itself NEVER MOVES. currentUserSize is still the size that fits
     the body. Quietly re-recommending M because L is gone tells the shopper their size
     is M, which is false and outlives the visit. Case A vs Case B is a difference in
     what is SAID, not in what was computed - §6 pins that.

   · The alternatives must be REAL. §4 is the one the requirement names directly: a
     suggested size has to exist on this product's own ladder AND actually be in stock
     before it is put in front of anyone. Where there is no honest alternative, the
     copy drops that half of the sentence rather than inventing one.
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PW = readFileSync(new URL("../widget/pear-widget.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync(new URL("../fitting-room/i18n.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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

const load = (code, exports) =>
  import("data:text/javascript," + encodeURIComponent(code + "\nexport {" + exports.join(",") + "};"));

/* ══════════════════════════════════════════════════════════════════════════════
   §1 THE WIDGET'S TIER 1 - Shopify's own `available` flag
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §1 soldOutFromVariants(): the store's own answer, and when to refuse it ──");
{
  const code = extract(PW, "function normalizeSizeToken(", "/* ── COMBINED composite");
  const { soldOutFromVariants, oosTokenSignal } =
    await load(code, ["soldOutFromVariants", "oosTokenSignal"]);

  const v = (option1, available) => ({ option1, available });

  check("a plain single-option run reports exactly the unavailable sizes",
    JSON.stringify(soldOutFromVariants(
      [v("S", true), v("M", false), v("L", false), v("XL", true)], 0)) === JSON.stringify(["M", "L"]),
    JSON.stringify(soldOutFromVariants([v("S", true), v("M", false), v("L", false), v("XL", true)], 0)));

  /* THE MULTI-OPTION TRAP. On a Size x Colour product, L-in-red being gone says nothing
     about L-in-blue and the shopper can still buy an L. Requiring EVERY variant carrying
     the size to be unavailable is what stops a two-option product reporting most of its
     ladder sold out. */
  const twoOption = [
    { option1: "Red",  option2: "L", available: false },
    { option1: "Blue", option2: "L", available: true  },
    { option1: "Red",  option2: "M", available: false },
    { option1: "Blue", option2: "M", available: false },
  ];
  check("a size still buyable in ANOTHER colour is NOT sold out",
    JSON.stringify(soldOutFromVariants(twoOption, 1)) === JSON.stringify(["M"]),
    JSON.stringify(soldOutFromVariants(twoOption, 1)));

  /* A payload with no `available` field anywhere would otherwise read as
     undefined -> falsy -> "sold out" for EVERY size, turning a missing field into a
     claim that the whole product is gone. */
  check("a variant shape carrying NO availability field abstains entirely",
    soldOutFromVariants([{ option1: "S" }, { option1: "M" }], 0).length === 0);
  check("...and a size option index the store never declared abstains too",
    soldOutFromVariants([v("S", false)], -1).length === 0);
  check("no variants at all abstains (never 'everything is gone')",
    soldOutFromVariants([], 0).length === 0 && soldOutFromVariants(null, 0).length === 0);

  check("the sold-out list keeps CATALOG order, so 'one size down' stays meaningful",
    JSON.stringify(soldOutFromVariants(
      [v("S", false), v("M", true), v("L", false)], 0)) === JSON.stringify(["S", "L"]));

  /* ── the DOM tier's vocabulary ── */
  console.log("\n── §2 oosTokenSignal(): narrow enough that a product NAME cannot trip it ──");
  check("the class markers the task names are recognised",
    ["sold-out", "out-of-stock", "is-disabled", "swatch unavailable", "size__btn disabled"]
      .every((c) => oosTokenSignal(c, "")),
    "class vocabulary");
  check("Hebrew and English sold-out TEXT is recognised",
    ["Sold out", "Out of stock", "אזל מהמלאי", "לא במלאי", "M - נגמר המלאי"]
      .every((txt) => oosTokenSignal("", txt)));
  /* THE FALSE-POSITIVE THAT WOULD MATTER. A substring match would strike a perfectly
     stocked size on any theme whose class names merely CONTAIN one of these words -
     the same over-broad-keyword failure CLAUDE.md records for EXCLUDE_SRC and the
     adidas "Icon" line. Matched as whole delimited words instead. */
  check("a class that merely CONTAINS a marker as a substring does NOT trip it",
    !["size-disabledness", "unavailablement", "resoldouts", "stockist"]
      .some((c) => oosTokenSignal(c, "")),
    "substring false positives");
  check("an ordinary in-stock swatch is silent",
    !oosTokenSignal("size-swatch is-active", "L"));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §3 ONE WALK, NOT TWO - stock is read off the SAME control the sizes came from
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §3 the size list and its stock come from ONE control ──");
{
  const code = extract(PW, "function normalizeSizeToken(", "/* ── COMBINED composite");
  /* If sizesFromDOM() and soldOutFromDOM() each ran their own walk over
     SIZE_CONTROL_SELECTORS, the two could settle on DIFFERENT controls on a page with
     more than one candidate - and then a size would be reported sold out that the
     shopper is looking at in stock. Pinned structurally: both must go through the one
     shared walk. */
  check("sizesFromDOM() is a projection of the shared {value,node} walk",
    /function sizesFromDOM\(\)\s*\{[^}]*sizeOptionNodes\(\)/.test(code),
    "sizesFromDOM must call sizeOptionNodes(), not re-query the DOM itself");
  check("soldOutFromDOM() reads that same walk",
    /function soldOutFromDOM\(\)\s*\{[\s\S]{0,120}sizeOptionNodes\(\)/.test(code));
  check("there is exactly ONE querySelectorAll(SIZE_CONTROL_SELECTORS) in the widget",
    (PW.match(/querySelectorAll\(SIZE_CONTROL_SELECTORS\)/g) || []).length === 1,
    (PW.match(/querySelectorAll\(SIZE_CONTROL_SELECTORS\)/g) || []).length + " occurrence(s)");

  /* Same argument one level up: the SIZES tier order and the STOCK tier order must
     match, or a stock verdict read off the DOM while the list came from the variant
     JSON would be keyed on differently-spelled values ("L" vs "Large") and match
     nothing. extractSoldOutSizes() decides its tier by asking the SIZES tier. */
  check("extractSoldOutSizes() picks its tier from the same test extractHostSizes() uses",
    /function extractSoldOutSizes\(\)[\s\S]{0,400}sizesFromVariants\(_shopifyVariants, _shopifySizeOptionIndex\)\.length[\s\S]{0,120}soldOutFromVariants/
      .test(PW));
  check("...and falls all the way back to [] on a thrown selector, never to a claim",
    /function extractSoldOutSizes\(\)[\s\S]{0,700}catch[\s\S]{0,200}return \[\];/.test(PW));

  /* Shopify's stock swatch puts the label on a <label> and the disabled state on the
     <input> it points at - reading only the node the string came from misses it on a
     large share of real stores. */
  check("the <label for=…><input disabled> swatch pattern is followed to the input",
    /function stockStateNode\(/.test(PW) &&
    /nodeSaysOutOfStock\(pairs\[i\]\.node\)\s*\|\|\s*nodeSaysOutOfStock\(stockStateNode\(pairs\[i\]\.node\)\)/.test(PW));
  check("the line-through the task names is read from COMPUTED style, not just inline",
    /getComputedStyle[\s\S]{0,260}line-through/.test(PW));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §4 THE FALLBACK ENGINE - the half the requirement names directly
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §4 stockFallbacksFor(): alternatives that exist AND are in stock ──");
{
  const stockCode = extract(APP,
    "/* ══ STOCK - the sizes the shopper cannot actually buy",
    "/* Same two-stage handoff, for the cached numeric/alpha verdict");

  /* The block is executed standalone (CLAUDE.md §2.6/§2.7), so everything it reaches
     for from module scope is declared here. resolvedGarmentSizes() is the ONE thing it
     needs that lives above the marker - stubbed rather than dragged in, so this harness
     pins the stock logic and not the size scrape. */
  const preamble = `
    const SIZE_SCALE = ["XS","S","M","L","XL","XXL","3XL"];
    const CHILD_SIZE_SCALE = ["8","10","12","14","16","18"];
    let currentSizeCategory = "adult", currentSizeIsNumericPants = false;
    let activeItem = null, pendingSoldOutSizes = undefined, pendingSoldOutForImg = undefined;
    let __sizes = [], __els = {}, __dict = {};
    function parseSizeList(raw) {
      const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
      return list.map((s) => String(s == null ? "" : s).trim().toUpperCase()).filter(Boolean);
    }
    function resolvedGarmentSizes() { return parseSizeList(__sizes); }
    function pantsChartForSizes() { return [{size:"28"},{size:"30"},{size:"32"},{size:"34"}]; }
    function sameImage(a, b) { return String(a).split("?")[0] === String(b).split("?")[0]; }
    function formatSizeLabel(s) { return String(s); }
    function tf(key, vars) {
      const raw = __dict[key]; if (!raw) return "";
      return raw.replace(/\\{(\\w+)\\}/g, (m, n) => (vars && vars[n] != null ? String(vars[n]) : m));
    }
    function $(id) { return __els[id] || null; }
    function setSizes(s) { __sizes = s; }
    function setSoldOut(s, img) { pendingSoldOutSizes = s; pendingSoldOutForImg = img; }
    function setItem(i) { activeItem = i; }
    function setEls(e) { __els = e; }
    function setDict(d) { __dict = d; }
    function setCategory(c, numericPants) { currentSizeCategory = c; currentSizeIsNumericPants = !!numericPants; }
  `;
  const m = await load(preamble + stockCode, [
    "resolvedSoldOutSizes", "isSizeSoldOut", "purchasableLadder", "stockFallbacksFor",
    "renderStockNotice", "setSizes", "setSoldOut", "setItem", "setEls", "setDict", "setCategory",
  ]);

  // ── the ladder the fallbacks walk ──
  m.setSizes(["S", "M", "L", "XL"]); m.setSoldOut(undefined);
  check("with a scraped list, the ladder IS that list (never the abstract XS-3XL scale)",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["S", "M", "L", "XL"]),
    JSON.stringify(m.purchasableLadder()));

  /* DOM order is whatever the theme emitted - "one size down" is meaningless on an
     unordered list, and the same trap calculateSize() records in its "TIE-BREAK IS AN
     EXPLICIT rule, NOT ARRAY ORDER" note. */
  m.setSizes(["XL", "S", "L", "M"]);
  check("a shuffled letter run is re-ordered smallest-to-largest before it is walked",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["S", "M", "L", "XL"]),
    JSON.stringify(m.purchasableLadder()));
  m.setSizes(["32", "28", "34", "30"]);
  check("a numeric run sorts NUMERICALLY, not lexically (so 8 < 10, never '10' < '8')",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["28", "30", "32", "34"]));
  m.setSizes(["10", "8", "12"]);
  check("...verified on the case lexical sorting actually gets wrong",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["8", "10", "12"]),
    JSON.stringify(m.purchasableLadder()));
  m.setSizes(["ONE SIZE", "PETITE"]);
  check("an unrecognised run keeps catalog order rather than being sorted by a rule\n" +
        "        that does not apply to it",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["ONE SIZE", "PETITE"]));
  m.setSizes([]); m.setCategory("adult", false);
  check("no scraped list at all falls back to the abstract scale",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["XS", "S", "M", "L", "XL", "XXL", "3XL"]));
  m.setCategory("child", false);
  check("...and a child body gets the kids ladder, never an adult one",
    JSON.stringify(m.purchasableLadder()) === JSON.stringify(["8", "10", "12", "14", "16", "18"]));
  m.setCategory("adult", false);

  // ── THE REQUIREMENT: alternatives must be in stock ──
  m.setSizes(["S", "M", "L", "XL"]);
  m.setSoldOut(["L"]);
  check("CASE B, the example from the spec: L gone -> M down / XL up",
    JSON.stringify(m.stockFallbacksFor("L")) === JSON.stringify({ down: "M", up: "XL" }),
    JSON.stringify(m.stockFallbacksFor("L")));

  /* THE ACTUAL REQUIREMENT: "ensure the suggested alternatives exist in the available
     stock list before presenting them". A size selling out rarely happens alone. */
  m.setSoldOut(["L", "M"]);
  check("an adjacent size that is ALSO gone is never offered - it walks to the next\n" +
        "        one that is genuinely in stock",
    JSON.stringify(m.stockFallbacksFor("L")) === JSON.stringify({ down: "S", up: "XL" }),
    JSON.stringify(m.stockFallbacksFor("L")));

  m.setSoldOut(["L", "M", "S"]);
  check("nothing in stock BELOW -> that half abstains rather than naming a sold-out size",
    JSON.stringify(m.stockFallbacksFor("L")) === JSON.stringify({ down: null, up: "XL" }));

  m.setSoldOut(["S", "M", "L", "XL"]);
  check("a wholly sold-out product yields NEITHER alternative (no invented comfort)",
    JSON.stringify(m.stockFallbacksFor("L")) === JSON.stringify({ down: null, up: null }));

  m.setSoldOut(["XL"]);
  check("the largest size gone has no 'up' to offer, and says so",
    JSON.stringify(m.stockFallbacksFor("XL")) === JSON.stringify({ down: "L", up: null }));
  m.setSoldOut(["S"]);
  check("...and the smallest has no 'down'",
    JSON.stringify(m.stockFallbacksFor("S")) === JSON.stringify({ down: null, up: "M" }));

  /* A chart letter on a product whose picker we never read is not ON the ladder, so
     nothing here knows which direction is "down". Abstain, never guess. */
  m.setSizes(["28", "30", "32"]); m.setSoldOut(["30"]);
  check("a recommended size that is not on the product's ladder abstains entirely",
    JSON.stringify(m.stockFallbacksFor("L")) === JSON.stringify({ down: null, up: null }));
  check("...while a size that IS on it still resolves both directions",
    JSON.stringify(m.stockFallbacksFor("30")) === JSON.stringify({ down: "28", up: "32" }));

  // ── normalisation: never a raw compare ──
  m.setSizes(["S", "M", "L"]); m.setSoldOut([" l ", "m"]);
  check("stock tokens are normalised, so ' l ' from a scrape matches the ladder's 'L'\n" +
        "        (CLAUDE.md §2.2's discipline, applied to size tokens)",
    m.isSizeSoldOut("L") && m.isSizeSoldOut("l") && !m.isSizeSoldOut("S"));

  // ── fail-open ──
  m.setSoldOut(undefined);
  check("NO stock signal at all -> nothing is sold out (the pre-feature behaviour)",
    !m.isSizeSoldOut("L") && m.resolvedSoldOutSizes().length === 0);
  m.setSoldOut([]);
  check("an EMPTY list is 'checked, nothing gone' - also not a block",
    !m.isSizeSoldOut("L"));
  check("a junk/empty size argument is never 'sold out'",
    !m.isSizeSoldOut(null) && !m.isSizeSoldOut("") && !m.isSizeSoldOut(undefined));

  // ── the cross-product gate ──
  console.log("\n── §5 a stock list never outlives the product it was read from ──");
  m.setSoldOut(["L"], "https://cdn/shirt-a.jpg?width=800");
  m.setItem({ img: "https://cdn/shirt-a.jpg?v=42" });
  check("the SAME product under a different URL spelling keeps its stock verdict\n" +
        "        (sameImage, never ===)",
    m.isSizeSoldOut("L"));
  m.setItem({ img: "https://cdn/shirt-b.jpg" });
  check("a DIFFERENT product does not inherit it - a wrong strike-through on a\n" +
        "        perfectly stocked size is the one way this feature could fail loud",
    !m.isSizeSoldOut("L"));
  m.setItem({ img: "https://cdn/shirt-b.jpg", soldOutSizes: ["M"] });
  check("...and that product's OWN list is used when it has one",
    m.isSizeSoldOut("M") && !m.isSizeSoldOut("L"));
  m.setItem(null);
  check("before any garment exists (Screen 1) the handoff's list still applies -\n" +
        "        it is the only stock evidence there is at that point",
    m.isSizeSoldOut("L"));

  // ── the rendered sentence ──
  console.log("\n── §6 renderStockNotice(): Case A is silent, Case B is specific ──");
  const dict = {
    stockSoldOutBoth: "המידה המומלצת שלך היא {size}, אך היא אזלה מהמלאי. ניתן לנסות {down} (התאמה צמודה יותר) או {up} (התאמה משוחררת יותר).",
    stockSoldOutDown: "המידה המומלצת שלך היא {size}, אך היא אזלה מהמלאי. ניתן לנסות {down} (התאמה צמודה יותר).",
    stockSoldOutUp:   "המידה המומלצת שלך היא {size}, אך היא אזלה מהמלאי. ניתן לנסות {up} (התאמה משוחררת יותר).",
    stockSoldOutNone: "המידה המומלצת שלך היא {size}, אך היא אזלה מהמלאי כרגע.",
  };
  m.setDict(dict);
  const boxClasses = new Set();
  const trayClasses = new Set();
  const notice = { hidden: false, textContent: "seed" };
  m.setEls({
    stockNotice: notice,
    resultBox: { classList: { add: (c) => boxClasses.add(c), remove: (c) => boxClasses.delete(c) } },
    resultActions: { classList: { add: (c) => trayClasses.add(c), remove: (c) => trayClasses.delete(c) } },
  });
  m.setItem(null);
  m.setSizes(["S", "M", "L", "XL"]);

  m.setSoldOut([]);
  m.renderStockNotice("L");
  check("CASE A - the recommended size is in stock: the notice is hidden and EMPTY,\n" +
        "        i.e. the screen is exactly what shipped before stock existed",
    notice.hidden === true && notice.textContent === "" && !boxClasses.has("has-stock-notice"));

  m.setSoldOut(["L"]);
  m.renderStockNotice("L");
  check("CASE B - the spec's sentence, verbatim, with the real sizes substituted",
    notice.hidden === false &&
    notice.textContent === "המידה המומלצת שלך היא L, אך היא אזלה מהמלאי. ניתן לנסות M (התאמה צמודה יותר) או XL (התאמה משוחררת יותר).",
    notice.textContent);
  check("...and the result box is flagged so it can restyle",
    boxClasses.has("has-stock-notice"));
  /* THE CLIPPING BUG THIS CLOSES: .result-actions reveals by animating max-height to a
     FIXED 420px with overflow:hidden - a ceiling measured for label + size + button.
     Four to six extra lines of Hebrew on a narrow phone would have been cut off
     silently, with no scrollbar to hint at it. The tray needs the flag too, because a
     descendant's class cannot raise an ancestor's ceiling. */
  check("...and so is the REVEAL TRAY, whose fixed max-height would otherwise clip\n" +
        "        the extra lines with overflow:hidden and no scrollbar",
    trayClasses.has("has-stock-notice"));

  m.setSoldOut(["L", "XL"]);
  m.renderStockNotice("L");
  check("only a smaller size in stock -> the 'looser' clause is DROPPED, not left\n" +
        "        naming a sold-out XL",
    notice.textContent === "המידה המומלצת שלך היא L, אך היא אזלה מהמלאי. ניתן לנסות M (התאמה צמודה יותר)." &&
    !/XL/.test(notice.textContent), notice.textContent);

  m.setSoldOut(["L", "M", "S"]);
  m.renderStockNotice("L");
  check("only a larger size in stock -> the 'closer' clause is dropped",
    notice.textContent === "המידה המומלצת שלך היא L, אך היא אזלה מהמלאי. ניתן לנסות XL (התאמה משוחררת יותר)." &&
    !/צמודה/.test(notice.textContent), notice.textContent);

  m.setSoldOut(["S", "M", "L", "XL"]);
  m.renderStockNotice("L");
  check("nothing left at all still SAYS so - silence here is how the shopper finds\n" +
        "        out from the cart instead",
    notice.textContent === "המידה המומלצת שלך היא L, אך היא אזלה מהמלאי כרגע.");

  m.renderStockNotice(null);
  check("a null size clears the notice - an invalid measurement must not strand the\n" +
        "        previous garment's sold-out sentence under a stale result box",
    notice.hidden === true && notice.textContent === "" &&
    !boxClasses.has("has-stock-notice") && !trayClasses.has("has-stock-notice"));

  m.setSoldOut(["L"]);
  m.setEls({});
  let threw = false;
  try { m.renderStockNotice("L"); } catch { threw = true; }
  check("a missing #stockNotice element is a no-op, never a throw inside calculateSize()",
    !threw);

  m.setEls({ stockNotice: notice, resultBox: null });
  m.setDict({});
  m.renderStockNotice("L");
  check("a dictionary miss says NOTHING rather than painting a literal '{size}'",
    notice.hidden === true && notice.textContent === "");
}

/* ══════════════════════════════════════════════════════════════════════════════
   §7 THE RECOMMENDATION ITSELF NEVER MOVES
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §7 stock is presentation - it never rewrites the recommended size ──");
{
  const calc = extract(APP, "sizeResult.innerText = formatSizeLabel(bestSize);", "updateSizeMismatchUI();");
  check("currentUserSize is still bestSize, the size that fits the BODY",
    /currentUserSize = bestSize;/.test(calc),
    "silently re-recommending M because L is gone tells the shopper their size is M");
  check("renderStockNotice() is called with bestSize - it reports, it does not decide",
    /renderStockNotice\(bestSize\);/.test(calc));
  check("nothing in the stock path reassigns bestSize",
    !/bestSize\s*=\s*[^;]*(?:soldOut|stockFallbacks|purchasable)/i.test(APP));
  check("the notice is cleared BEFORE calculateSize()'s early returns, not after",
    APP.indexOf("renderStockNotice(null);") < APP.indexOf('sizeResult.innerText = t("sizeResultInvalid")'));

  /* Layer A is untouched by design (CLAUDE.md §1): stock changes what is SAID on
     screen, never what reaches Decart. Pinned as an absence - the only form that
     catches a well-meant clause being added later. */
  const traceable = /imageOnlyPrompt|fitPrompt|buildPrompt|lookAnchorPrompt/;
  const stockNames = /isSizeSoldOut|resolvedSoldOutSizes|stockFallbacksFor|purchasableLadder/;
  const promptLines = APP.split("\n").filter((l) => traceable.test(l) && stockNames.test(l));
  check("no prompt builder reads the stock state - this is a Layer D change only",
    promptLines.length === 0, promptLines.join("\n"));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §8 THE HANDOFF - stock actually travels from the PDP into the room
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §8 the transport, end to end ──");
{
  check("the widget forwards the sold-out list on the open URL",
    /garment_soldout=/.test(PW));
  check("...omitted when nothing is sold out, so an absent param is never a claim",
    /hostSoldOut && hostSoldOut\.length \? "&garment_soldout="/.test(PW));
  check("...and re-sent on the late PEAR_UPDATE_GARMENT correction",
    /garment_soldout: extractSoldOutSizes\(\)/.test(PW));
  check("parseHandoff() reads it off the URL synchronously (Screen 1 needs it before\n" +
        "        any round trip lands)",
    /soldOutSizes:\s*q\.get\("garment_soldout"\)/.test(APP));
  check("...and seeds pendingSoldOutSizes with the product it belongs to, in ONE step",
    /pendingSoldOutSizes = result\.soldOutSizes;[\s\S]{0,400}pendingSoldOutForImg = result\.img;/.test(APP));

  /* The open URL OMITS the param when nothing is gone, but the correction always sends
     the field - so [] there means "re-checked, nothing is sold out" and has to be able
     to CLEAR a strike-through the open-time DOM scrape put up. A truthiness test would
     make that correction unrepresentable. */
  check("the listener accepts an EMPTY array as a real correction, not as absence",
    /Array\.isArray\(incomingSoldOut\) \|\| typeof incomingSoldOut === "string"/.test(APP));
  check("...and repaints both surfaces when it lands",
    /incomingSoldOut[\s\S]{0,900}calculateSize\(\)[\s\S]{0,200}injectSizeSelector\(\)/.test(APP));
  check("stock is applied BEFORE the size-list block, so that block's own repaint\n" +
        "        already has the fresh verdict",
    APP.indexOf("const incomingSoldOut") < APP.indexOf("const incomingSizes"));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §9 THE IN-ROOM LADDER + the markup and copy
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §9 the ladder marks sold-out sizes without taking them away ──");
{
  const sel = extract(APP, "function injectSizeSelector()", "function setSizeOverride(");
  check("each button is tested against the stock list",
    /const isOos\s*=\s*isSizeSoldOut\(sz\);/.test(sel));
  /* CLAUDE.md §2.5: a wrong block stops a paying shopper, and trying on a sold-out size
     is a legitimate thing to want. Marked, never removed and never disabled. */
  check("a sold-out size is still RENDERED (the store's own picker still shows it)",
    !/filter\([^)]*isSizeSoldOut/.test(sel), "sold-out sizes must not be filtered out of the ladder");
  /* Scoped to the button TEMPLATE, not to the whole slice: the prose around it says
     "never disabled" a few times, and a bare /\bdisabled\b/ over the slice would pass
     or fail on the comments rather than on the markup. */
  const btnTpl = extract(sel, "const btnHtml = scale.map", '}).join("");');
  check("...and still PRESSABLE - no disabled/aria-disabled is emitted on the button",
    !/\bdisabled=/.test(btnTpl) && !/aria-disabled/.test(btnTpl),
    "the ladder must never disable a button on a stock heuristic");
  check("...and nothing makes it unclickable from the stylesheet either",
    !/\.pear-sz-btn\.is-oos[^}]*pointer-events:\s*none/.test(APP));
  check("the status reaches a screen reader, not only the strike-through styling",
    /aria-label="\$\{esc\(sz \+ " - " \+ oosLabel\)\}"/.test(sel));
  check("the accessible name is escaped - these tokens come off a third-party DOM",
    /const esc = \(s\) =>/.test(sel));
  check("esc() is defined INSIDE the block this test slices (CLAUDE.md §2.6 -\n" +
        "        a module-scope helper would not exist in the extracted copy)",
    sel.indexOf("const esc = (s) =>") > 0);
  check("a legend is printed only when there is something to explain",
    /const anySoldOut = scale\.some/.test(sel) && /anySoldOut \?/.test(sel));
  check("the ★ still marks the recommendation even when that size is the sold-out one",
    /const isRec\s*=\s*sz === currentUserSize;/.test(sel));

  console.log("\n── §10 markup, copy and styling ──");
  check("#stockNotice exists inside the result box, so it inherits that box's reveal",
    /id="resultBox"[\s\S]{0,900}id="stockNotice"[\s\S]{0,200}<\/div>/.test(HTML));
  check("...announced politely rather than stealing focus from the form",
    /id="stockNotice"[^>]*role="status"[^>]*aria-live="polite"/.test(HTML));
  check("...and starts hidden, so Case A renders nothing at all",
    /id="stockNotice"[^>]*\shidden/.test(HTML));
  /* It CANNOT carry data-i18n: the sentence interpolates live size tokens, so
     applyI18nText()'s static walk would overwrite it with a raw "{size}" template. */
  check("it carries NO data-i18n (the static walk would clobber the interpolated copy)",
    !/id="stockNotice"[^>]*data-i18n/.test(HTML));

  check("tf() interpolates named placeholders so each language keeps its own word order",
    /export function tf\(key, vars\)/.test(I18N));
  check("a missing value leaves the placeholder visible rather than printing 'undefined'",
    /vars\[name\] === undefined \|\| vars\[name\] === null\) \? match/.test(I18N));
  for (const key of ["stockSoldOutBoth", "stockSoldOutDown", "stockSoldOutUp", "stockSoldOutNone", "stockSoldOutBadge"]) {
    check(`${key} is defined in BOTH languages`,
      new RegExp(key + ":\\s*\\{?[\\s\\S]{0,400}?he:[\\s\\S]{0,400}?en:").test(I18N));
  }
  check("the Hebrew copy is the exact sentence the requirement specifies",
    I18N.includes("המידה המומלצת שלך היא {size}, אך היא אזלה מהמלאי. ניתן לנסות {down} (התאמה צמודה יותר) או {up} (התאמה משוחררת יותר)."));
  /* CLAUDE.md §2.4's rule, applied to UI copy: the words describe how the FABRIC sits,
     never the shopper's body. "צמודה"/"closer fit" is a property of the garment. */
  check("the fit words describe the GARMENT, never the shopper's body (§2.4)",
    !/\b(slim|thinner|slimmer|רזה|רזי)\b/i.test(extract(I18N, "stockSoldOutBoth", "stockSoldOutBadge")));

  check("the notice honours [hidden] explicitly rather than relying on the UA default",
    /\.stock-notice\[hidden\]\s*\{\s*display:\s*none/.test(CSS));
  /* `(?<![-\w])height:` and not a bare `height:` - `line-height:` and `max-height:`
     both CONTAIN it, and this assertion is about a FIXED box height, which is the thing
     that would clip a 3-line sentence. */
  check("...wraps instead of truncating, so a 3-line sentence cannot clip on a phone",
    /\.stock-notice\s*\{[^}]*line-height/.test(CSS) &&
    !/\.stock-notice\s*\{[^}]*(?:white-space:\s*nowrap|text-overflow|(?<![-\w])height:)/.test(CSS));
  /* Bidirectional by construction: Hebrew copy with Latin size tokens inside it. */
  check("...and resolves its own direction, so one element serves he and en",
    /\.stock-notice\s*\{[^}]*unicode-bidi:\s*plaintext/.test(CSS));
  /* Amber, not the error red: the recommendation is still correct and still shown. */
  check("the box restyles to a warning, NOT to the .error-result state",
    /\.result-box\.has-stock-notice/.test(CSS) &&
    !/\.result-box\.has-stock-notice[^}]*error/.test(CSS));
  /* The reveal tray's fixed max-height + overflow:hidden would clip the extra lines. */
  check("the reveal tray gets a taller ceiling when a notice is present...",
    /\.result-actions\.is-ready\.has-stock-notice\s*\{[^}]*max-height/.test(CSS));
  check("...and outranks the default reveal on specificity (3 classes vs 2), so it\n" +
        "        does not depend on which rule appears first in the file",
    /\.result-actions\.is-ready\.has-stock-notice/.test(CSS) &&
    !/\.result-actions\.is-ready\.has-stock-notice[^}]*!important/.test(CSS));

  /* The strings this file writes at runtime have no data-i18n node for the language
     toggle's static walk to find, so a toggle used to strand them - invisible on a
     two-word label, not on a whole sentence. */
  check("a language toggle repaints the strings the data-i18n walk cannot see",
    /pear:languagechanged/.test(I18N) && /pear:languagechanged/.test(APP));
  check("...announced as an event, so i18n.js never has to import app.js back",
    // Anchored to a real import STATEMENT: the prose in both files says the word
    // "imported" next to "app.js", and a loose match would grade the comments.
    !/^\s*import\s[^\n]*["']\.\/app\.js["']/m.test(I18N));
}

console.log(fails ? `\n${fails} FAILED` : "\nstock-fallback: all green");
process.exit(fails ? 1 : 0);
