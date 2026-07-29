/* fetchImageAsBase64Cached() - the safe speed optimization for "make the combined
   loading as fast as possible without damaging the system". A single-photo product's
   front image gets fetched from the CDN TWICE within one classify-images request:
   once by classifyFrontBackDetailed() to classify it, once more by
   synthesizeBackView() to generate its rear view. This is the memoization that
   collapses the two into one fetch, deliberately scoped short (60s) so it can never
   pretend to be a durable cache - garment_cache/Storage already own that. */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}" in server.js`);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return SRC.slice(start, end);
}

// canonicalImageUrl (a dependency of fetchImageAsBase64Cached) lives much later in the
// file - pull both pieces in file order and splice together, same pattern used
// elsewhere in this suite for cross-cutting helpers.
const fetchPart = extract("async function fetchImageAsBase64(imageUrl)", "/* ── Strict front/back system prompt");
const canonicalPart = extract(
  "const PRESENTATION_PARAMS",
  "/** True when two URLs identify the SAME photograph. */"
);
const PRESENTATION_PARAMS_SHIM = "const PRESENTATION_PARAMS = new Set(['width','height','w','h','size','quality','q','dpr','format','fm','crop','fit','scale','v','ver','version','t','cache','_']);\n";

check("extracted fetchImageAsBase64Cached", /function fetchImageAsBase64Cached/.test(fetchPart));
check("extracted canonicalImageUrl", /function canonicalImageUrl/.test(canonicalPart));

function buildApi({ fakeNow } = {}) {
  const fetchCalls = [];
  const sandbox = {
    fetch: (url) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: () => Promise.resolve(Buffer.from(`bytes-for-${url}`)),
      });
    },
    Buffer,
    Date: fakeNow ? { now: fakeNow } : Date,
    URL,
    console,
  };
  const fn = new Function(...Object.keys(sandbox),
    canonicalPart + "\n" + fetchPart + "\nreturn { fetchImageAsBase64Cached, canonicalImageUrl };"
  );
  const api = fn(...Object.values(sandbox));
  return { api, fetchCalls };
}

console.log("── the actual win: two requests for the SAME photo fetch bytes ONCE ──");
{
  const { api, fetchCalls } = buildApi();
  const url = "https://cdn.shopify.com/s/files/tee-front.jpg";
  const [a, b] = await Promise.all([api.fetchImageAsBase64Cached(url), api.fetchImageAsBase64Cached(url)]);
  check("only ONE underlying fetch for two concurrent requests of the same URL",
    fetchCalls.length === 1, JSON.stringify(fetchCalls));
  check("both callers get the same bytes", a.base64 === b.base64);

  const c = await api.fetchImageAsBase64Cached(url);
  check("a THIRD, later request also reuses the cached bytes (no extra fetch)",
    fetchCalls.length === 1, JSON.stringify(fetchCalls));
  check("sequential caller gets the same bytes too", c.base64 === a.base64);
}

console.log("\n── two URL spellings of the SAME photo also collapse to one fetch ──");
{
  const { api, fetchCalls } = buildApi();
  await api.fetchImageAsBase64Cached("https://cdn.shopify.com/s/files/tee.jpg?v=9&width=800");
  await api.fetchImageAsBase64Cached("https://cdn.shopify.com/s/files/tee.jpg?width=1400&v=11");
  check("classification's URL and synthesis's (re-fetched, resized/re-versioned) URL still hit the cache",
    fetchCalls.length === 1, JSON.stringify(fetchCalls));
}

console.log("\n── genuinely different photos are NOT conflated ──");
{
  const { api, fetchCalls } = buildApi();
  await api.fetchImageAsBase64Cached("https://cdn.shopify.com/s/files/tee-front.jpg");
  await api.fetchImageAsBase64Cached("https://cdn.shopify.com/s/files/tee-back.jpg");
  check("two distinct photos both actually fetched", fetchCalls.length === 2, JSON.stringify(fetchCalls));
}

console.log("\n── a failed fetch is never cached (must not block a later retry) ──");
{
  let calls = 0;
  const sandbox = {
    fetch: () => { calls++; return Promise.resolve({ ok: false, status: 404 }); },
    Buffer, Date, URL, console,
  };
  const fn = new Function(...Object.keys(sandbox),
    canonicalPart + "\n" + fetchPart + "\nreturn { fetchImageAsBase64Cached };"
  );
  const api = fn(...Object.values(sandbox));
  const url = "https://cdn.shopify.com/s/files/broken.jpg";
  await api.fetchImageAsBase64Cached(url).catch(() => {});
  await api.fetchImageAsBase64Cached(url).catch(() => {});
  check("a failure is retried, not cached as a permanent miss", calls === 2, `fetch called ${calls} time(s)`);
}

console.log("\n── the 60s TTL expires so this can never masquerade as a durable cache ──");
{
  let now = 1_000_000;
  const { api, fetchCalls } = buildApi({ fakeNow: () => now });
  const url = "https://cdn.shopify.com/s/files/tee-front.jpg";
  await api.fetchImageAsBase64Cached(url);
  now += 61_000;   // just past the 60s TTL
  await api.fetchImageAsBase64Cached(url);
  check("a request after the TTL re-fetches rather than serving stale bytes forever",
    fetchCalls.length === 2, JSON.stringify(fetchCalls));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
