/* THE WIRE GUARD - the invariant that could not be established by fixing call sites.

   "The garment turns into one nobody chose, mid-session" has been traced three times, and
   each fix landed on whichever call site happened to be responsible: applyGarment() got
   the garment pin, applyLook() got the same pin, and applyFallbackConditioning() was later
   found still shipping the original conditional spread. Three fixes, one property, and the
   property stayed false somewhere else each time. Auditing call sites cannot establish an
   invariant - there is always another send site, and the next one added will not know.

   So it is enforced at the SDK boundary, where every dispatch converges: rtClient.set().

   AND A PRESENCE CHECK IS NOT ENOUGH, which is the half the call-site fixes could never
   have covered. @decartai/sdk@0.1.5 utils/media.js imageToBase64() tests for a data: URL
   and for an ABSOLUTE http(s) URL, then falls through to a bare `return image;` - so a
   string that is neither is returned VERBATIM where base64 image bytes are expected. A
   blob: URL (protocol "blob:") hits it. So does any relative URL, because new URL() throws
   on one. No error, no log: the payload looks perfectly conditioned in every line we
   print, and the model renders an arbitrary garment. That is a CORRUPT reference rather
   than a missing one, and only a classifier that asks "can the SDK actually use this?"
   catches it.

   This drives the REAL classifyImageRef/instrumentRtClient against a recording client. */
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

const guardSrc = extract("function classifyImageRef(image) {", "\n/**\n * Fires once per session");
check("extracted the wire guard",
  /function classifyImageRef/.test(guardSrc) && /function instrumentRtClient/.test(guardSrc));

function harness({ pinned = null } = {}) {
  const sent = [];
  const logs = [];
  const win = {};
  const sandbox = {
    Blob, URL, Date, Object,
    console: {
      log: (...a) => logs.push({ level: "log", a }),
      warn: (...a) => logs.push({ level: "warn", a }),
      error: (...a) => logs.push({ level: "error", a }),
      table: () => {},
    },
    window: win,
    abbrevImg: (r) => (r === null || r === undefined ? "(none)" : String(r).slice(0, 30)),
    sessionElapsedMs: () => 1234,
  };
  const api = new Function(...Object.keys(sandbox),
    "let lastAckedImageRef = " + JSON.stringify(pinned) + ";\n" +
    guardSrc +
    "\nreturn { classifyImageRef, instrumentRtClient, journal: () => _wireJournal.slice()," +
    " setLabel: (l) => { _wireLabel = l; }, win: window," +
    " pin: (v) => { lastAckedImageRef = v; } };"
  )(...Object.values(sandbox));

  /* A client shaped like the SDK's: set/setPrompt plus the incidental surface the app
     relies on, so "the wrapper preserves everything else" is actually observable. */
  const client = {
    set: async (p) => { sent.push({ m: "set", p }); return "set-ok"; },
    setPrompt: async (prompt, opts) => { sent.push({ m: "setPrompt", prompt, opts }); return "prompt-ok"; },
    disconnect: () => "disconnected",
    getConnectionState: () => "connected",
    on: () => "listener",
  };
  return { api, client, sent, logs };
}

