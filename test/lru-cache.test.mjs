/* Bounded LRU for the Blob caches (fitting-room/lru-cache.js).
   This is what stops _assetBlobCache / _lookStitchCache / _compositeCache growing without
   limit - the composites are 2048px JPEGs at quality 0.95, so an eviction bug is measured
   in tens of MB of unreclaimable memory on a phone. It had no direct tests before the
   extraction: composite.test.mjs pulled it in as a text slice purely so the composite
   engine would not ReferenceError, and never asserted a single thing about it.

   Imports the real module - it is pure Map bookkeeping with no DOM, so it needs no jsdom. */
import { lruTouch, lruSet, BLOB_CACHE_MAX } from "../fitting-room/lru-cache.js";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

const keys = (m) => [...m.keys()].join(",");

/* ── 1. lruTouch - promote on read ──────────────────────────────────────────── */
{
  const m = new Map([["a", 1], ["b", 2], ["c", 3]]);
  const got = lruTouch(m, "a");
  check("lruTouch returns the value", got === 1, String(got));
  /* Map iterates in insertion order, which IS the recency order here - promoting has to
     move the key to the END or the next eviction throws away the entry just used. */
  check("lruTouch moves the hit key to the most-recent end", keys(m) === "b,c,a", keys(m));
  check("lruTouch does not change size", m.size === 3);
}

/* ── 2. lruSet - insert, refresh, evict ─────────────────────────────────────── */
{
  const m = new Map();
  for (const k of ["a", "b", "c"]) lruSet(m, k, k.toUpperCase(), 5);
  check("lruSet inserts in order", keys(m) === "a,b,c", keys(m));
  check("lruSet returns the value it stored", lruSet(m, "d", "D", 5) === "D");

  /* A re-set must count as fresh use. Without the delete-then-set, Map keeps the ORIGINAL
     insertion position, so a hot key that is rewritten every time still ages out. */
  lruSet(m, "a", "A2", 5);
  check("re-setting an existing key moves it to the most-recent end", keys(m) === "b,c,d,a", keys(m));
  check("re-setting updates the stored value", m.get("a") === "A2", m.get("a"));
  check("re-setting does not grow the map", m.size === 4, String(m.size));
}

/* ── 3. Eviction ────────────────────────────────────────────────────────────── */
{
  const m = new Map();
  for (let i = 0; i < 8; i++) lruSet(m, `k${i}`, i, 3);
  check("never exceeds max", m.size === 3, String(m.size));
  check("evicts the LEAST-recently-used first", keys(m) === "k5,k6,k7", keys(m));

  // A touched key must survive the next eviction - that is the whole point of the LRU.
  const m2 = new Map();
  for (const k of ["a", "b", "c"]) lruSet(m2, k, k, 3);
  lruTouch(m2, "a");            // "a" is now the most recent, "b" the oldest
  lruSet(m2, "d", "d", 3);
  check("a touched key survives eviction; the untouched oldest goes",
    keys(m2) === "c,a,d", keys(m2));
}

/* ── 4. Defaults and edges ──────────────────────────────────────────────────── */
{
  check("BLOB_CACHE_MAX is a sane positive cap",
    Number.isInteger(BLOB_CACHE_MAX) && BLOB_CACHE_MAX > 0, String(BLOB_CACHE_MAX));

  const m = new Map();
  for (let i = 0; i < BLOB_CACHE_MAX + 5; i++) lruSet(m, `k${i}`, i);   // no max arg → default
  check("default max is BLOB_CACHE_MAX", m.size === BLOB_CACHE_MAX, String(m.size));

  /* max:1 is the degenerate case a future caller could plausibly pass; it must keep
     exactly the newest entry rather than emptying the map or looping forever. */
  const m1 = new Map();
  lruSet(m1, "a", 1, 1);
  lruSet(m1, "b", 2, 1);
  check("max=1 keeps exactly the newest entry", keys(m1) === "b" && m1.size === 1, keys(m1));
}

/* ── 5. The blob: URL safety net ────────────────────────────────────────────── */
/* These caches hold Promise<Blob>, never URL strings - a Blob is reclaimed by GC once the
   Map entry drops. The revoke branch is defensive only, but it is the difference between
   a leak and a clean eviction if a caller ever stores a URL, so pin that it fires. */
{
  const revoked = [];
  const prevURL = globalThis.URL;
  globalThis.URL = { ...prevURL, revokeObjectURL: (u) => revoked.push(u) };

  const m = new Map();
  lruSet(m, "a", "blob:https://pear.test/aaa", 1);
  lruSet(m, "b", "blob:https://pear.test/bbb", 1);
  check("an evicted blob: URL is revoked, not leaked",
    revoked.length === 1 && revoked[0] === "blob:https://pear.test/aaa", JSON.stringify(revoked));

  // A non-URL value (the real case) must NOT be passed to revokeObjectURL.
  revoked.length = 0;
  const m2 = new Map();
  lruSet(m2, "a", Promise.resolve({ size: 1 }), 1);
  lruSet(m2, "b", Promise.resolve({ size: 2 }), 1);
  check("evicting a Promise<Blob> revokes nothing", revoked.length === 0, JSON.stringify(revoked));

  // A plain non-blob string must not be revoked either.
  revoked.length = 0;
  const m3 = new Map();
  lruSet(m3, "a", "https://cdn.test/not-a-blob.jpg", 1);
  lruSet(m3, "b", "https://cdn.test/other.jpg", 1);
  check("evicting a normal http URL string revokes nothing", revoked.length === 0, JSON.stringify(revoked));

  globalThis.URL = prevURL;
}

/* ── 6. Eviction is invisible to an in-flight consumer ──────────────────────── */
/* An evicted key is a cache MISS on next use, never an error - and a job evicted while
   still pending must still resolve for whoever already awaited it. */
{
  const m = new Map();
  let resolveIt;
  const pending = new Promise((r) => { resolveIt = r; });
  lruSet(m, "job", pending, 1);
  const awaiting = m.get("job");
  lruSet(m, "other", Promise.resolve("x"), 1);   // evicts "job" while it is still pending
  check("the evicted key is simply absent (a miss, not an error)", !m.has("job"));
  resolveIt("done");
  const settled = await awaiting;
  check("an in-flight job evicted mid-flight still resolves for its awaiter",
    settled === "done", String(settled));
}

console.log("\n" + (fails ? `${fails} check(s) FAILED` : "All lru-cache checks passed."));
process.exit(fails ? 1 : 0);
