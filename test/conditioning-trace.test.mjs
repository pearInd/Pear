/* The conditioning trace, and the orientation the prompt finally carries.

   TWO REPORTS, ONE FILE, because the fixes meet in applyGarment()'s dispatch.

   §1-§2 THE TRACE. Reported as "I picked a specific garment and got a generic one." The
   prompt cannot be the cause: imageOnlyPrompt() emits one frozen anchor naming no colour,
   no subtype and no product, and image-first.test.mjs pins that absence. So the reference
   image is not reaching the render - and no existing log could show that, because they all
   describe the WIRE. They prove what was sent and that set() resolved; a resolved set() is
   receipt, not adoption, and the render can carry on unchanged while every line of the
   payload debug group reads correctly. The trace measures the OUTPUT instead, before the
   write and after the model has had time to switch.

   The property that matters most here is that it is actually CALLED. This codebase has
   already shipped a guard that was correct and unreachable - invoked only from a debug
   block that never ran - so §2 asserts the call sites and their ORDER inside applyGarment,
   not merely that the function exists.

   §3-§4 THE ANGLE. buildPrompt() and buildCompositePrompt() both took the frozen
   orientation and threw it away, so every render shipped the FRONT anchor and a shopper
   turning around got the chest print reproduced on their back. The angle now SELECTS
   between frozen anchors rather than appending a clause, and that distinction is the whole
   design: image-first.test.mjs's header records that the tuxedo regression was beaten by
   cutting the TOTAL VOLUME of text competing with the reference image, and that FIX ONE -
   which kept the structural clauses - did not hold. Appending angleClause()'s output here
   would re-open it. Selecting holds volume flat. */
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function lift(signature) {
  const i = APP.indexOf(signature);
  if (i < 0) throw new Error("not found in app.js: " + signature);
  let depth = 0;
  for (let k = APP.indexOf("{", i); k < APP.length; k++) {
    if (APP[k] === "{") depth++;
    else if (APP[k] === "}" && --depth === 0) return APP.slice(i, k + 1);
  }
  throw new Error("unbalanced braces: " + signature);
}

console.log("── §1 THE SIGNATURE SAMPLER ──");
{
  const src = lift("function sampleRenderSignature()");

  /* Drives the REAL sampler against a fake feed. `pixels` is the RGBA the stub canvas
     hands back; `video` controls what the element reports. */
  function sample({ video = { videoWidth: 640 }, pixels = null, throwOn = null }) {
    const N = 8;
    const data = pixels || new Uint8ClampedArray(N * N * 4);
    const doc = {
      createElement: () => ({
        getContext: () => ({
          drawImage() { if (throwOn === "draw") throw new Error("tainted"); },
          getImageData() {
            if (throwOn === "read") { const e = new Error("SecurityError"); e.name = "SecurityError"; throw e; }
            return { data };
          },
        }),
      }),
    };
    return new Function("$", "document", `${src} return sampleRenderSignature();`)(() => video, doc);
  }

  check("no AI element yet: returns null rather than a fabricated signature",
    sample({ video: null }) === null);
  check("element present but no frame decoded (videoWidth 0): null",
    sample({ video: { videoWidth: 0 } }) === null);
  check("tainted canvas on drawImage: null, not a throw into the live apply",
    sample({ throwOn: "draw" }) === null);
  check("tainted canvas on getImageData (cross-origin remote track): null",
    sample({ throwOn: "read" }) === null);

  /* A real signature: left half black, right half white. The hash must split 32/32 and the
     torso band must read as a mid grey, proving both halves of the sampler are wired. */
  const N = 8;
  const split = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      const v = x < N / 2 ? 0 : 255;
      split[o] = split[o + 1] = split[o + 2] = v; split[o + 3] = 255;
    }
  }
  const sig = sample({ pixels: split });
  check("a real frame yields a 64-bit hash", sig && sig.hash.length === 64, sig && sig.hash);
  check("...that tracks image content (half-black/half-white splits 32/32)",
    sig && (sig.hash.match(/1/g) || []).length === 32, sig && sig.hash);
  check("...and a torso colour sampled from the middle band, edges excluded",
    sig && sig.torso.length === 3 && sig.torso[0] > 60 && sig.torso[0] < 200,
    sig && JSON.stringify(sig.torso));

  /* Two different garments must not produce the same reading, or the trace can never
     distinguish "reference landed" from "nothing happened". */
  const flat = (v) => {
    const a = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) { const o = i * 4; a[o] = v[0]; a[o + 1] = v[1]; a[o + 2] = v[2]; a[o + 3] = 255; }
    return a;
  };
  const red = sample({ pixels: flat([200, 30, 30]) });
  const white = sample({ pixels: flat([245, 245, 245]) });
  const dist = Math.round(Math.hypot(
    white.torso[0] - red.torso[0], white.torso[1] - red.torso[1], white.torso[2] - red.torso[2]));
  check("a red garment and a white one are far apart on the torso axis",
    dist > 12, "ΔRGB " + dist + " - must clear the 12 the verdict treats as noise");
}

