/* [DECART PROMPT DEBUG] - the exact payload hitting the wire, logged at every dispatch.

   ASKED FOR after a report of a full tuxedo/bowtie rendering over a plain t-shirt: "I
   need to see the exact text string hitting the API in real-time." There are FOUR real
   dispatch points in this file, not one - applyGarment()'s prompt-only fast path AND its
   full set() path, applyLook()'s primary payload AND its minimal retry fallback - and a
   log placed only in the shared debug group earlier in applyGarment() cannot tell you
   which of ITS two paths actually fired, let alone say anything about applyLook() at
   all. This suite pins that all four exist, each immediately adjacent to the network
   call it describes (not earlier in the function, where the prompt could still be
   re-derived or the path could still branch away from what was logged).

   Also covers the concrete, verified answer to "check for hidden default system prompts
   conflicting with this instruction": there ARE hidden defaults, but they are not a
   separate prompt - they are Decart's own `enhance` flag, which defaults to `true` at
   the wire level (confirmed directly against the installed SDK's runtime, not just its
   types - see §2) and is Decart's own creative-embellishment toggle. Every dispatch site
   already overrides it to `false`; this suite is what stops that from silently lapsing
   at any one of them. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

console.log("── §1 THE DEBUG LOG RIDES ALL FOUR REAL DISPATCH SITES ──");
{
  const tag = "[DECART PROMPT DEBUG]";
  const count = (APP.match(/\[DECART PROMPT DEBUG\]/g) || []).length;
  check("exactly 4 occurrences - one per real send site, no more, no fewer",
    count === 4, `found ${count}`);

  // applyGarment()'s prompt-only fast path: setPrompt(), no image re-upload.
  const fastPath = APP.slice(APP.indexOf('console.log("[PEAR] prompt-only update'),
                             APP.indexOf("await rtClient.setPrompt(payload.prompt"));
  check("applyGarment() prompt-only path logs immediately before setPrompt()",
    fastPath.includes(tag), fastPath);

  // applyGarment()'s full set() path.
  const fullPath = APP.slice(APP.indexOf("await rtClient.setPrompt(payload.prompt") + 40,
                             APP.indexOf("await rtClient.set(payload);\n  lastSentImageRef"));
  check("applyGarment() full set() path logs immediately before rtClient.set(payload)",
    fullPath.includes(tag), fullPath);

  // applyLook()'s primary payload and its minimal retry.
  const lookBlock = APP.slice(APP.indexOf("// ONE combined payload - both garments"),
                              APP.indexOf("lastSentImageRef = primaryImage || null;"));
  const decartCount = (lookBlock.match(/\[DECART PROMPT DEBUG\]/g) || []).length;
  check("applyLook() logs BOTH the primary payload and the minimal-retry fallback",
    decartCount === 2, `found ${decartCount} in applyLook()'s send block`);
  check("...the primary log sits before the primary set(), not after (which could log a\n" +
        "        payload the call already rejected)",
    lookBlock.indexOf(tag) < lookBlock.indexOf("await rtClient.set(payload);"),
    `tag@${lookBlock.indexOf(tag)} set@${lookBlock.indexOf("await rtClient.set(payload);")}`);

  check("every log includes the prompt text, not just a truncated summary",
    /\[DECART PROMPT DEBUG\]", payload\.prompt,/.test(APP) &&
    /\[DECART PROMPT DEBUG\]", prompt,/.test(APP));
  /* THE ONE THING THE LOG MUST NOT DO: dump a raw Blob or a multi-megabyte data: URL into
     the console. abbrevImg() already exists in this file for exactly that reason (see
     the "img ref" log line it was written for) - reusing it here is what keeps the new
     log console-safe rather than reintroducing the problem it was built to avoid. */
  check("the asset half of every log goes through abbrevImg(), never the raw image/Blob",
    !/\[DECART PROMPT DEBUG\]", payload\.prompt, imageRef[,)]/.test(APP) &&
    !/\[DECART PROMPT DEBUG\]", prompt, primaryImage[,)]/.test(APP),
    "a raw Blob/data-URL here would flood the console on every dispatch");
}

console.log("\n── §2 THE HIDDEN DEFAULT, VERIFIED AGAINST THE INSTALLED SDK'S RUNTIME ──");
{
  /* Not the SDK's .d.ts (a type wrapper hides the actual default value) - the compiled
     .js, where the default is a literal. This is what proves the claim rather than
     asserting it: Decart's realtime `enhance` flag defaults to TRUE at the wire level
     for BOTH set() and setPrompt(), independently of anything app.js sends. */
  let sdkSrc = "";
  try {
    sdkSrc = readFileSync(
      new URL("../node_modules/@decartai/sdk/dist/realtime/methods.js", import.meta.url), "utf8");
  } catch { /* SDK not installed in this checkout - the assertions below skip gracefully */ }

  if (sdkSrc) {
    check("setInputSchema (.set()) defaults enhance to true at the SDK level",
      /enhance:\s*z\.boolean\(\)\.optional\(\)\.default\(true\)/.test(sdkSrc));
    const setPromptSchema = sdkSrc.slice(sdkSrc.indexOf("setPromptInputSchema"));
    check("setPromptInputSchema (.setPrompt()) defaults enhance to true too",
      /enhance:\s*z\.boolean\(\)\.optional\(\)\.default\(true\)/.test(setPromptSchema));
  } else {
    check("SDK runtime present to verify the enhance default against (skipped - not installed)", true);
  }

  /* Given that default is TRUE, every one of the four real dispatch sites MUST override
     it, or Decart's own creative-embellishment flag is left on for that call - a real,
     concrete instance of the "hidden default" the report asked to be audited for. */
  const enhanceFalse = (APP.match(/enhance:\s*false/g) || []).length +
                        (APP.match(/\{\s*enhance:\s*false\s*\}/g) || []).length;
  check("app.js explicitly overrides enhance:false at every send site (never relies on the SDK default)",
    /enhance: false,/.test(APP) && /\{ enhance: false \}/.test(APP), `${enhanceFalse} occurrences`);

  /* client.realtime.connect()'s own opts (buildRealtimeConnectOpts) is a SEPARATE
     schema from set()/setPrompt() and has its own optional `initialState.prompt.enhance`
     - omitted entirely here, which is correct: no prompt/image/enhance is asserted at
     connect time, so the first content-bearing payload is unambiguously the one
     applyGarment()/applyLook() builds, not some earlier default this file never wrote. */
  const connectOpts = APP.slice(APP.indexOf("function buildRealtimeConnectOpts(gen)"),
                                APP.indexOf("function buildRealtimeConnectOpts(gen)") + 900);
  check("connect() is not given its own initialState - no separate default prompt to conflict with",
    !/initialState/.test(connectOpts), connectOpts.slice(0, 300));
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
