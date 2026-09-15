/* CDN URL integrity - the adidas "404 on w_940 / 502 on /api/img-proxy" regression.

   THE BUG THIS CLOSES, end to end. A shopper opened the fitting room on an
   assets.adidas.com storefront and got "Could not load the garment image", with DevTools
   showing 404s on requests named "w_940" / "w_1880" and 502s on /api/img-proxy. Those
   looked like two faults - a mangled URL AND a broken proxy - and the proxy looked like
   the likelier culprit (CDN bot-protection was the standing theory). They were ONE fault,
   and the proxy was innocent:

     1. largestFromSrcset() in pear-widget.js parsed a srcset with `value.split(",")`.
        A srcset is NOT comma-delimited at the URL level - a URL may legally contain
        commas, and every Cloudinary-style CDN puts its transform in one comma-joined
        PATH segment: "/images/w_1880,f_auto,q_auto/<hash>/tee.jpg". The split tore each
        candidate into "…/images/w_940" (absolute but truncated), "f_auto" (junk) and
        "q_auto/<hash>/tee.jpg 940w" (RELATIVE - absolutize() then resolved it against
        the store page). Whichever fragment carried the width descriptor won on weight.
     2. Handed that dead URL, /api/img-proxy fetched it, got a perfectly correct upstream
        404, and reported it as 502 - because every non-ok upstream status was flattened
        to "upstream_error". That single mislabel is what pointed the investigation at
        the proxy and at Akamai instead of at the parser. Verified against the live CDN:
        assets.adidas.com serves the proxy's exact headers HTTP 200; it never blocked us.
     3. Separately, the two spellings of ONE adidas photo (w_280 thumbnail vs w_1880 zoom)
        canonicalised DIFFERENTLY, because PRESENTATION_PARAMS only strips QUERY params.
        That is the §2.2 failure class: a front photo can bind as the back reference, and
        one photo occupies several garment_cache rows that can disagree about front/back.

   §1 pins the parser, §2 pins the canonicaliser across all FOUR copies at once (§3
   lockstep), §3 pins the crawler's srcset gap, §4 pins the proxy's status honesty. */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WIDGET = rd("../widget/pear-widget.js");
const APP = rd("../fitting-room/app.js");
const SERVER = rd("../server.js");
const SCANNER = rd("../scanner/scan-store.js");

let fails = 0;
const check = (label, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
};

/* ── §1 srcset parsing - a URL may contain commas ──────────────────────────────── */
const largestFromSrcset = new Function(
  WIDGET.slice(WIDGET.indexOf("function largestFromSrcset"), WIDGET.indexOf("/* Protocol-relative")) +
  "\nreturn largestFromSrcset;")();

const A = "https://assets.adidas.com/images";
const H = "65ce1d5ad2554ed3ad21f794a927c206_9366/manchester-united-eqt-tee.jpg";

console.log("── §1 srcset: candidates split on WHITESPACE, never on commas ──");
check("§1.1 w-descriptors - the LARGEST whole adidas URL wins, not a fragment",
  largestFromSrcset(`${A}/w_600,f_auto,q_auto/${H} 600w, ${A}/w_940,f_auto,q_auto/${H} 940w, ${A}/w_1880,f_auto,q_auto/${H} 1880w`)
    === `${A}/w_1880,f_auto,q_auto/${H}`,
  largestFromSrcset(`${A}/w_600,f_auto,q_auto/${H} 600w, ${A}/w_1880,f_auto,q_auto/${H} 1880w`));

check("§1.2 a descriptor-less single URL survives whole - THE 404 on \"w_940\"",
  largestFromSrcset(`${A}/w_940,f_auto,q_auto/${H}`) === `${A}/w_940,f_auto,q_auto/${H}`,
  largestFromSrcset(`${A}/w_940,f_auto,q_auto/${H}`));

check("§1.3 1x/2x descriptors - 2x outranks any width, URL still whole",
  largestFromSrcset(`${A}/w_940,f_auto,q_auto/${H} 1x, ${A}/w_1880,f_auto,q_auto/${H} 2x`)
    === `${A}/w_1880,f_auto,q_auto/${H}`);

check("§1.4 a transform carrying a colon (q_auto:sensitive) is not a separator either",
  largestFromSrcset(`${A}/w_280,h_280,f_auto,q_auto:sensitive/${H} 280w, ${A}/w_1880,h_1880,f_auto,q_auto:sensitive/${H} 1880w`)
    === `${A}/w_1880,h_1880,f_auto,q_auto:sensitive/${H}`);