console.log("\n── §1 the classifier answers 'can the SDK use this?', not 'is something there' ──");
{
  const { api } = harness();
  const c = api.classifyImageRef;

  check("a real Blob is usable", c(new Blob(["x"], { type: "image/jpeg" })).usable === true);
  check("a 0-byte Blob is NOT - a composite or decode failed silently",
    c(new Blob([])).usable === false && c(new Blob([])).kind === "empty-blob");
  check("a data: URL with a payload is usable",
    c("data:image/png;base64,iVBORw0KGgo=").usable === true);
  check("...but one with nothing after the comma is not",
    c("data:image/png;base64,").usable === false);
  check("an absolute https URL is usable (the SDK will fetch it)",
    c("https://cdn.example/x.jpg").usable === true);

  /* THE TWO SHAPES THIS SUITE EXISTS FOR. Both are present, non-null, non-empty strings -
     every "is the image there?" check passes them - and both reach imageToBase64()'s bare
     `return image;`, which hands the model the characters of a URL as its reference. */
  const blobUrl = c("blob:https://shop.example/9f2c-4a1e");
  check("a blob: URL is REFUSED as the SDK's silent-corruption shape",
    blobUrl.usable === false && blobUrl.kind === "sdk-fallthrough", JSON.stringify(blobUrl));
  const rel = c("/api/img-proxy?url=https%3A%2F%2Fcdn%2Fx.jpg");
  check("...and so is a RELATIVE url, which new URL() cannot parse",
    rel.usable === false && rel.kind === "sdk-fallthrough", JSON.stringify(rel));
  check("...and the reason says what actually happens on the wire",
    /verbatim/.test(blobUrl.detail) && /arbitrary garment/.test(blobUrl.detail), blobUrl.detail);

  check("a missing key is 'absent'", c(undefined).kind === "absent");
  /* Distinguished from absent on purpose: the SDK's schema accepts null and documents it
     as "clear the current image", so this one actively blanks the conditioning. */
  check("an explicit null is its own kind, because the SDK treats it as CLEAR",
    c(null).kind === "null" && /CLEAR/.test(c(null).detail));
  check("an empty string is not usable", c("").usable === false);
  check("a non-Blob non-string is not usable", c(42).usable === false);
}

console.log("\n── §2 a good dispatch passes through untouched ──");
{
  const { api, client, sent } = harness({ pinned: "https://cdn.example/pinned.jpg" });
  api.instrumentRtClient(client);
  const good = new Blob(["bytes"], { type: "image/jpeg" });
  const r = await client.set({ prompt: "P", enhance: false, image: good });

  check("the real set() is called", sent.length === 1 && sent[0].m === "set");
  check("...with the SAME image object, not a copy or a substitute",
    sent[0].p.image === good);
  check("...and the return value is passed back", r === "set-ok");
  check("the journal records it as sent", api.journal()[0].action === "sent");
}

console.log("\n── §3 an unusable reference is re-pinned to what Decart already acknowledged ──");
{
  const PIN = "https://cdn.example/acknowledged.jpg";
  const { api, client, sent, logs } = harness({ pinned: PIN });
  api.instrumentRtClient(client);
  api.setLabel("reconditionForTopology");

  /* The exact shape the old code would have shipped happily. */
  await client.set({ prompt: "P", enhance: false, image: "blob:https://shop.example/9f2c" });

  check("the dispatch still reaches the wire", sent.length === 1);
  check("...but carrying the PINNED reference, not the corrupt one",
    sent[0].p.image === PIN, String(sent[0].p.image));
  check("...with the rest of the payload untouched",
    sent[0].p.prompt === "P" && sent[0].p.enhance === false);
  check("the journal marks it re-pinned", api.journal()[0].action === "re-pinned");
  /* The label is the whole point of the instrumentation: it names the guilty call site in
     a console the user can screenshot. */
  check("...and attributes it to the call site that did it",
    api.journal()[0].label === "reconditionForTopology", api.journal()[0].label);
  check("it is logged at error level, because this would have rendered a wrong garment",
    logs.some((l) => l.level === "error" && /THIS CALL SITE IS THE BUG/.test(l.a.join(" "))));
}

console.log("\n── §4 with nothing to substitute, the dispatch is REFUSED, not sent ──");
{
  const { api, client, sent, logs } = harness({ pinned: null });
  api.instrumentRtClient(client);
  api.setLabel("applyGarment");

  let threw = null;
  try { await client.set({ prompt: "P", enhance: false }); }
  catch (e) { threw = e; }

  /* Sending would replace the model's conditioning with its own prior. Failing the
     dispatch is recoverable - a retry, or a later apply - and a wrong garment is not. */
  check("the real set() is never called", sent.length === 0);
  check("...and the caller is told, rather than silently succeeding", threw !== null);
  check("...with a message naming the call site and the reason",
    threw && /applyGarment/.test(threw.message) && /no image key/.test(threw.message),
    threw && threw.message);
  check("the journal records the refusal", api.journal()[0].action === "REFUSED");
  check("...at error level", logs.some((l) => l.level === "error" && /REFUSED/.test(l.a.join(" "))));
}

