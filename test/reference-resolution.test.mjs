/* referenceResolution() / probeReferenceResolution() - "Decart is generating approximate
   print artwork rather than the exact graphics in the reference" (reported 2026-09-21).

   THE GAP THIS CLOSES. The request was to tune the conditioning payload for fidelity, and
   there was nothing left to tune: enhance is already false on all seven dispatch sites,
   @decartai/sdk@0.1.5's setInputSchema is exactly { prompt, enhance, image } with no
   negative_prompt and no mask/ROI, nothing in app.js downsamples a reference, and the
   widget already maximises the URL before handover. What NOBODY measured is what those
   upgrades actually yielded. Every existing check on the preload path asks whether the
   bytes decode, whether they are a flat placeholder, and whether the rear carries a
   graphic - none asks how BIG the picture is. A storefront whose CDN pattern
   upgradeImageUrl() misses hands over a thumbnail; it decodes, it is not flat, it is
   genuinely the product, and Decart conditions on a 200px packshot whose chest graphic is
   sixty pixels wide. The model cannot reproduce detail the reference does not carry.

   Extracts the REAL functions, not a reimplementation. createImageBitmap is stubbed
   because Node has none - the decode is not what is under test; the VERDICT is. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

const code = extract("const REFERENCE_MIN_EDGE_PX", "async function preloadGarmentAssets");
check("§0 extracted the real probe, not a copy",
  /_refResolutions/.test(code) && /function referenceResolution/.test(code) &&
  /function probeReferenceResolution/.test(code));

/** Run the extracted block against a stub decoder. @returns logs + the module's own API */
function build({ dims = { width: 1200, height: 1500 }, throws = false } = {}) {
  const logs = [], warns = [];
  let decodes = 0;
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => warns.push(a.join(" ")) },
    createImageBitmap: async () => {
      decodes++;
      if (throws) throw new Error("decode failed");
      return { width: dims.width, height: dims.height, close() {} };
    },
    WeakMap,
    Promise,
    Math,
  };
  const fn = new Function(...Object.keys(sandbox), code +
    "\nreturn { referenceResolution, probeReferenceResolution, REFERENCE_MIN_EDGE_PX };");
  const api = fn(...Object.values(sandbox));
  return { api, logs, warns, decodeCount: () => decodes };
}

const blobOf = (size) => ({ size, type: "image/png" });
const settle = () => new Promise((r) => setTimeout(r, 0));

/* ── §1 the floor itself ─────────────────────────────────────────────────── */
{
  const { api } = build();
  check("§1.1 the floor is 512px, the value the fixtures sit exactly on",
    api.REFERENCE_MIN_EDGE_PX === 512, `got ${api.REFERENCE_MIN_EDGE_PX}`);
}

/* ── §2 a real catalog packshot passes quietly ───────────────────────────── */
{
  const t = build({ dims: { width: 1600, height: 2000 } });
  t.api.probeReferenceResolution(blobOf(180000), "Harness Tee", "front");
  await settle();
  check("§2.1 a 1600x2000 packshot logs OK and does not warn",
    t.warns.length === 0 && t.logs.some((l) => /reference resolution/.test(l) && /\(ok\)/.test(l)),
    `warns=${JSON.stringify(t.warns)} logs=${JSON.stringify(t.logs)}`);
  check("§2.2 ...and the log names the garment, the side and the pixels",
    t.logs.some((l) => /Harness Tee/.test(l) && /front/.test(l) && /1600x2000/.test(l)),
    JSON.stringify(t.logs));
  check("§2.3 ...and keeps the [PEAR] prefix the merchant contract depends on",
    t.logs.every((l) => l.startsWith("[PEAR]")), JSON.stringify(t.logs));
}

/* ── §3 the fixture size is the boundary, and passes ─────────────────────── */
{
  const t = build({ dims: { width: 512, height: 640 } });
  t.api.probeReferenceResolution(blobOf(90000), "Harness Tee", "back");
  await settle();
  check("§3.1 exactly 512 on the short edge is NOT a warning - the gate's own fixtures are 512x640",
    t.warns.length === 0, JSON.stringify(t.warns));
}

