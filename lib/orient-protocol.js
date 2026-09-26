/* =============================================================================
   PEAR · The orientation link's server half - one connection, many watchers
   -----------------------------------------------------------------------------
   Transport-free: a session takes a message's text and returns the reply's text (or
   null). The Cloudflare Worker (cloudflare/orient/) and the Node server used in local
   development and by the visual harness (lib/orient-server.js) both wrap exactly this,
   so the two can never disagree about the protocol. The browser half is
   openOrientChannel() in fitting-room/app.js.

   MESSAGES (JSON), all tagged with the watcher's channel id `c`:
     browser -> server  { c, k: "open", knobs, dk? }   a watcher armed: a fresh engine
                        { c, k: "step", q, s }          one tick's sample, q = its sequence
                        { c, k: "close" }               the watcher stopped
     server -> browser  { c, q, a }                     the tick's actions (see lib/orient-engine.js)

   BOUNDED, because the body is shopper-controlled: MAX_CHANNELS engines per
   connection (an item swap opens a new one and closes the old), MAX_MESSAGE_CHARS per
   message, and a step for a channel that was never opened answers with no actions
   rather than conjuring an engine with default knobs. A malformed message is dropped.

   DEBUG. createOrientEngine()'s per-tick line prints every threshold, so a channel may
   debug only when `allowDebug(dk)` says so - the Worker checks the support token, the
   local server always allows it. ============================================================================= */
import { createOrientEngine, sanitizeOrientKnobs, sanitizeOrientSample } from "./orient-engine.js";

const MAX_CHANNELS = 16;
const MAX_MESSAGE_CHARS = 16384;

/** @param {{allowDebug?: (key: unknown) => boolean}} [opts] */
export function createOrientSession({ allowDebug = () => false } = {}) {
  const channels = new Map();   // c -> { engine, debug }
  return {
    /** @param {string} text @returns {string|null} the reply, or null for none */
    handle(text) {
      if (typeof text !== "string" || text.length > MAX_MESSAGE_CHARS) return null;
      let m;
      try { m = JSON.parse(text); } catch { return null; }
      if (!m || typeof m !== "object") return null;
      const c = Number.isInteger(m.c) && m.c > 0 && m.c < 1e9 ? m.c : null;
      if (c === null) return null;
      if (m.k === "open") {
        if (!channels.has(c) && channels.size >= MAX_CHANNELS) channels.delete(channels.keys().next().value);
        const debug = allowDebug(m.dk) === true;
        channels.set(c, { engine: createOrientEngine(sanitizeOrientKnobs(m.knobs), { debug }), debug });
        return null;
      }
      if (m.k === "close") { channels.delete(c); return null; }
      if (m.k === "step") {
        const q = Number.isInteger(m.q) && m.q > 0 ? m.q : null;
        if (q === null) return null;
        const ch = channels.get(c);
        if (!ch) return JSON.stringify({ c, q, a: [] });
        let a;
        try { a = ch.engine.step(sanitizeOrientSample(m.s, { debug: ch.debug })); } catch { a = []; }
        return JSON.stringify({ c, q, a });
      }
      return null;
    },
    get channelCount() { return channels.size; },
  };
}