console.log("\n── §5 prompt-only writes are journalled but never blocked ──");
{
  /* setPrompt() never touches the reference (session.sendPrompt), so there is nothing to
     validate - but it must still appear, or the sequence a diagnosis is read from has
     holes in it exactly where the flicker fix's prompt-only turns were. */
  const { api, client, sent } = harness({ pinned: null });
  api.instrumentRtClient(client);
  api.setLabel("applyGarment/prompt-only");
  const r = await client.setPrompt("PROMPT", { enhance: false });

  check("setPrompt reaches the wire even with no reference pinned", sent.length === 1);
  check("...and its options are passed through", sent[0].opts.enhance === false);
  check("...returns the SDK's value", r === "prompt-ok");
  check("...and is journalled as prompt-only",
    api.journal()[0].method === "setPrompt" && api.journal()[0].image === "(untouched)");
}

console.log("\n── §6 the wrapper is safe to apply and does not eat the client ──");
{
  const { api, client, sent } = harness({ pinned: null });
  const returned = api.instrumentRtClient(client);
  check("it returns the SAME object (it mutates in place)", returned === client);
  check("...preserving the rest of the SDK surface",
    client.disconnect() === "disconnected" && client.getConnectionState() === "connected" &&
    client.on() === "listener");

  const onceWrapped = client.set;
  api.instrumentRtClient(client);
  check("a second application is a no-op, so a reconnect cannot double-wrap",
    client.set === onceWrapped);

  const good = new Blob(["x"], { type: "image/jpeg" });
  await client.set({ prompt: "P", image: good });
  check("...and one application means one journal entry per call", sent.length === 1);
}

console.log("\n── §7 a rejected send is recorded, and the rejection still propagates ──");
{
  const { api, client } = harness({ pinned: null });
  client.set = async () => { throw new Error("datachannel closed"); };
  api.instrumentRtClient(client);
  api.setLabel("applyLook");

  let threw = null;
  const good = new Blob(["x"], { type: "image/jpeg" });
  try { await client.set({ prompt: "P", image: good }); } catch (e) { threw = e; }

  check("the SDK's own failure is not swallowed", threw && /datachannel closed/.test(threw.message));
  check("...and is journalled, so a diagnosis sees it beside the successful writes",
    api.journal()[0].action === "REJECTED" && /datachannel closed/.test(api.journal()[0].detail));
}

console.log("\n── §8 wiring: applied where the client is created, and reachable from DevTools ──");
{
  const { api } = harness({ pinned: null });
  check("window.__pearWireJournal() is exposed for a live diagnosis",
    typeof api.win.__pearWireJournal === "function");
  check("...and returns an empty list rather than throwing before anything is sent",
    Array.isArray(api.win.__pearWireJournal()) && api.win.__pearWireJournal().length === 0);

  /* The guard is worth nothing if it is not actually attached. Applied at the assignment
     in connectRealtime() so every send path inherits it, including ones not yet written. */
  check("connectRealtime() instruments the client it assigns",
    /instrumentRtClient\(rtClient\);/.test(SRC));
  /* Unconditional on purpose: a typeof guard - correct for the debug-only
     verifyGarmentAsset() wrapper - would let this enforcement silently vanish. */
  check("...unconditionally, not behind a typeof guard that could silently disable it",
    !/typeof instrumentRtClient === "function"/.test(SRC));
  check("sendCondition() attributes each write, so the journal can name the call site",
    /_wireLabel = label;/.test(SRC));

  /* The one call site that produced this shape. All four of its callers sit in a || chain
     ending at the garment pin, so refusing is recoverable where sending is not. */
  check("garmentImageRef() no longer hands blob: URLs to the wire",
    /if \(\/\^blob:\/i\.test\(cdnUrl\)\) \{/.test(SRC) &&
    !/\/\^\(data:\|blob:\)\/i\.test\(cdnUrl\)/.test(SRC),
    "blob: and data: are not equivalent to the SDK - only data: is understood");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
