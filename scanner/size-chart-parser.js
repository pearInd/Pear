/* =============================================================================
   GENERATED FILE - DO NOT EDIT BY HAND.
   Source: widget/pear-widget.js, the "@pear-shared:size-token" and
   "@pear-shared:size-chart-parser" blocks. Regenerate with:
       npm run sync:size-chart-parser
   test/size-chart-parser-sync.test.mjs fails the suite when this file and the widget
   disagree by a single byte. Why it is a generated copy rather than a shared module:
   see scripts/sync-size-chart-parser.mjs.
   ============================================================================= */

/* The widget's parser, bound to one document. `d` is the only free variable the
   shared blocks are allowed to reference (plus console). In the scanner it is a jsdom
   document built from fetched HTML with scripts DISABLED - the same passive, read-only
   view the widget has of a live page. */
export function createSizeChartParser(d) {
  var SIZE_TOKEN_ALPHA_RE = /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|[23]XS)$/i;
  function isPlausibleSizeToken(s) {
    var t = String(s == null ? "" : s).trim();
    if (!t || t.length > 5) return false;
    return /^\d{1,2}$/.test(t) || SIZE_TOKEN_ALPHA_RE.test(t);
  }

  var SIZE_CHART_MAX_TABLES = 8;    // candidate tables scored per page
  var SIZE_CHART_MAX_ROWS   = 40;   // rows read per table
  var SIZE_CHART_MAX_COLS   = 12;   // columns read per row

  /* Absolute sanity clamps, in CENTIMETRES, applied AFTER any inch conversion. These
     are not "typical" bands - they are the outer edge of humanly-possible, sized to
     catch a column that is really prices, weights, or a mis-read grid, while never
     refusing a real chart. A value outside these drops its COLUMN, not the chart. */
  var SIZE_CHART_CLAMPS = {
    chest: { min: 50, max: 200 },
    waist: { min: 40, max: 200 },
    hips:  { min: 50, max: 200 },
    legs:  { min: 40, max: 140 }
  };
  /* A band wider than this is a mis-read: two adjacent cells parsed as one range. */
  var SIZE_CHART_MAX_BAND_CM = 40;
  /* Point-value charts ("M = 96cm") get a symmetric band, since the fine-tune pass
     scores DISTANCE OUTSIDE a band and a zero-width band would penalise every shopper
     whose chest isn't exactly the published number. 2cm each way is the half-step
     between adjacent sizes on every chart in this file. */
  var SIZE_CHART_POINT_TOL_CM = 2;
  /* Below this, a measurement column is inches, above it centimetres. A 38in chest and
     a 38cm chest are not both plausible garments - no adult chest chart is under 60cm
     and no inch chart is over 60in. Applied per COLUMN off that column's median, never
     per cell, so one mis-typed value cannot flip a whole column's units. */
  var SIZE_CHART_INCH_MAX = 60;

  /* Units. CM IS TESTED FIRST AND THAT ORDER IS LOAD-BEARING: the Hebrew ס"מ contains
     a double-quote, which is also the inch mark, so an inch-first test reads every
     Hebrew centimetre chart as inches and divides the whole store by 2.54.

     THE NO-SPACE UNIT (fixed 2026-10-03, moved here from the scanner): "86cm" never
     matched \bcm\b - a digit is a word character, so there is no boundary between the
     "6" and the "c". adidas.co.il writes EVERY cm cell that way ("83 - 86cm"). The cell
     then declared no unit and fell through to sizeChartTableUnit()'s ancestor text,
     which beside an "Inches" toggle label reads "inch" and multiplies a correct
     centimetre ladder by 2.54: a chest of 86 fails the clamp (a visible refusal), but
     a women's waist ladder of 62/68/74 becomes 157.5/172.7/188 and passes it - a
     silent, confident, wrong band, in the live widget as well as the scanner
     (test/size-chart-shared-fixes.test.mjs §2 reproduces it against the old code).
     `\dcm\b` / `\dins?\b` read the glued spelling; the boundary on the far side still
     keeps "cms"/"inside" out. */
  var SIZE_CHART_CM_RE = /(?:\bcm\b|\dcm\b|centimet|ס\s*["'״]?\s*מ|סנטימטר)/i;
  var SIZE_CHART_IN_RE = /(?:inch(?:es)?|\bins?\b|\dins?\b|["”″])/i;
  function sizeChartUnitFromText(s) {
    var t = String(s == null ? "" : s);
    if (SIZE_CHART_CM_RE.test(t)) return "cm";
    if (SIZE_CHART_IN_RE.test(t)) return "in";
    return null;
  }

  /* Header cell -> the column key app.js's chart rows already use. English + Hebrew.
     DELIBERATELY NARROW. An unmapped column contributes nothing, which is safe; a
     WRONGLY mapped one silently re-bands a real measurement, which is not. Two
     specific exclusions worth their own line:
       · bare "length" / "אורך" is NOT mapped - on almost every chart that is the
         GARMENT's length (shoulder to hem), a property of the cloth, not of the body,
         and the fine-tune pass scores body measurements.
       · "inseam" is NOT mapped to legs. app.js's minLegs/maxLegs is the OUTSEAM
         convention (~0.575x height - see ZARA_SIZE_CHART's own comment); an inseam is
         ~0.45x and would read as a shopper 25cm outside every band. A different
         convention for the same body is a second column, never a substitute - the same
         call ADULT_JEANS_WAIST_CHART's comment records for waist-inch vs EU. */
  var SIZE_CHART_MEASURE_KEYS = [
    ["chest", /(?:\bchest\b|\bbust\b|היקף\s*חזה|חזה)/i],
    ["waist", /(?:\bwaist\b|היקף\s*מותן|מותניים|מותן)/i],
    ["hips",  /(?:\bhips?\b|\bseat\b|היקף\s*אגן|ירכיים|אגן)/i],
    ["legs",  /(?:\boutseam\b|\boutside\s*leg\b|\bleg\s*length\b|\btrouser\s*length\b|אורך\s*רגל|אורך\s*מכנס)/i]
  ];
  /* ⚠️ THE \b ON THE ENGLISH ALTERNATIVES IS LOAD-BEARING, AND THE HEBREW ONES
     DELIBERATELY LACK IT. JavaScript's \b is defined on [A-Za-z0-9_], so a Hebrew
     letter is never a word character and \bמותן\b can never match anything - adding it
     "for consistency" silently unmaps every Hebrew chart in the catalog. On the English
     side the opposite is true: without \b, `hips?` matches "Ship Weight" and a column
     of shipping weights is read as a hip ladder.

     AND A BODY WORD IS NOT ENOUGH ON ITS OWN. Real spec sheets carry columns like
     "Waist to Hem", "Half Chest" and "Chest Width" - garment geometry (a length, or a
     FLAT half-circumference) that happens to name a body part. Scoring a shopper's
     94cm waist against a 63cm hem drop, or against a half-chest that is half the number
     it looks like, is the expensive failure this whole file is built to avoid: a
     confident, plausible, WRONG chart rather than a visible absence. So a header that
     also names a garment dimension is refused outright, which costs nothing (the room
     keeps its vetted band for that column).

     NOT APPLIED TO `legs`, whose own patterns are garment-length-shaped by construction
     ("leg length", "trouser length", "אורך רגל") - vetoing them would unmap the key
     entirely. They are narrowly anchored instead. */
  var SIZE_CHART_GARMENT_DIM_RE = new RegExp(
    "\\bto\\s+(?:hem|waist|chest|hip|cuff|knee)\\b|\\blength\\b|\\bdrop\\b|\\bopening\\b" +
    "|\\bhem\\b|\\bsleeve\\b|\\bshoulder\\b|\\binseam\\b|\\brise\\b|\\bacross\\b" +
    "|\\bhalf\\b|\\bflat\\b|\\bwidth\\b|\\bpit\\s*to\\s*pit\\b|\\bp2p\\b|1/2" +
    "|אורך|שרוול|כתף", "i");
  function sizeChartMeasureKey(text) {
    var t = String(text == null ? "" : text);
    if (!t.trim()) return null;
    for (var i = 0; i < SIZE_CHART_MEASURE_KEYS.length; i++) {
      if (!SIZE_CHART_MEASURE_KEYS[i][1].test(t)) continue;
      var key = SIZE_CHART_MEASURE_KEYS[i][0];
      if (key !== "legs" && SIZE_CHART_GARMENT_DIM_RE.test(t)) return null;
      return key;
    }
    return null;
  }

  /* Word sizes -> the tokens app.js's ladders are spelled in. Without this, a chart
     headed "Small / Medium / Large" (which is most of them outside fast fashion)
     yields a size column isPlausibleSizeToken() rejects wholesale, and the chart is
     discarded for a spelling. */
  var SIZE_CHART_WORD_SIZES = [
    [/^(?:xx[\s-]*small|2x[\s-]*small)$/i, "XXS"],
    [/^(?:x[\s-]*small|extra[\s-]*small)$/i, "XS"],
    [/^small$/i, "S"], [/^medium$/i, "M"], [/^large$/i, "L"],
    [/^(?:x[\s-]*large|extra[\s-]*large)$/i, "XL"],
    [/^(?:xx[\s-]*large|2x[\s-]*large)$/i, "XXL"],
    [/^(?:xxx[\s-]*large|3x[\s-]*large)$/i, "XXXL"]
  ];

  /* The size CELL, which is messier than the picker values isPlausibleSizeToken() was
     written for: "M / 38", "L (EU 40)", "Medium". Takes the leading token, maps the
     word forms, and then hands the result to the SAME plausibility test the size
     scrape already uses - so the two can never disagree about what a size looks like.
     @returns {string} the uppercased token, or "" when this is not a size cell */
  function sizeChartSizeToken(raw) {
    var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
    if (!t) return "";
    t = t.split(/[\/|(,]/)[0].trim();          // "L (EU 40)" -> "L", "M / 38" -> "M"
    for (var i = 0; i < SIZE_CHART_WORD_SIZES.length; i++) {
      if (SIZE_CHART_WORD_SIZES[i][0].test(t)) return SIZE_CHART_WORD_SIZES[i][1];
    }
    t = t.toUpperCase();
    return isPlausibleSizeToken(t) ? t : "";
  }

  /* One measurement cell -> { min, max, unit } in the cell's OWN units, or null.
     Handles the four forms that actually ship: a point value ("96"), a range
     ("92-96", "92 - 96", "92 to 96", "92/96"), a unit-suffixed value ("96 cm", 37.5in)
     and a dash/blank placeholder ("-", "", ""). Decimal comma ("96,5") is accepted;
     a thousands separator is not a thing in a chart of body centimetres.
     PURE - no DOM, no globals - so the suite can exercise it directly. */
  function parseMeasurementCell(raw) {
    var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
    if (!t) return null;
    var unit = sizeChartUnitFromText(t);
    /* Numbers are pulled AFTER the unit test, and the inch mark is stripped first, so
       the quote in 37.5" cannot be mistaken for part of the number. */
    var nums = t.replace(/[”″"']/g, " ").match(/\d+(?:[.,]\d+)?/g);
    if (!nums || !nums.length) return null;
    var a = parseFloat(String(nums[0]).replace(",", "."));
    var b = nums.length > 1 ? parseFloat(String(nums[1]).replace(",", ".")) : a;
    if (!isFinite(a) || !isFinite(b)) return null;
    /* Stored min-first. A chart printed "96-92" is a typo, not a reason to drop a row. */
    return { min: Math.min(a, b), max: Math.max(a, b), unit: unit };
  }

  /* Reads a <table> into a capped grid of trimmed strings. Colspans are NOT expanded:
     a chart that needs colspan arithmetic to line its columns up is exactly the kind
     this refuses, and a wrong column alignment is the one failure mode that produces a
     confident, plausible, WRONG chart.

     ARIA DIV-GRIDS (moved here from the scanner 2026-10-03). adidas.co.il (Salesforce
     Commerce Cloud) ships its charts as role="table"/"row"/"columnheader"/"cell" divs
     with no <table> element anywhere. The cells carry the same text a <table> would,
     so the grid is read the same way - rows by role="row", cells by their roles - and
     everything downstream (orientation, units, clamps, monotonicity) is unchanged. A
     role="table" element is only read this way when it is NOT itself a <table> (a
     <table role="table"> is just a table) - see sizeChartIsGridEl(). */
  var SIZE_CHART_TABLE_SEL = 'table,[role="table"]';
  var SIZE_CHART_ARIA_CELL_SEL = '[role="columnheader"],[role="rowheader"],[role="cell"],[role="gridcell"]';
  function sizeChartIsAriaGrid(el) {
    return !!(el && el.tagName && String(el.tagName).toUpperCase() !== "TABLE" &&
      el.getAttribute && el.getAttribute("role") === "table");
  }
  /* A <table>, or an ARIA grid with no real <table> inside it (that one is read as a
     table in its own right, so the wrapper must not be read twice). */
  function sizeChartIsGridEl(el) {
    if (!el || !el.tagName) return false;
    if (String(el.tagName).toUpperCase() === "TABLE") return true;
    return sizeChartIsAriaGrid(el) && !(el.querySelector && el.querySelector("table"));
  }
  function sizeChartGrid(table) {
    var aria = sizeChartIsAriaGrid(table);
    var rows = table.querySelectorAll ? table.querySelectorAll(aria ? '[role="row"]' : "tr") : [];
    var grid = [];
    for (var r = 0; r < rows.length && grid.length < SIZE_CHART_MAX_ROWS; r++) {
      var cells = rows[r].querySelectorAll ? rows[r].querySelectorAll(aria ? SIZE_CHART_ARIA_CELL_SEL : "th,td") : [];
      if (!cells.length) continue;
      var line = [];
      for (var c = 0; c < cells.length && c < SIZE_CHART_MAX_COLS; c++) {
        line.push(String(cells[c].textContent == null ? "" : cells[c].textContent)
          .replace(/ /g, " ").replace(/\s+/g, " ").trim());
      }
      grid.push(line);
    }
    return grid;
  }

  /* ORIENTATION. Charts ship both ways round: sizes down the first column with
     measurement names across the header (the common case), or sizes across the header
     with measurement names down the first column. Decided by COUNTING plausible size
     tokens on each axis rather than by guessing from the header text - a chart with
     neither axis full of sizes reads as "not a size chart" instead of as a transposed
     one, which is what keeps a price table from being read sideways. */
  function sizeChartOrient(grid) {
    if (!grid.length) return grid;
    var down = 0, across = 0, i;
    for (i = 1; i < grid.length; i++) if (sizeChartSizeToken(grid[i][0])) down++;
    for (i = 1; i < (grid[0] || []).length; i++) if (sizeChartSizeToken(grid[0][i])) across++;
    if (across <= down) return grid;
    var width = 0;
    for (i = 0; i < grid.length; i++) width = Math.max(width, grid[i].length);
    var out = [];
    for (var c = 0; c < width; c++) {
      var line = [];
      for (var r = 0; r < grid.length; r++) line.push(grid[r][c] == null ? "" : grid[r][c]);
      out.push(line);
    }
    return out;
  }

  function sizeChartCap(key) { return key.charAt(0).toUpperCase() + key.slice(1); }

  /* One column of parsed cells -> centimetre bands, or null to DROP THE COLUMN.
     Column-level, never cell-level, because units, monotonicity and the clamp are all
     properties of the ladder rather than of any one value - and dropping a column
     leaves the rest of the chart (and app.js's own bands for that measurement) intact,
     which is the whole reason this refuses a column instead of the chart. */
  function sizeChartColumnToCm(col, tableUnit) {
    var i, v, mids = [], explicit = null;
    for (i = 0; i < col.vals.length; i++) {
      v = col.vals[i];
      if (!v) continue;
      if (v.unit) explicit = explicit || v.unit;
      mids.push((v.min + v.max) / 2);
    }
    if (mids.length < 2) return null;                 // a column of one value is noise

    /* Unit, strongest evidence first: a cell said so, the header said so, the table's
       caption/container said so, and only then the magnitude tier. */
    var unit = explicit || col.unit || tableUnit;
    if (!unit) {
      var sorted = mids.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length / 2)];
      unit = median < SIZE_CHART_INCH_MAX ? "in" : "cm";
    }
    var factor = unit === "in" ? 2.54 : 1;
    var clamp = SIZE_CHART_CLAMPS[col.key];

    var out = [], seen = [];
    for (i = 0; i < col.vals.length; i++) {
      v = col.vals[i];
      if (!v) { out.push(null); continue; }
      var min = v.min * factor, max = v.max * factor;
      if (min === max) { min -= SIZE_CHART_POINT_TOL_CM; max += SIZE_CHART_POINT_TOL_CM; }
      if (!(min >= clamp.min && max <= clamp.max)) return null;   // out of human range
      if (max - min > SIZE_CHART_MAX_BAND_CM) return null;        // two cells read as one
      out.push({ min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 });
      seen.push((min + max) / 2);
    }

    /* MONOTONICITY IS THE REAL FILTER, and it is direction-agnostic on purpose: a
       chart may be printed largest-first, and the room keys rows by TOKEN so print
       order is irrelevant to it. What a real ladder can never do is wander - a chest
       that grows, shrinks and grows again across S/M/L is a column of prices, stock
       counts or garment lengths that happened to sit under a "chest" header. Ties are
       allowed (adjacent sizes really do share a band on some charts). */
    var up = true, downward = true;
    for (i = 1; i < seen.length; i++) {
      if (seen[i] < seen[i - 1]) up = false;
      if (seen[i] > seen[i - 1]) downward = false;
    }
    if (!up && !downward) return null;
    return out;
  }

  /* SIZE-SYSTEM COLUMNS -> row aliases. A chart that prints "Size | EU | US | Chest"
     (or "EU | INT | Chest") carries its own conversion table, and that is the only
     EU/US equivalence this codebase trusts: numeric conventions differ by brand and by
     gender (a women's EU 38 is an M, a men's chest-inch 38 is an S/M, an IT 40 is an EU
     36), so the room never hardcodes a US or men's numeric mapping - it reads the
     store's own. IT/FR/DE are kept as their OWN keys, never folded into "eu", for the
     IT-is-EU+4 reason. Checked only AFTER sizeChartMeasureKey(), so "Waist (US)" stays
     a waist column. Aliases never reach the widget's wire format (encodeSizeChart drops
     them); they travel only through the scanner's stored charts. */
  var SIZE_CHART_ALIAS_KEYS = [
    ["eu",  /(?:^|[^a-z])(?:eu|eur|euro|european)(?:$|[^a-z])|אירופ/i],
    ["us",  /(?:^|[^a-z])(?:us|usa)(?:$|[^a-z])|אמריק/i],
    ["uk",  /(?:^|[^a-z])uk(?:$|[^a-z])|בריט/i],
    ["it",  /(?:^|[^a-z])(?:it|ita|italy|italian)(?:$|[^a-z])|איטל/i],
    ["fr",  /(?:^|[^a-z])(?:fr|france|french)(?:$|[^a-z])|צרפת/i],
    ["int", /(?:^|[^a-z])(?:int|intl|international|size|letter)(?:$|[^a-z])|בינלאומ|מידה/i]
  ];
  function sizeChartAliasKey(text) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return null;
    for (var i = 0; i < SIZE_CHART_ALIAS_KEYS.length; i++) {
      if (SIZE_CHART_ALIAS_KEYS[i][1].test(t)) return SIZE_CHART_ALIAS_KEYS[i][0];
    }
    return null;
  }
  /* The part of a size cell AFTER its leading token: "L (EU 40)" -> {eu:"40"},
     "M / 38" -> {alt:"38"}. A labelled system wins; an unlabelled second token is kept
     as "alt", which the room uses only when it is a LETTER (a bare number has no known
     system). */
  function sizeChartCellAliases(raw) {
    var t = String(raw == null ? "" : raw).replace(/ /g, " ").trim();
    var parts = t.split(/[\/|(,]/);
    var out = {};
    for (var i = 1; i < parts.length; i++) {
      var seg = parts[i].replace(/[)\]]/g, " ").trim();
      if (!seg) continue;
      var m = /^([A-Za-z]{2,4})\s*[:.]?\s*(\S+)$/.exec(seg);
      var key = m ? sizeChartAliasKey(m[1]) : null;
      var tok = sizeChartSizeToken(m && key ? m[2] : seg);
      if (!tok) continue;
      var slot = key && key !== "int" ? key : "alt";
      if (!out[slot]) out[slot] = tok;
    }
    return out;
  }

  /* Grid (already oriented sizes-as-rows) -> the validated rows, or null.
     tableUnit is the unit named by the table's caption/container, used only when
     neither the cells nor the header say.
     PURE apart from the grid it is handed, so the suite drives it with literals. */
  function sizeChartFromGrid(grid, tableUnit) {
    if (!grid || grid.length < 3) return null;      // header + at least two size rows
    var header = grid[0], cols = [], aliasCols = [], i, r;
    for (i = 1; i < header.length; i++) {
      var key = sizeChartMeasureKey(header[i]);
      if (!key) {
        var aliasKey = sizeChartAliasKey(header[i]);
        if (aliasKey) aliasCols.push({ key: aliasKey, idx: i });
        continue;
      }
      /* FIRST HEADER WINS on a duplicate key. A chart with two "waist" columns is
         usually body-waist followed by garment-waist; the body one is printed first by
         every convention this codebase has seen, and picking the later one silently
         re-bands the shopper against the cloth. */
      if (key && !sizeChartHasKey(cols, key)) {
        cols.push({ key: key, idx: i, unit: sizeChartUnitFromText(header[i]), vals: [] });
      }
    }
    if (!cols.length) return null;

    var sizes = [], aliasesBySize = [];
    for (r = 1; r < grid.length; r++) {
      var token = sizeChartSizeToken(grid[r][0]);
      if (!token) continue;                          // a notes row, a unit toggle row
      if (sizes.indexOf(token) !== -1) continue;     // duplicate size row - first wins
      sizes.push(token);
      var aliases = sizeChartCellAliases(grid[r][0]);
      for (var a = 0; a < aliasCols.length; a++) {
        var aTok = sizeChartSizeToken(grid[r][aliasCols[a].idx]);
        if (aTok && aTok !== token && !aliases[aliasCols[a].key]) aliases[aliasCols[a].key] = aTok;
      }
      aliasesBySize.push(aliases);
      for (i = 0; i < cols.length; i++) {
        cols[i].vals.push(parseMeasurementCell(grid[r][cols[i].idx]));
      }
    }
    if (sizes.length < 2) return null;

    var rowsOut = [];
    for (i = 0; i < sizes.length; i++) {
      var rowOut = { size: sizes[i] };
      for (var ak in aliasesBySize[i]) { rowOut.aliases = aliasesBySize[i]; break; }
      rowsOut.push(rowOut);
    }
    var kept = 0;

    for (i = 0; i < cols.length; i++) {
      var col = cols[i], band = sizeChartColumnToCm(col, tableUnit);
      if (!band) continue;
      for (r = 0; r < rowsOut.length; r++) {
        if (!band[r]) continue;
        rowsOut[r]["min" + sizeChartCap(col.key)] = band[r].min;
        rowsOut[r]["max" + sizeChartCap(col.key)] = band[r].max;
      }
      kept++;
    }
    return kept ? rowsOut : null;
  }

  function sizeChartHasKey(cols, key) {
    for (var i = 0; i < cols.length; i++) if (cols[i].key === key) return true;
    return false;
  }

  /* The unit named by the table's own caption or by the container around it ("All
     measurements in cm"), used only when neither a cell nor a header says. Walks at
     most four ancestors and reads at most 400 characters, so a unit toggle buried in
     the page chrome cannot pull in the whole document's text.

     ⚠️ IT USES A STRICTER INCH TEST THAN THE CELL/HEADER TIERS, ON PURPOSE. Free page
     prose is not a measurement label: "shown in blue", "Made in Portugal" and a stray
     typographic quote all contain what SIZE_CHART_IN_RE is looking for, and reading a
     centimetre chart as inches divides an entire store's bands by 2.54 - a wrong,
     plausible, confident chart, which is the one failure mode this whole file is built
     to avoid. At this tier only an unambiguous WORD counts ("inch"/"inches"). A cell or
     a header is short and measurement-labelled, so the loose test stays correct there;
     a paragraph is not.

     THE BUG THIS LINE CARRIED (fixed 2026-10-01): it was written /inch(?:es)?<U+0008>/i -
     a literal backspace byte where \b was meant. It compiled and matched nothing a page
     contains, so this whole tier was dead and every chart fell to magnitude inference -
     which reads a plus-size chart (chest 62/64/66 INCHES, above the 60 cutoff) as
     centimetres. test/size-chart-parser-sync.test.mjs §5 pins the fix and scans both
     parser copies for control bytes. */
  var SIZE_CHART_DECLARED_IN_RE = /inch(?:es)?\b/i;
  function sizeChartTableUnit(table) {
    var node = table, depth = 0;
    while (node && depth < 4) {
      var txt = String(node.textContent == null ? "" : node.textContent).slice(0, 400);
      if (SIZE_CHART_CM_RE.test(txt)) return "cm";
      if (SIZE_CHART_DECLARED_IN_RE.test(txt)) return "in";
      node = node.parentNode; depth++;
    }
    return null;
  }

  /* EVERY READABLE GRID ON A PAGE, with unit-toggle twins collapsed to the cm one.
     @returns {Array<{el: Element, anchor: Element}>} in document order. `anchor` is
     where the chart's surrounding labels should be read from (the scanner's
     tableContextText) - for a collapsed pair, the FIRST-rendered member.

     THE TWIN (moved here from the scanner 2026-10-03). adidas.co.il publishes each
     chart twice behind an "Inches | cm" toggle: two grids with the same header row and
     the same first column, one in inches, one in cm. Both parse, they disagree by
     rounding (an inch-derived 82.55-86.36 vs the store's own 83-86), and the widget
     kept whichever came first - the lossy inch one, because adidas renders it first.
     Two grids are collapsed ONLY when they have an identical header row AND first
     column AND one's own cells declare cm while the other's declare inches. Same-shaped
     grids that are both cm (a men's and a women's chart with the same sizes and the
     same measurement names) are two charts and are both kept - a looser key would
     silently drop one audience's chart.
     The cm twin is kept because a store's own centimetres are never a ×2.54 rounding
     away from the real thing; the anchor is the first-rendered slot because that is
     the one sitting under the section heading (the cm tab follows a caption paragraph
     that a 4-sibling heading walk runs out of budget on). */
  function sizeChartGridUnit(grid) {
    var parts = [];
    for (var i = 0; i < grid.length; i++) parts.push(grid[i].join(" "));
    return sizeChartUnitFromText(parts.join(" "));
  }
  function sizeChartTwinKey(grid) {
    if (!grid || grid.length < 3 || !grid[0].length) return null;
    var first = [];
    for (var i = 1; i < grid.length; i++) first.push(grid[i][0] || "");
    return grid[0].join("\u0001") + "::" + first.join("\u0001");
  }
  function sizeChartTables(root) {
    var all = root && root.querySelectorAll ? root.querySelectorAll(SIZE_CHART_TABLE_SEL) : [];
    var items = [], i, j;
    for (i = 0; i < all.length; i++) {
      if (!sizeChartIsGridEl(all[i])) continue;
      var grid = [];
      try { grid = sizeChartGrid(all[i]); } catch (e) { grid = []; }
      items.push({ el: all[i], anchor: all[i], key: sizeChartTwinKey(grid), unit: sizeChartGridUnit(grid), drop: false });
    }
    for (i = 0; i < items.length; i++) {
      if (items[i].drop || !items[i].key) continue;
      for (j = i + 1; j < items.length; j++) {
        if (items[j].drop || items[j].key !== items[i].key) continue;
        var a = items[i].unit, b = items[j].unit;
        if (a === "cm" && b === "in") { items[j].drop = true; }
        else if (a === "in" && b === "cm") { items[i].drop = true; items[j].anchor = items[i].anchor; break; }
      }
    }
    var out = [];
    for (i = 0; i < items.length; i++) if (!items[i].drop) out.push({ el: items[i].el, anchor: items[i].anchor });
    return out;
  }

  /* CONTEXT TEXT FROM A class/id ATTRIBUTE, minus build-tool hashes (moved here from
     the scanner 2026-10-03). A CSS-Modules / styled-components class carries a
     `___<hash>` marker ("[name]__[local]___[hash]") and is a STYLING HOOK, not prose:
     adidas.co.il's men's AND women's ADULT charts both sit in
     "gl-table kids-table___1-YOY" - a reused table-skin component - and reading it as
     a word labelled both as children's charts. A hand-authored semantic class
     ("size-chart-women") never carries the marker, so dropping any token that does
     costs nothing but opaque noise. Anything that words an audience from markup should
     read class/id text through this. */
  function sizeChartContextClean(s) {
    var toks = String(s == null ? "" : s).split(/\s+/), out = [];
    for (var i = 0; i < toks.length; i++) if (toks[i] && toks[i].indexOf("___") === -1) out.push(toks[i]);
    return out.join(" ");
  }

  /* A SIZE-GUIDE ENDPOINT THAT ANSWERS JSON WITH THE MARKUP INSIDE (moved here from the
     scanner 2026-10-03). castro.com's popup returns {"success":true,"html":"<table>…"};
     adidas.co.il's Product-SizeChart returns {"action":…,"success":true,"content":"…"} -
     same envelope, different field name, both served as text/html so the content type
     proves nothing. Parsing the raw body finds markup made of escaped strings and reads
     none of it. Pure over a string.
     @returns {{html:string}|{failed:true}|null} null = not an envelope (use the text
       as it is); failed = an envelope that says {"success":false} - not a page */
  function sizeChartUnwrapEnvelope(text) {
    var t = String(text == null ? "" : text).replace(/^\s+/, "");
    if (t.charAt(0) !== "{") return null;
    var j;
    try { j = JSON.parse(t); } catch (e) { return null; }
    if (!j || typeof j !== "object") return null;
    var body = typeof j.html === "string" ? j.html : typeof j.content === "string" ? j.content : null;
    if (body == null) return null;
    if (j.success === false) return { failed: true };
    return { html: body };
  }

  /* ── WHERE THE CHART LIVES, per platform ─────────────────────────────────────────
     Tier 1. Every list is tried on EVERY page, whatever stack we think we are on: a
     Woo-flavoured theme on a headless Shopify is a real thing, and mis-detecting the
     platform must not cost us the chart. The platform name rides along only as
     provenance (it reaches the room as the chart's `source`, and the console line
     below) - it never gates anything. */
  var SIZE_CHART_CONTAINERS = [
    ["shopify", [
      ".size-chart", ".size-guide", ".sizing-chart", "[data-size-chart]",
      'modal-dialog[id*="size" i]', '.product-popup-modal[id*="size" i]',
      "[data-pear-size-chart]"
    ]],
    ["woocommerce", [
      ".woocommerce-size-guide", "#tab-size_guide", "#tab-size-guide", ".wc-size-chart",
      ".woo-size-chart", ".wcsg-table", '[class*="size-guide" i].woocommerce-tabs',
      ".woocommerce-Tabs-panel--size_guide"
    ]],
    ["magento", [
      ".size-guide-content", "#size-chart-modal", ".sizeguide", ".size-guide-popup",
      '[data-role="size-guide"]', ".product.attribute.size-chart", ".amsizechart"
    ]],
    /* ── THE WILDCARDS GO LAST, AND THEY ARE NOT A PLATFORM ───────────────────────
       These substring matchers ('[class*="size-guide" i]' and friends) catch the long
       tail of themes nobody has a selector for, and they are the reason tier 1 covers
       most real stores at all. But they also match the NAMED containers above -
       .size-guide-content is a "size-guide" substring - so listing them under a
       platform makes that platform claim every other platform's container, purely
       because it was iterated first. consider() de-dupes by node, so being tried last
       means they only ever label what no named selector recognised. The label is
       provenance (it rides along as the chart's `source`, and shows up in the console
       line and in merchant support threads); it gates nothing, which is why this is
       worth getting right but not worth a scoring rule. */
    ["container", [
      '[id*="size-chart" i]', '[id*="size-guide" i]',
      '[class*="size-chart" i]', '[class*="size-guide" i]'
    ]]
  ];

  /* THE PAGE'S OWN SIZE CHART, or null. Two tiers, strongest first, exactly mirroring
     extractHostSizes()/extractSoldOutSizes() above.
     @returns {{unit:"cm", source:string, rows:Array<object>}|null} */
  function extractSizeChart() {
    try {
      var candidates = [], nodes = [], i, j, k, m;
      /* Every readable grid on the page (<table>s and ARIA div-grids), unit-toggle twins
         already collapsed - a grid not in this list is never a candidate. */
      var readable = sizeChartTables(d), readableEls = [];
      for (i = 0; i < readable.length; i++) readableEls.push(readable[i].el);

      function consider(table, source, bonus) {
        if (!table || nodes.indexOf(table) !== -1 || readableEls.indexOf(table) === -1) return;
        if (candidates.length >= SIZE_CHART_MAX_TABLES) return;
        nodes.push(table);
        candidates.push({ table: table, source: source, bonus: bonus });
      }

      for (i = 0; i < SIZE_CHART_CONTAINERS.length; i++) {
        var platform = SIZE_CHART_CONTAINERS[i][0], sels = SIZE_CHART_CONTAINERS[i][1];
        for (j = 0; j < sels.length; j++) {
          var hosts;
          /* Per-selector try/catch: one selector an older engine refuses to parse must
             not take the other twenty-nine with it. */
          try { hosts = d.querySelectorAll(sels[j]); } catch (e) { continue; }
          for (k = 0; k < hosts.length; k++) {
            var inner = hosts[k].querySelectorAll ? hosts[k].querySelectorAll(SIZE_CHART_TABLE_SEL) : [];
            /* A container that IS the chart, laid out with neither a <table> nor ARIA
               table roles, is not readable here and deliberately yields nothing rather
               than a guess. */
            for (m = 0; m < inner.length; m++) consider(inner[m], platform, 6);
          }
        }
      }

      /* Tier 2 - the universal fallback. Every remaining table on the page, judged
         purely on its own content by sizeChartFromGrid(). */
      for (i = 0; i < readableEls.length; i++) consider(readableEls[i], "generic", 0);

      var best = null, bestScore = 0;
      for (i = 0; i < candidates.length; i++) {
        var cand = candidates[i], rows;
        try {
          rows = sizeChartFromGrid(sizeChartOrient(sizeChartGrid(cand.table)),
            sizeChartTableUnit(cand.table));
        } catch (e) { continue; }
        if (!rows) continue;
        var measured = 0;
        for (j = 0; j < rows.length; j++) {
          if (rows[j].minChest != null || rows[j].minWaist != null ||
              rows[j].minHips != null || rows[j].minLegs != null) measured++;
        }
        var score = cand.bonus + measured;
        if (score > bestScore) { bestScore = score; best = { source: cand.source, rows: rows }; }
      }

      if (!best) {
        console.log("[PEAR widget] no readable size chart on this page - the room keeps its default matrix");
        return null;
      }
      console.log("[PEAR widget] size chart read from the PDP (" + best.source + "):",
        best.rows.length + " row(s):", best.rows.map(function (r) { return r.size; }).join("/"));
      return { unit: "cm", source: best.source, rows: best.rows };
    } catch (e) {
      /* CLAUDE.md §2.5 - the room keeps its own vetted matrix, the shopper keeps their
         recommendation, and nothing about this feature can stop a sale. */
      console.log("[PEAR widget] size-chart scrape failed, using the default size matrix:", e && e.message);
      return null;
    }
  }

  /* ── THE WIRE FORMAT ─────────────────────────────────────────────────────────────
         <unit>;<source>;SIZE:chest:waist:hips:legs|SIZE:...
         each measurement ::= "min-max", or "" when this chart doesn't publish it
     e.g. cm;shopify;S:90-95:76-81::|M:96-101:82-87::|L:102-107:88-93::

     COMPACT, NOT JSON, because this rides the iframe URL alongside the image URLs:
     ~25 chars a row, ~160 for a six-row chart, versus ~700 URL-encoded as JSON.

     CROSS-FILE LOCKSTEP (CLAUDE.md §3). The decoder is parseStoreSizeChart() in
     fitting-room/app.js. They are one format and must be edited in the same commit;
     test/size-chart-overlay.test.mjs round-trips this encoder's own output through
     that decoder for exactly that reason.
     @returns {string} "" when there is nothing to send */
  function encodeSizeChart(chart) {
    if (!chart || !chart.rows || !chart.rows.length) return "";
    function band(row, key) {
      var lo = row["min" + key], hi = row["max" + key];
      return (typeof lo === "number" && typeof hi === "number" && isFinite(lo) && isFinite(hi))
        ? lo + "-" + hi : "";
    }
    var parts = [];
    for (var i = 0; i < chart.rows.length; i++) {
      var r = chart.rows[i];
      /* A size token with no measurement at all is dropped rather than shipped as
         "M:::" - the room would index it, find nothing to overlay, and clone a row for
         no reason. */
      var cells = [band(r, "Chest"), band(r, "Waist"), band(r, "Hips"), band(r, "Legs")];
      if (!cells.join("")) continue;
      parts.push(r.size + ":" + cells.join(":"));
    }
    if (!parts.length) return "";
    return (chart.unit || "cm") + ";" + (chart.source || "generic") + ";" + parts.join("|");
  }

  return { isPlausibleSizeToken, SIZE_CHART_CLAMPS, SIZE_CHART_MAX_TABLES, sizeChartUnitFromText, sizeChartMeasureKey, sizeChartSizeToken, sizeChartAliasKey, sizeChartCellAliases, parseMeasurementCell, sizeChartGrid, sizeChartOrient, sizeChartColumnToCm, sizeChartFromGrid, sizeChartTableUnit, SIZE_CHART_CONTAINERS, extractSizeChart, encodeSizeChart, sizeChartIsGridEl, sizeChartTables, sizeChartContextClean, sizeChartUnwrapEnvelope };
}

export const SHARED_BLOCK_HASH = "3c3a084ba20dcab5";
