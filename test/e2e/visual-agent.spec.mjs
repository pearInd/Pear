/* =============================================================================
   PEAR - autonomous visual agent: the 360 and the re-fit, screenshotted
   -----------------------------------------------------------------------------
   WHAT THIS IS FOR. Every rule in CLAUDE.md §2 was written after a shopper
   reported something they SAW: a back that rendered plain, a front print on the
   back, a white flash, a 1-2 second freeze on every swap. The unit suite proves
   the decisions that lead to those renders; nothing until now looked at the
   render. This drives a real session end to end and writes the frames to disk so
   `scripts/inspect-visuals.mjs` can score them.

   IT COSTS NOTHING, and that is enforced rather than assumed:
     · ?mock_decart=1 replaces the SDK and the token mint (fitting-room/app.js),
       so no ek_ token is minted and no WebRTC session is opened;
     · the harness server counts every hit on /api/realtime-token and the last
       assertion in this file is that the count is zero.

   THE ORIENTATION IS SCRIPTED, THE RESPONSE TO IT IS NOT. window.__pearMockPose
   moves the shopper; everything that reads the shopper - the yaw window, the
   anti-flap lock, maybeSwap(), applyActive(), the dispatch - is the shipped code.
   So a failure here is a failure in the room, not in the driver.

   WHAT EACH CAPTURE IS EVIDENCE OF:
     00-front       the garment is on, and it is the FRONT asset            (§2.1)
     01-profile     at 90 degrees the session is still live and still dressed
     02-back        the BACK asset reached the wire - not the front again   (§2.1/§2.2)
     03-return      a full 360 comes home; the front is restored
     burst-*        consecutive frames THROUGH the turn: no white flash, no freeze
                                                                           (§2.9)
   Nothing is asserted about pixels here on purpose. This file's job is to produce
   honest evidence; scoring it is the inspector's job, and keeping the two apart is
   what stops a capture bug from being papered over by a lenient assertion written
   in the same breath.
   ============================================================================= */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./static-server.mjs";
import { ensureFixtures, GARMENT_DIR } from "./fixtures.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = join(ROOT, "test-results", "visual");

let server;

test.beforeAll(async () => {
  ensureFixtures({ log: () => {} });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  server = await startStaticServer();
});

test.afterAll(async () => { await server?.close(); });

/* The room narrates its whole go-live sequence through console.log("[PEAR] …") - that
   prefix is the debugging contract with live merchants (CLAUDE.md §6) and it is the most
   useful thing on screen when this suite fails. Printed on ANY failure, not just the ones
   routed through until(): a plain expect() that times out (say, Screen 1 never advancing)
   otherwise reports only which class was missing, which is the one thing that does not
   say why. */
let transcriptOf = () => [];
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const lines = transcriptOf();
  console.log(`\n── [PEAR] transcript (last 40 of ${lines.length}) ─────────────────────────`);
  for (const l of lines.slice(-40)) console.log("   " + l);
  console.log("──────────────────────────────────────────────────────────────────\n");
});

/* The room's own deep-link contract (parseHandoff): a front photo, a distinct back
   photo, a category and a name. A distinct back is what makes canCombineViews() true
   and puts the session in AI Auto - the only mode in which a turn swaps the asset. */
