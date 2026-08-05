/* =============================================================================
   PEAR - bounded LRU for the Blob caches
   -----------------------------------------------------------------------------
   Second step of the app.js decomposition, and the purest leaf in the file: two
   functions over a Map with no DOM, no session state, no network and no imports.
   Extracting it is transparent to every caller - garmentBlobCached(),
   stitchLookBlob() and the LOCKED createGarmentComposite() keep their code
   unchanged; the identifiers simply resolve to imports now.
   ============================================================================= */
"use strict";

/* ═══════════════════════════════════════════════════════════════════════════
   Bounded LRU for the three Blob caches
   ───────────────────────────────────────────────────────────────────────────
   _assetBlobCache, _lookStitchCache and _compositeCache all previously grew
   without limit: the only `.delete()` calls on any of them sat on the FAILURE
   paths ("never cache a failure - allow a retry"), so every SUCCESSFUL Blob was
   pinned for the lifetime of the page. Their keys are combinatorial - per URL,
   per colour variant, per front/back pair, and per top×bottom look - and the
   composites are 2048px JPEGs at quality 0.95 (several hundred KB each), so a
   few minutes of browsing retained tens of MB that could never be reclaimed.

   Map preserves insertion order, so `delete` + `set` moves a key to the
   most-recently-used end. lruTouch() does that on every hit; lruSet() does it
   on write and then evicts from the least-recently-used front until the cache
   is back within MAX.

   ⚠️ WHY THERE IS NO revokeObjectURL() HERE - these caches store
   Promise<Blob|null>, NOT object-URL strings. There is nothing to revoke: a
   Blob is reclaimed by GC once the last reference drops, which is exactly what
   evicting the Map entry does. The object URLs that ARE derived from these
   blobs are minted and owned elsewhere, on the item itself
   (item._compositeObjectUrl - see createObjectURL in ensureActiveGarmentComposite),
   and they already have a correct lifecycle of their own: releaseCompositePreview()
   revokes them on every garment swap. Revoking those from here would be actively
   WRONG - that URL is what the visible "Now fitting" chip is displaying (see
   garmentThumb/displaySrcOf), so tearing it down on an unrelated cache eviction
   would blank a thumbnail the user is still looking at. Dropping the Map entry
   frees the bytes; the URLs stay under their existing owner's control.

   Eviction is functionally invisible: an evicted key is simply rebuilt on next
   use (a cache miss, never an error), and a job evicted while still in flight
   still resolves normally for whoever is already awaiting it.
   ═══════════════════════════════════════════════════════════════════════════ */
export const BLOB_CACHE_MAX = 10;   // entries per cache

/** Mark `key` as most-recently-used and return its value. Caller checks .has() first. */
export function lruTouch(map, key) {
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

/** Insert as most-recently-used, then evict the oldest entries beyond `max`. */
export function lruSet(map, key, value, max = BLOB_CACHE_MAX) {
  map.delete(key);                 // a re-set must count as fresh, not stay in place
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    const evicted = map.get(oldest);
    map.delete(oldest);            // last reference dropped → Blob becomes GC-eligible
    // Defensive only: these caches never hold URL strings (see the note above),
    // but if one ever does, release it rather than leaking it.
    if (typeof evicted === "string" && /^blob:/i.test(evicted)) {
      try { URL.revokeObjectURL(evicted); } catch (_) {}
    }
  }
  return value;
}