check("§1.5 NOTHING relative ever comes out of a srcset of absolute URLs",
  [`${A}/w_600,f_auto,q_auto/${H} 600w, ${A}/w_1880,f_auto,q_auto/${H} 1880w`,
   `${A}/w_940,f_auto,q_auto/${H}`,
   `${A}/w_940,f_auto,q_auto/${H} 1x, ${A}/w_1880,f_auto,q_auto/${H} 2x`]
    .every((s) => /^https:\/\//.test(largestFromSrcset(s))));

console.log("\n── §1b the ordinary srcset shapes still parse (no regression) ──");
check("§1.6 plain comma-separated URLs with widths",
  largestFromSrcset("https://cdn.shopify.com/tee_400x.jpg 400w, https://cdn.shopify.com/tee_1200x.jpg 1200w")
    === "https://cdn.shopify.com/tee_1200x.jpg");
check("§1.7 descriptor-less, comma separated - the trailing comma ends the candidate",
  largestFromSrcset("https://s.com/a.jpg, https://s.com/b.jpg") === "https://s.com/a.jpg");
check("§1.8 a bare single URL is returned as-is",
  largestFromSrcset("https://s.com/only.jpg") === "https://s.com/only.jpg");
check("§1.9 empty / whitespace / junk never throws and yields \"\"",
  largestFromSrcset("") === "" && largestFromSrcset("   ") === "" && largestFromSrcset(",,,") === "");
check("§1.10 no descriptor on the largest entry still beats a smaller described one",
  largestFromSrcset("https://s.com/a.jpg 100w, https://s.com/b.jpg 900w") === "https://s.com/b.jpg");

/* ── §2 path-embedded CDN transforms, across all FOUR copies (CLAUDE.md §3) ─────── */
/* server.js keeps PRESENTATION_PARAMS above the slice, so read the REAL literal out of
   the file rather than hand-copying it - the same trick url-identity.test.mjs uses, and
   for the same reason: a hand-copied list would go on testing the OLD set forever. */
const srvPresentation = (/const PRESENTATION_PARAMS = new Set\(\[[\s\S]*?\]\);/.exec(SERVER) || [])[0];
if (!srvPresentation) throw new Error("PRESENTATION_PARAMS literal not found in server.js");
const srvCanonical = new Function(
  srvPresentation + "\n" +
  SERVER.slice(SERVER.indexOf("const RESIZER_RE"), SERVER.indexOf("/** True when two URLs identify the SAME photograph. */")) +
  "\nreturn canonicalImageUrl;")();
const appCanonical = new Function("location",
  APP.slice(APP.indexOf("const PRESENTATION_PARAMS = new Set(["),
            APP.indexOf("/** True when two URLs identify the SAME photograph. Use this")) +
  "\nreturn canonicalImageUrl;")({ href: "https://store.example.com/p/1" });
const scnCanonical = new Function(
  SCANNER.slice(SCANNER.indexOf("const RESIZER_RE"), SCANNER.indexOf("async function getCachedClassification")) +
  "\nreturn canonicalImageUrl;")();
const widgetApi = new Function("w",
  WIDGET.slice(WIDGET.indexOf("var RESIZER_RE"), WIDGET.indexOf("function abbrevUrl")) +
  "\nreturn { canonicalPhoto, upgradeImageUrl };")({});

/* Every fixture runs through all four copies at once: they must AGREE, and agree on the
   right answer. A copy that silently drifts fails here rather than in a live session. */
const COPIES = [["server.js", srvCanonical], ["app.js", appCanonical],
                ["scan-store.js", scnCanonical], ["pear-widget.js", widgetApi.canonicalPhoto]];
const sameEverywhere = (a, b, want, label) => {
  const got = COPIES.map(([name, fn]) => [name, fn(a) === fn(b)]);
  const agree = got.every(([, v]) => v === got[0][1]);
  check(label, agree && got[0][1] === want,
    `want=${want} got ${JSON.stringify(Object.fromEntries(got))}\n        ${srvCanonical(a)}\n        ${srvCanonical(b)}`);
};

console.log("\n── §2 a transform in the PATH is presentation, not identity (all 4 copies) ──");
sameEverywhere(`${A}/w_280,h_280,f_auto,q_auto:sensitive/${H}`, `${A}/w_1880,f_auto,q_auto/${H}`, true,
  "§2.1 adidas thumbnail vs zoom slide are ONE photograph");
sameEverywhere(`${A}/w_940,f_auto,q_auto/${H}`, `${A}/w_1880,f_auto,q_auto/${H}`, true,
  "§2.2 two widths of one photo are ONE photograph");
sameEverywhere(`${A}/w_1880,f_auto,q_auto/${H}`, `${A}/${H}`, true,
  "§2.3 a rendition and the bare master are ONE photograph");
sameEverywhere(`${A}/w_1880/${H}`, `${A}/${H}`, true,
  "§2.4 a lone w_ segment is a transform too");

console.log("\n── §2b the narrowness that keeps two DIFFERENT photos apart ──");
sameEverywhere(`${A}/w_940,f_auto,q_auto/abc_9366/tee.jpg`, `${A}/w_940,f_auto,q_auto/def_9366/tee.jpg`, false,
  "§2.5 different asset hash = different photograph");
sameEverywhere(`${A}/w_940,f_auto,q_auto/${H.replace("tee.jpg", "tee_front.jpg")}`,
               `${A}/w_940,f_auto,q_auto/${H.replace("tee.jpg", "tee_back.jpg")}`, false,
  "§2.6 front vs back filename survives the strip - the whole point of §2.1");
sameEverywhere("https://s.com/en_us/img/tee.jpg", "https://s.com/en_gb/img/tee.jpg", false,
  "§2.7 a locale segment (en_us) is NOT a transform - key is not a sizing key");
sameEverywhere("https://s.com/a/w_940.jpg", "https://s.com/a/w_1880.jpg", false,
  "§2.8 the LAST segment is a filename, never a transform");
sameEverywhere("https://a.com/dw1a2b3c4d/tee.jpg", "https://a.com/dw9f8e7d6c/tee.jpg", false,
  "§2.9 an SFCC cache-hash segment is untouched (no underscore)");

console.log("\n── §2c the pre-existing spelling rules are unchanged ──");
sameEverywhere("https://cdn.shopify.com/tee_800x.jpg", "https://cdn.shopify.com/tee.jpg", true,
  "§2.10 shopify filename size suffix still collapses");
sameEverywhere("https://s.com/wp/tee-300x300.jpg", "https://s.com/wp/tee.jpg", true,
  "§2.11 woocommerce thumbnail suffix still collapses");
sameEverywhere("https://s.com/img/poster-1920x1080.jpg", "https://s.com/img/poster.jpg", false,
  "§2.12 full-res dimensions are part of the name, not a suffix");
sameEverywhere("https://s.com/img.php?asset=front", "https://s.com/img.php?asset=back", false,
  "§2.13 identity that lives in the query string is still preserved");

/* The widget's upgradeImageUrl must produce a FETCHABLE url - it is the one copy whose
   output is requested over the network, not just compared. */
console.log("\n── §2d upgradeImageUrl output stays a real, absolute URL ──");
const upgraded = widgetApi.upgradeImageUrl(`${A}/w_280,h_280,f_auto,q_auto:sensitive/${H}`);
check("§2.14 the transform is dropped and the asset path is intact",
  upgraded === `${A.replace("/images", "/images")}/${H}`.replace("/images//", "/images/"), upgraded);
check("§2.15 still absolute - nothing relative can reach absolutize()/fetch()",
  /^https:\/\/assets\.adidas\.com\/images\/[0-9a-f]+_9366\//.test(upgraded), upgraded);

/* ── §3 the crawler reads srcset (lazy galleries hide the real URLs there) ──────── */
const scannerPart = (s, e) => SCANNER.slice(SCANNER.indexOf(s), SCANNER.indexOf(e, SCANNER.indexOf(s)));
const { findProductImages } = new Function(
  scannerPart("const PRODUCT_LINK_PATTERNS", "/* ── Supabase cache") +
  scannerPart("const RESIZER_RE", "async function getCachedClassification") +
  "\nreturn { findProductImages };")();

console.log("\n── §3 scan-store.js: a lazy gallery keeps its real URLs in srcset ──");
{
  const html = `<html><head><title>Tee</title></head><body><main>
    <img src="data:image/gif;base64,R0lGOD" srcset="${A}/w_600,f_auto,q_auto/${H} 600w, ${A}/w_1880,f_auto,q_auto/${H} 1880w">
    <img src="data:image/gif;base64,R0lGOD" data-srcset="${A}/w_600,f_auto,q_auto/abc_9366/back.jpg 600w, ${A}/w_1880,f_auto,q_auto/abc_9366/back.jpg 1880w">
  </main></body></html>`;
  const got = findProductImages(html, "https://www.adidas.co.il/en/HA6542.html");
  check("§3.1 srcset is read at all - the gallery is no longer invisible to the crawler",
    got.length === 2, JSON.stringify(got));
  check("§3.2 no fragment and nothing relative is emitted",
    got.every((u) => /^https:\/\/assets\.adidas\.com\/images\/w_1880,f_auto,q_auto\//.test(u)), JSON.stringify(got));
  check("§3.3 the two DIFFERENT photos are both kept (not collapsed by the strip)",
    new Set(got).size === 2, JSON.stringify(got));
}
{
  // The srcset tier must not outrank an explicit full-size data-src.
  const html = `<html><head><title>Tee</title></head><body><main>
    <img data-src="https://s.com/full/tee.jpg" srcset="https://s.com/small/tee.jpg 200w">
  </main></body></html>`;
  const got = findProductImages(html, "https://s.com/p/tee");
  check("§3.4 an explicit data-src still wins over srcset",
    got.length === 1 && got[0] === "https://s.com/full/tee.jpg", JSON.stringify(got));
}

/* ── §4 /api/img-proxy tells the truth about upstream ───────────────────────────── */
console.log("\n── §4 img-proxy: an upstream verdict is not a gateway failure ──");
{
  process.env.VERCEL = "1";                       // suppress app.listen()
  process.env.PEAR_PROXY_TIMEOUT_MS = "300";      // prove the deadline without a 12s suite
  const realFetch = globalThis.fetch;
  /* Hermetic: no network. Each URL encodes the upstream status the stub should answer.
     Only the proxy's OUTBOUND CDN fetch is stubbed - this suite's own requests to the
     local server must still go through the real fetch, or they never reach the route. */
  globalThis.fetch = async (url, init) => {
    const href = typeof url === "string" ? url : url?.url || String(url);
    if (/^https?:\/\/127\.0\.0\.1[:/]/.test(href)) return realFetch(url, init);
    const status = Number(new URL(href).searchParams.get("upstream") || 200);
    if (status === 0) {
      // A CDN that accepts the connection and then stalls forever, honouring the signal.
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason)));
    }
    if (status === 200) {
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]), {
        status: 200, headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("nope", { status, headers: { "content-type": "text/html" } });
  };

  const { default: app } = await import(new URL("../server.js", import.meta.url).href);
  const srv = createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const hit = (upstream, n) =>
    fetch(`${base}/api/img-proxy?url=${encodeURIComponent(`https://cdn.example.com/p${n}.jpg?upstream=${upstream}`)}`);

  const ok = await hit(200, 1);
  check("§4.1 a healthy upstream is still proxied as an image",
    ok.status === 200 && (ok.headers.get("content-type") || "").startsWith("image/"), `${ok.status}`);

  const notFound = await hit(404, 2);
  const nfBody = await notFound.json();
  check("§4.2 upstream 404 is reported as 404 - NOT 502 (this is the mislabel)",
    notFound.status === 404, `${notFound.status} ${JSON.stringify(nfBody)}`);
  check("§4.3 ...and the real upstream status is named in the body for the logs",
    nfBody.upstreamStatus === 404 && nfBody.error === "upstream_not_available", JSON.stringify(nfBody));

  const forbidden = await hit(403, 3);
  check("§4.4 upstream 403 (hotlink block) passes through as 403",
    forbidden.status === 403, `${forbidden.status}`);
  const gone = await hit(410, 4);
  check("§4.5 upstream 410 passes through as 410", gone.status === 410, `${gone.status}`);

  const upstream500 = await hit(500, 5);
  check("§4.6 a genuine upstream 5xx IS a gateway failure - still 502",
    upstream500.status === 502, `${upstream500.status}`);
  const rateLimited = await hit(429, 6);
  check("§4.7 upstream 429 becomes a retryable 503, never a permanent verdict",
    rateLimited.status === 503, `${rateLimited.status}`);

  const stalled = await hit(0, 7);
  const stalledBody = await stalled.json();
  check("§4.8 a CDN that stalls hits our deadline and returns 504 - it never hangs the function",
    stalled.status === 504 && stalledBody.error === "upstream_timeout",
    `${stalled.status} ${JSON.stringify(stalledBody)}`);

  const ssrf = await fetch(`${base}/api/img-proxy?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`);
  check("§4.9 the SSRF guard is untouched - the metadata endpoint is still 403",
    ssrf.status === 403, `${ssrf.status}`);

  /* Close the listener AND the keep-alive sockets undici is holding open, and WAIT for
     it. Calling process.exit() while the handle is still closing aborts the process on
     Windows with a libuv assertion (UV_HANDLE_CLOSING) - the suite would then report a
     crash regardless of whether a single check failed. */
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  globalThis.fetch = realFetch;
}

console.log("\n" + (fails ? `${fails} FAILING` : "cdn-url-integrity: all checks pass"));
/* `process.exitCode`, NOT process.exit(): this suite is the only one here that binds a
   real http listener, and on Windows an explicit process.exit() after an http server has
   served a fetch() aborts the process with a libuv assertion
   ("!(handle->flags & UV_HANDLE_CLOSING)") - even after close() has fully resolved. The
   runner reads the spawn status, so that crash code (3221226505) would have shown this
   suite as FAILING on every run, green checks and all. Letting the loop drain exits with
   the intended 0/1. */
process.exitCode = fails ? 1 : 0;