function roomUrl(base) {
  const q = new URLSearchParams({
    pear_demo: "1",        // skip the identity/OTP gate - not what this suite tests
    mock_decart: "1",      // the mock SDK + the scripted pose sensor
    /* The real session is hard-capped at 5s (LIVE_DURATION_MS) because that is the
       BILLED window. Nothing is billed here, and a 5s wall clock is not enough to both
       perform a 360 and photograph it - so the window is widened, which liveWindowMs()
       permits ONLY under mock_decart=1. The turn itself still runs at a realistic
       72-90 deg/s; what the extra time buys is the screenshots, not an easier turn. */
    mock_live_ms: "90000",
    /* Overridable so the gate can be pointed at a KNOWN-BAD pair and watched to fail -
       the only way to find out whether a green run means anything. Pointing the front at
       plain.png must trip plain-shirt-gap; pointing both halves at the same print must
       trip missing-back-print. A gate nobody has seen fail is a gate nobody should trust. */
    garment_url: `${base}/test/fixtures/garment/${process.env.PEAR_VISUAL_FRONT || "front.png"}`,
    garment_url_back: `${base}/test/fixtures/garment/${process.env.PEAR_VISUAL_BACK || "back.png"}`,
    garment_type: "tops",
    garment_name: "Harness Tee",
  });
  /* DECART'S OWN PRIOR, REPRODUCED - the third negative control, and the only one that
     covers the START of a session rather than a turn.

     THE REPORT IT MAKES TESTABLE (448abc6, "wrong garment at 00:00", the fifth recording
     of it): between set_image_ack and Decart's render actually switching to the new
     reference, the model keeps drawing from its own prior - a garment nobody picked, on
     the shopper, for 780-1100ms measured. It reads as the selected garment distorting or
     being replaced at 00:00. It is NOT a local gesture, a warp or an overlay; nothing in
     this room draws on the body (the only transform on #aiVideo is the selfie scaleX(-1)).

     mockPriorMs() paints that prior into the torso for <ms> after every image ack, so the
     question "does the reveal ever land on it" becomes decidable here instead of needing a
     billed session and a lucky recording. REFERENCE_RENDER_SETTLE_MS (1200) is the gate
     that must beat it, so a value at or above that is the interesting one.

     OFF UNLESS ASKED, and deliberately not a default: with no env var nothing is appended
     and the standard run's URL is byte-identical to what it was before this existed, so
     the mandatory gate is unchanged. Same contract as PEAR_VISUAL_FRONT/BACK above.

       PEAR_VISUAL_PRIOR_MS=1500 npm run test:visual && npm run inspect:visuals
         -> must stay green: the reveal waited the prior out
         -> plain-shirt-gap / white-flash on 00-front means it revealed onto the prior */
  if (process.env.PEAR_VISUAL_PRIOR_MS) q.set("mock_prior_ms", process.env.PEAR_VISUAL_PRIOR_MS);
  /* THE CONTROL'S OWN CONTROL. ?settle_hold=0 is the room's documented A/B switch for the
     reveal settle that 448abc6 added (REFERENCE_RENDER_SETTLE_MS). With the prior on and
     the settle off, revealed-on-prior MUST fire - that is what proves the check is wired
     to something real rather than passing because it never looks. Off unless asked. */
  if (process.env.PEAR_VISUAL_SETTLE_HOLD) q.set("settle_hold", process.env.PEAR_VISUAL_SETTLE_HOLD);
  return `${base}/fitting-room/index.html?${q}`;
}

/** Poll a page predicate until it holds. Plain polling rather than expect.poll so the
 *  failure message can say what the wire actually looked like when it gave up. */