console.log("\n── §2 IT IS OFF BY DEFAULT, AND IT IS ACTUALLY CALLED ──");
{
  const trace = lift("function traceConditioning(item, imageRef, before)");
  check("the flag follows this file's convention (?cond_trace=1)",
    APP.includes('const COND_TRACE = new URLSearchParams(location.search).get("cond_trace") === "1";'));
  check("it returns immediately unless the flag is on - no canvas work on a normal session",
    /^\s*if \(!COND_TRACE\) return;/m.test(trace), trace.slice(0, 200));
  check("the whole body is try-wrapped: a diagnostic can never break a live apply",
    trace.includes("} catch (_) { /* a diagnostic must never break a live session */ }"));
  check("it waits for the model to switch before sampling again",
    trace.includes("COND_TRACE_SETTLE_MS") &&
    /const COND_TRACE_SETTLE_MS = 1[0-9]{3};/.test(APP),
    "sampling before the render arrives would report a false 'unchanged'");
  check("a missing sample on either side is reported INCONCLUSIVE, never as unchanged",
    trace.includes("if (!before || !after)") && trace.includes("INCONCLUSIVE"),
    "scoring an unreadable feed as 'unchanged' would invent the bug it hunts");

  /* THE CALL SITES. A guard that is never reached is this codebase's own prior bug. */
  const apply = APP.slice(APP.indexOf("if (typeof verifyGarmentAsset === \"function\") verifyGarmentAsset(payload, \"applyGarment\");"),
                          APP.indexOf("if (typeof traceConditioning === \"function\") traceConditioning(item, imageRef, condBefore);") + 200);
  check("the BEFORE sample is taken inside applyGarment, not left to the caller",
    apply.includes('const condBefore = typeof sampleRenderSignature === "function" ? sampleRenderSignature() : null;'),
    apply);
  check("...and it is taken BEFORE the write, or it measures nothing",
    apply.indexOf("condBefore =") < apply.indexOf('await sendCondition("applyGarment"'), apply);
  check("the trace fires AFTER the ack is stamped, so it can report on this reference",
    apply.indexOf("lastAckedImageRef = imageRef;") <
    apply.indexOf("traceConditioning(item, imageRef, condBefore)"), apply);
  check("both call sites are typeof-guarded, like verifyGarmentAsset beside them",
    apply.includes('typeof sampleRenderSignature === "function"') &&
    apply.includes('typeof traceConditioning === "function"'),
    "the sandboxed suites run applyGarment against a fixed global list");
}

