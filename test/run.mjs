#!/usr/bin/env node
/* =============================================================================
   PEAR - back-view regression suite.   Run with:  npm test
   -----------------------------------------------------------------------------
   These cover the failure modes that made the back of a garment render blank, or
   render the FRONT print, and that were previously only verifiable by loading a
   real storefront in a browser:

     url-identity     One photo served under many URLs (?width=, ?v=, _800x
                      suffixes, image resizers) must compare EQUAL, and genuinely
                      different photos must not. A false "distinct" pair is what
                      bound the front image as the back reference - and the model
                      was then told "reproduce the BACK", so it reproduced the
                      chest print on the back.
     view-resolution  Which photo becomes the front, which becomes the back, and
                      where the back came from - including the guards that refuse
                      a "back" that is really the front.
     widget-dom       The REAL widget file, executed in jsdom against realistic
                      Shopify / WooCommerce / noscript / image-resizer markup.
                      Asserts the gallery is actually discovered on a lazy-loaded
                      gallery, which is the bug that started all of this.

   No network, no API keys, no camera - everything here is deterministic and runs
   in about a second. What it CANNOT cover is called out in the summary.
   ============================================================================= */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUITES = [
  ["url-identity", "url-identity.test.mjs"],
  ["view-resolution", "view-resolution.test.mjs"],
  ["widget-dom", "widget-dom.test.mjs"],
];

let failed = 0;
for (const [name, file] of SUITES) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  process.stdout.write(`\n─── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}\n`);
  const r = spawnSync(process.execPath, [path], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");

  if (/ERR_MODULE_NOT_FOUND/.test(out) && /jsdom/.test(out)) {
    console.log("SKIPPED - jsdom not installed. Run: npm install");
    continue;
  }
  // Only the verdict lines, so the suite output stays readable; the widget file
  // logs heavily by design and that noise belongs in a browser console, not here.
  const lines = out.split("\n").filter((l) => /^(PASS|FAIL|SKIP)/.test(l) || /^\s{8}\S/.test(l));
  console.log(lines.join("\n") || out.trim());
  if (r.status !== 0) failed++;
}

console.log("\n" + "═".repeat(64));
if (failed) {
  console.log(`${failed} suite(s) FAILING`);
  process.exit(1);
}
console.log("All suites passing.");
console.log(
  "\nNot covered here (needs a live environment):\n" +
  "  · Gemini classification accuracy and the generated rear view (needs GEMINI_API_KEY)\n" +
  "  · The Decart realtime session and the actual garment warp\n" +
  "  · Camera orientation detection - see archive/BACK-VIEW-DIAGNOSTICS.md §4 for the\n" +
  "    console trace that verifies it against a real webcam."
);