async function until(page, label, fn, timeoutMs = 30_000, arg = undefined) {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() - started > timeoutMs) {
      /* The room narrates its own go-live sequence through console.log("[PEAR] …") -
         that prefix is the debugging contract with live merchants (CLAUDE.md §6), and it
         is just as useful here. Without the tail of it, a stalled gate is indistinguishable
         from any other stalled gate: the wire state below says "not connected" for the
         black-screen gate, the presence gate and the asset preload gate alike. */
      const tail = (page.__pearTranscript || []).slice(-25).join("\n      ");
      const wire = await page.evaluate(() => ({
        state: window.__pearMockDecart?.connectionState,
        frames: window.__pearMockDecart?.frames,
        dispatches: window.__pearMockDecart?.dispatches?.length,
        // the prompt trimmed: a full anchor is 500+ chars and buries the diagnosis
        wire: { ...(window.__pearMockDecart?.wire || {}),
                prompt: (window.__pearMockDecart?.wire?.prompt || "").slice(0, 90) + "…" },
        angle: window.__pearMockPose?.angle,
        cardClasses: document.getElementById("cameraCard")?.className,
        scanHidden: document.getElementById("scanOverlay")?.hidden,
      }));
      throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms.\n` +
        `    Wire: ${JSON.stringify(wire)}\n` +
        `    Last [PEAR] lines:\n      ${tail}`);
    }
    await page.waitForTimeout(120);
  }
}

test("360 turn and re-fit render without gaps, flashes or freezes", async ({ page }) => {
  const shots = [];
  /* ── THREE BUCKETS, NOT ONE, and only two of them can fail a run ──────────────
     The first cut of this recorded every console error and failed on all of them.
     In this harness that is pure noise: the stub server implements three routes and
     404s the rest by design, and the page also reaches real CDNs (MediaPipe, fonts)
     that answer 429 under repeated runs. A gate that cries about its own scaffolding
     is a gate people stop reading - the same failure mode CLAUDE.md §6 describes for
     a warning channel nobody trusts.

     So: an UNCAUGHT EXCEPTION is always a failure (the room's code broke), and a
     [PEAR] CRITICAL line is always a failure (the repo's own escalation convention -
     a failed asset fetch after every retry says exactly that). Everything else is
     recorded into the evidence file for a human reading a failure, and gates nothing. */
  const pageErrors = [];
  const criticalLogs = [];
  const consoleNoise = [];
  page.__pearTranscript = [];
  transcriptOf = () => page.__pearTranscript;
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[PEAR]") || t.startsWith("[PEAR][MOCK]") || t.startsWith("[go-live]")) {
      page.__pearTranscript.push(t.slice(0, 160));
    }
    if (/\bCRITICAL\b/.test(t)) criticalLogs.push(t);
    else if (m.type() === "error") consoleNoise.push(t);
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  /** Screenshot the camera card - NOT #aiVideo alone. Every overlay this suite is
   *  hunting (a snapshot cover, a reveal scrim, a presence prompt) is a SIBLING of the
   *  video; shooting the video element would frame them out of the evidence. */
  async function shoot(name, angle) {
    const file = join(OUT, `${name}.png`);
    /* ── DO NOT ADD animations: "disabled" HERE. IT WAS TRIED, AND IT BROKE THE
       FROZEN-FEED CHECK ────────────────────────────────────────────────────────────
       It looks like the obvious fix for a screenshot that stalls on an element which
       is never visually stable (#cameraCard carries a reveal animation, a pulsing live
       badge and a ticking countdown). It is not. With it set, every consecutive pair in
       the burst came back PIXEL-IDENTICAL - mean diff 0.000 - and the suite reported
       frozen-feed on a session that was rendering perfectly. Whatever it does to hold
       the page still for the capture, it holds the video with it, which disables
       precisely the regression this suite exists to catch (CLAUDE.md §2.9).

       The stall it was meant to fix had a different cause and is fixed at the source:
       the headless renderer was being throttled as an occluded window, which stalled
       every loop on the page at once - see the launch flags in playwright.config.mjs.

       The explicit timeout stays: a capture that cannot complete should fail in 20s
       naming the frame, not eat the whole test budget and surface as "the room never
       went live". */
    await page.locator("#cameraCard").screenshot({ path: file, timeout: 20_000 });
    const wire = await page.evaluate(() => ({ ...window.__pearMockDecart.wire }));
    shots.push({ name, file: `${name}.png`, angle, wire, at: Date.now() });
    return file;
  }

  /* ── SEAL THE PAGE OFF THE PUBLIC INTERNET ────────────────────────────────────
     THE BUG THIS CLOSES: this suite ran green in ~24s a dozen times, then started
     taking 8+ minutes and timing out - at 2% CPU, i.e. blocked on I/O the whole time.
     The room pulls fonts and (in a normal session) the MediaPipe runtime from public
     CDNs, and after enough runs those answer 429 or simply hang. Nothing about that is
     the code under test, but it is enough to fail the gate - and a mandatory gate that
     fails for reasons the committer did not cause is a gate that gets skipped.

     So: every request that is not same-origin is aborted. The harness now depends on
     exactly one host, the one it started itself. The blocked hosts are recorded in
     meta.json rather than dropped silently, because "the room tried to reach the
     network mid-session" is worth being able to see - and if a future change makes the
     room genuinely REQUIRE an external asset, this list is where that shows up.

     It also removes the last way this run could cost anything.

     THE MATCHER IS A PREDICATE, NOT A CATCH-ALL GLOB, and that is a second bug fixed on
     top of the first. Routing every URL and calling continue() on the same-origin ones sends
     each of them - app.js at 1.3MB, style.css at 266KB, every image - out to the test
     process and back before the browser sees a byte. It worked, but it turned a 34s run
     into anything from 34s to several minutes depending on machine load, and a
     MANDATORY gate that is sometimes slow enough to hit its own timeout is a flaky gate,
     which is worse than no gate at all. A predicate that matches only off-origin URLs
     leaves same-origin traffic entirely alone: Playwright never intercepts what the
     matcher does not select. */
  const blockedHosts = new Set();
  await page.route(
    (url) => url.origin !== server.url && url.protocol !== "data:" && url.protocol !== "blob:",
    (route) => {
      blockedHosts.add(new URL(route.request().url()).host);
      return route.abort();
    },
  );

  await page.goto(roomUrl(server.url), { waitUntil: "domcontentloaded" });

  /* ── Screen 1: measurements ─────────────────────────────────────────────── */
  /* Cookie banner first, through its real button: it is fixed to the bottom of the
     viewport, so left up it would sit over the camera card in every capture and be
     scored as part of the frame. */
  await page.locator("#cookieAcceptAll").click();
  await expect(page.locator("#cookieBanner")).toBeHidden({ timeout: 5_000 });
  await page.locator("#height").fill("178");
  await page.locator("#weight").fill("74");
  /* The terms consent gates Continue (aria-disabled, which Playwright treats as
     disabled). One box since 2026-09-19 - it also carries the measurement-processing
     consent the retired second box asked for. Ticked the way a shopper ticks it - no
     storage seeding - so the gate itself stays under test. */
  await page.locator("#consentTerms").check();
  await page.locator("#btn-next-screen").click();
  await expect(page.locator("#screen-fitting")).toHaveClass(/active/, { timeout: 20_000 });

  /* ── camera, then go live ───────────────────────────────────────────────── */
  await page.locator("#startCamBtn").click();
  await expect(page.locator("#captureBtn")).toBeEnabled({ timeout: 30_000 });
  await page.locator("#captureBtn").click();

  /* The session is OPEN once the mock reports connected; it is DRESSED once a
     reference has been dispatched AND decoded. Screenshotting between the two is how
     a harness convinces itself an undressed passthrough frame is a garment. */
  await until(page, "the mock session to report connected",
    () => window.__pearMockDecart?.connectionState === "connected");
  await until(page, "a decoded garment reference on the wire",
    () => !!window.__pearMockDecart?.wire?.imageKey && window.__pearMockDecart.wire.decoded === true);

  /* ── AND THE REVEAL. This wait is the difference between a real visual gate and a
     decorative one.

     Until Model Ready the room deliberately holds #aiVideo at opacity 0 behind
     #scanOverlay (gateAiFeed / startBillingWindow) - so a screenshot taken any earlier
     photographs a 34%-opaque scrim and a blurred placeholder, NOT the render. The first
     version of this spec did exactly that, and every pixel check passed: the scrim has
     plenty of texture and plenty of hue, so "the torso carries detail" and "front differs
     from back" were both satisfied by an animation. A gate that green-lights a push on
     the strength of its own loading spinner is worse than no gate.

     .show-live is added in the same statement that hides the overlay, at the first frame
     VERIFIED as AI-rendered rather than forwarded camera - so waiting on it is waiting on
     the room's own proof that what is on screen came from the wire. */
  /* 90s, not the 30s default, and the reason is in the transcript of the runs that made
     it necessary: they ended on "[PEAR] First verified AI frame - billing + 5s capture
     started", which is logged BY THE SAME FUNCTION that hides the overlay and adds
     .show-live. The reveal was not failing - it was arriving late. armFirstFrameBilling()
     will not reveal until it has verified a frame as genuinely AI-rendered rather than
     forwarded camera, and that verification watches real frames arrive over real time;
     headless, on a loaded machine, it can take well over half a minute.
     This is a wait for an event that does happen, so the only thing a short timeout buys
     is a false failure. It is not a quality threshold and it is not in the same category
     as anything in scripts/inspect-visuals.mjs. */
  await until(page, "the AI feed to be revealed (.show-live, scan overlay down)",
    () => document.getElementById("cameraCard")?.classList.contains("show-live") === true &&
          document.getElementById("scanOverlay")?.hidden === true, 90_000);

  const frontKey = await page.evaluate(() => window.__pearMockDecart.wire.imageKey);
  await shoot("00-front", 0);

  /* ── 90 degrees: edge-on, still live, still dressed ─────────────────────── */
  await page.evaluate(() => window.__pearMockPose.sweep(90, 120));
  await until(page, "the pose sensor to reach 90 degrees",
    () => window.__pearMockPose.angle >= 89.5);
  await page.waitForTimeout(800);            // let the watcher settle on the reading
  await shoot("01-profile", 90);

  /* ── 90 -> 180, captured as a BURST ─────────────────────────────────────────
     The turn is where the swap happens, and the swap is where all three moving-image
     regressions live. One frame either side of it proves nothing; a run of frames
     through it is the only evidence that can show a flash or a freeze. */
  const burst = [];
  const sweeping = page.evaluate(() => window.__pearMockPose.sweep(180, 90));
  for (let i = 0; i < 10; i++) {
    burst.push(await shoot(`burst-${String(i).padStart(2, "0")}`,
      await page.evaluate(() => window.__pearMockPose.angle)));
    await page.waitForTimeout(160);
  }
  await sweeping;

  /* THE ASSET MUST ACTUALLY CHANGE. This is the print-less back bug's signature: the
     shopper is at 180 and the FRONT photo is still the reference. Waiting on the key to
     move (rather than sleeping and hoping) means a slow-but-correct swap passes and a
     swap that never happens fails with the front key named in the message. */
  await until(page, "the BACK asset to reach the wire",
    (k) => window.__pearMockDecart?.wire?.imageKey && window.__pearMockDecart.wire.imageKey !== k,
    45_000, frontKey);
  await page.waitForTimeout(600);
  const backKey = await page.evaluate(() => window.__pearMockDecart.wire.imageKey);
  await shoot("02-back", 180);

  /* ── and home again: 180 -> 360, which is 0 ─────────────────────────────── */
  await page.evaluate(() => window.__pearMockPose.setAngle(180));
  await page.evaluate(() => window.__pearMockPose.sweep(360, 90));
  await until(page, "the pose sensor to complete the revolution",
    () => window.__pearMockPose.angle >= 359.5);
  await until(page, "the FRONT asset to return after a full 360",
    (k) => window.__pearMockDecart?.wire?.imageKey === k, 45_000, frontKey);
  await shoot("03-return-front", 360);

  /* ── the evidence file ──────────────────────────────────────────────────────
     Geometry comes from the page rather than from a copy in the inspector: the mock
     draws the torso patch from MOCK_GEOMETRY, and a second set of numbers that drifted
     would have the inspector scoring the wrong pixels while reporting confidently. */
  const geometry = await page.evaluate(() => window.__pearMockDecart.geometry);
  const dispatches = await page.evaluate(() => window.__pearMockDecart.dispatches);
  const frames = await page.evaluate(() => window.__pearMockDecart.frames);
  /* WHEN THE PRIOR WAS ON SCREEN (?mock_prior_ms only; both are empty/0 otherwise).
     The mock already recorded this and nothing read it, so a run with the prior enabled
     was scored by checks that cannot see it: the prior is a MULTICOLOR pattern, so it
     clears plain-shirt-gap's flat-fill bar, and it is neither wire key, so it clears
     missing-back-print. Carrying the timestamps out is what makes "the reveal landed on
     a garment nobody picked" a measurement instead of a screenshot someone has to squint
     at. Scored by the revealed-on-prior check in inspect-visuals.mjs. */
  const priorFrames = await page.evaluate(() => window.__pearMockDecart.priorFrames);
  const priorPaintedAt = await page.evaluate(() => window.__pearMockDecart.priorPaintedAt);

  writeFileSync(join(OUT, "meta.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    geometry,
    frames,
    dispatches,
    priorFrames,
    priorPaintedAt,
    pageErrors,
    criticalLogs,
    consoleNoise,
    blockedHosts: [...blockedHosts].sort(),
    tokenMintAttempts: server.tokenMintAttempts(),
    keys: {
      front: frontKey,
      back: backKey,
      frontBytes: statSync(join(GARMENT_DIR, "front.png")).size,
      backBytes: statSync(join(GARMENT_DIR, "back.png")).size,
    },
    shots,
    burst: burst.length,
  }, null, 2));

  /* ── the two things this file asserts itself ────────────────────────────────
     Both are about the HARNESS's own integrity, not about the render - scoring the
     render is scripts/inspect-visuals.mjs's job. */

  // 1. The turn actually moved the asset. If front and back are the same key, every
  //    pixel check downstream is comparing a photo with itself and cannot fail.
  expect(backKey, "the back dispatch carried the same asset as the front - " +
    "either the swap never happened or distinctBackOf() rejected the back photo")
    .not.toBe(frontKey);

  // 2. Nothing was billed. ?mock_decart=1 is supposed to short-circuit above the mint.
  expect(server.tokenMintAttempts(),
    "the session reached /api/realtime-token - this run was NOT free")
    .toBe(0);
});