console.log("\n── §3 THE ANGLE REACHES THE PROMPT ──");
{
  check("buildPrompt forwards its angle instead of discarding it",
    APP.includes("function buildPrompt(item, angle = \"front\") {\n  return imageOnlyPrompt(item, angle);\n}"),
    "this returned imageOnlyPrompt(item) - the angle was computed and thrown away");
  check("buildCustomPrompt forwards it too - an upload turns around the same way",
    APP.includes("function buildCustomPrompt(item, angle = \"front\") {\n  return imageOnlyPrompt(item, angle);\n}"));
  check("buildCompositePrompt forwards it as well",
    /function buildCompositePrompt\(item, angle, inProfile\)[^\n]*\n  return imageOnlyPrompt\(item, angle\);/.test(APP),
    "composite was angle-blind too - both single-asset and composite renders were affected");
  check("the call site hands over the FROZEN snapshot, not a fresh orientation read",
    APP.includes("buildPrompt(item, angleAtStart)") &&
    APP.includes("buildCompositePrompt(item, angleAtStart, profileAtStart)"),
    "a prompt built from a later read than the image is the mixing bug applyGarment documents");
  check("angleClause() is no longer wired into the single-asset prompt",
    !APP.includes("buildPrompt(item, angleClause("),
    "appending its output is the text-volume increase that re-opens the tuxedo");
}

console.log("\n── §4 SELECTING, NOT APPENDING ──");
{
  const resolver = lift("function imageOnlyPrompt(item, angle = \"front\")");
  check("the resolver picks a frozen anchor set by angle",
    resolver.includes('const anchors = angle === "back" ? BACK_CATEGORY_ANCHOR : CATEGORY_ANCHOR;'), resolver);
  /* Exactly one CORE anchor still ships on every branch - that is the invariant, and it is
     what keeps the angle axis volume-flat. The tops+front branch additionally carries ONE
     bought-back P.HIGH clause (FRONT_CLOSURE_LOCK); P.HIGH matters because fitPrompt()
     sheds it under budget pressure before it would ever touch the anchor. A second CORE,
     or a clause concatenated onto an anchor, still fails. */
  /* Comments stripped before counting: the resolver's own doc block discusses P.CORE and
     P.HIGH by name to explain the shedding order, and a check that trips over the
     explanation would force whoever reads it to delete the documentation. */
  const resolverCode = resolver.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("exactly ONE anchor ships - volume stays flat across the angle axis",
    /\[P\.CORE, plainTee \? PLAIN_TEE_ANCHOR : bottoms \? anchors\.bottom : anchors\.top\],/.test(resolverCode) &&
    (resolverCode.match(/P\.CORE/g) || []).length === 1, resolverCode);
  check("the one bought-back clause rides at P.HIGH, so it sheds before the anchor does",
    (resolverCode.match(/P\.HIGH/g) || []).length === 1 &&
    /\[\[P\.HIGH, FRONT_CLOSURE_LOCK\]\]/.test(resolverCode), resolverCode);
  /* NOW SCOPED THREE WAYS, not two. The closure lock was shipping on plain tees, where
     "buttons / zip / placket" were the only construction words on the wire and the model
     rendered a garment that had them - see PLAIN_TEE_ANCHOR and plain-tee-fidelity.test.mjs.
     Asserted against the CLOSURE LINE specifically rather than anywhere in the function:
     `!bottoms && angle !== "back"` also appears in the plainTee line above it, so a laxer
     pattern would pass while the clause itself had lost a guard. */
  check("...and it is scoped to tops + front + has-a-closure, where one is actually in view",
    /\.\.\.\(closure \? \[\[P\.HIGH, FRONT_CLOSURE_LOCK\]\] : \[\]\)/.test(resolverCode) &&
    /const closure = !bottoms && angle !== "back" && hasFrontClosure\(item\);/.test(resolverCode),
    resolverCode);
  check("nothing is concatenated onto an anchor, front or back",
    !/anchors\.(top|bottom)\s*\+/.test(APP) && !/(BACK_)?CATEGORY_ANCHOR\.(top|bottom)\s*\+/.test(APP),
    "appending one clause is how the dozen came back last time");
  check("the back anchors are frozen, like the front pair",
    /const BACK_CATEGORY_ANCHOR = Object\.freeze\(\{/.test(APP));
  check("the back anchor adds the rear-print lock, the one thing a back render needs",
    /Precisely lock the[\s\S]{0,40}rear print, logos, and back seams/.test(APP));
  check("an unrecognised angle resolves to FRONT, never to a silent back-render",
    resolver.includes('angle === "back"'),
    "a truthiness test would send any non-empty string to the back anchor");
}

console.log(fails ? `\n${fails} FAILING` : "\nall green");
process.exit(fails ? 1 : 0);