/* ── §4 a thumbnail is reported, loudly and specifically ─────────────────── */
{
  const t = build({ dims: { width: 200, height: 250 } });
  t.api.probeReferenceResolution(blobOf(8000), "Fox Tee", "front");
  await settle();
  check("§4.1 a 200x250 thumbnail warns", t.warns.length === 1, JSON.stringify(t.warns));
  check("§4.2 ...naming the measured size and the floor",
    /200x250/.test(t.warns[0] || "") && /512/.test(t.warns[0] || ""), t.warns[0]);
  check("§4.3 ...and says WHERE to fix it, not just that it is wrong",
    /upgradeImageUrl/.test(t.warns[0] || ""), t.warns[0]);
  check("§4.4 ...and explains the consequence in render terms",
    /approximate/i.test(t.warns[0] || ""), t.warns[0]);
}

/* ── §5 one probe per Blob - the memo, and what is NOT memoised ──────────── */
{
  const t = build({ dims: { width: 1200, height: 1500 } });
  const b = blobOf(120000);
  await t.api.referenceResolution(b);
  await t.api.referenceResolution(b);
  await t.api.referenceResolution(b);
  check("§5.1 the same Blob is decoded exactly once", t.decodeCount() === 1, `decodes=${t.decodeCount()}`);

  const other = blobOf(120000);   // same size, different object - a refetch earns its own probe
  await t.api.referenceResolution(other);
  check("§5.2 a DIFFERENT Blob object is probed again, even at the same byte size",
    t.decodeCount() === 2, `decodes=${t.decodeCount()}`);
}
{
  const t = build({ throws: true });
  const b = blobOf(1000);
  const first = await t.api.referenceResolution(b);
  const second = await t.api.referenceResolution(b);
  check("§5.3 a decode FAILURE returns null rather than throwing", first === null && second === null);
  check("§5.4 ...and is never memoised - a transient hiccup must not become a permanent verdict",
    t.decodeCount() === 2, `decodes=${t.decodeCount()}`);
}

/* ── §6 it can never block, and never changes a dispatch ─────────────────── */
{
  const t = build({ dims: { width: 40, height: 40 } });
  const returned = t.api.probeReferenceResolution(blobOf(500), "Tiny", "front");
  check("§6.1 probeReferenceResolution returns undefined - it is fire-and-forget, never awaited into go-live",
    returned === undefined);
  await settle();
  check("§6.2 even a 40x40 reference only WARNS - CLAUDE.md 2.5, a wrong block stops a paying shopper",
    t.warns.length === 1 && t.logs.length === 0, `warns=${t.warns.length} logs=${t.logs.length}`);

  const nul = build();
  check("§6.3 a null/absent Blob is answered without a decode",
    (await nul.api.referenceResolution(null)) === null && nul.decodeCount() === 0);
}

/* ── §7 the call sites, and the sandbox contract that protects them ──────── */
{
  const gate = extract("async function preloadGarmentAssets", "/* ── Context-Aware Asset Switching - OrientationWatcher");
  const calls = gate.match(/probeReferenceResolution\(/g) || [];
  check("§7.1 the preload gate probes BOTH the front and the back reference",
    calls.length === 2, `found ${calls.length}`);
  /* The guard, not one particular spelling of it. Asserted as a COUNT so the check keeps
     holding if a call site is reworded, and still fails the moment one loses its guard:
     an unguarded call kills the extracted copy with a ReferenceError while the real file
     is fine, which is the §2.7 failure this exists to catch. */
  const guards = gate.match(/typeof probeReferenceResolution === "function"/g) || [];
  check("§7.2 every call is typeof-guarded - the gate runs standalone in preload-composite (CLAUDE.md 2.7)",
    guards.length === calls.length && calls.length > 0,
    `${calls.length} call(s) but ${guards.length} guard(s)`);
  check("§7.3 the helper is defined ABOVE the gate's slice, so it is never inside the extract",
    SRC.indexOf("function probeReferenceResolution") < SRC.indexOf("async function preloadGarmentAssets"));
  check("§7.4 no probe is awaited - a diagnostic must add no latency in front of go-live",
    !/await\s+probeReferenceResolution/.test(gate));
}

console.log(fails ? `\n${fails} check(s) failed.` : "\nreference-resolution: all checks passed.");
process.exit(fails ? 1 : 0);
