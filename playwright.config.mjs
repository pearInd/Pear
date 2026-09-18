/* =============================================================================
   PEAR - visual QA harness config
   -----------------------------------------------------------------------------
   Everything here exists to make a fitting-room session reproducible without a
   webcam, without a person, and without a Decart bill.

   THE FAKE CAMERA IS A LAUNCH ARGUMENT, not a context option, and that is not a
   style choice: --use-file-for-fake-video-capture is read once when Chromium
   starts, so it cannot be set per test. The file it names must therefore exist
   BEFORE the browser launches - test/e2e/fixtures.mjs is imported here, at config
   load, rather than from a fixture hook, so a fresh clone with no test/fixtures/
   directory still launches with a real clip behind getUserMedia instead of
   Chromium's silent fallback to its own rolling-green test pattern (which would
   quietly pass the black-screen gate and make every colour assertion meaningless).

   HEADLESS IS THE DEFAULT AND MUST STAY WORKING. A visual gate that only passes
   with a visible window is a gate nobody runs on a server. PWDEBUG=1 or
   `--headed` still work for a human watching a turn happen.

   ONE RETRY, AND THE LINE IT MUST NOT CROSS. The retry covers the AGENT failing to
   complete a capture set - a browser that did not come up, a session that never went
   live, a screenshot that stalled. Those are harness faults, they fail closed, and
   about one run in six hit one even after the throttling and compositing fixes below;
   a mandatory gate that cries wolf at that rate is a gate people stop running.

   It does NOT cover the render. scripts/inspect-visuals.mjs is a separate process, it
   runs once, it never retries, and it scores whatever frames the completed run
   produced. So an intermittent freeze or flash still has to survive inspection - the
   retry cannot launder a bad frame into a pass, because the retry happens before
   anything has been scored.
   ============================================================================= */
import { defineConfig } from "@playwright/test";
import { ensureFixtures, VIDEO_PATH } from "./test/e2e/fixtures.mjs";

ensureFixtures({ log: () => {} });

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,          // one camera, one session, one deterministic turn
  workers: 1,
  retries: 1,
  /* The agent's wall-clock budget for ONE browser session - not a quality threshold, and
     not in the same category as the numbers in scripts/inspect-visuals.mjs (those decide
     pass/fail on the render and must never be loosened to go green; this one only decides
     how long we are willing to wait for a browser).

     240s is deliberate headroom over the ~35-90s a healthy run takes. The spread is real:
     the return leg of the 360 waits on the room's own anti-flap confirmation, which is
     frame-counted rather than time-boxed, so it costs whatever the machine's frame rate
     costs that minute. At 120s the suite passed on an idle laptop and timed out on a busy
     one - which is the flaky-gate failure mode that gets a mandatory check switched off.
     The per-wait timeouts inside the spec (30s, 45s) are the ones that produce a USEFUL
     diagnosis; this is only the backstop behind them. */
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  outputDir: "test-results",
  use: {
    /* ── DO NOT SET channel: "chromium" HERE. IT WAS TRIED, AND IT BLINDS THE
       FROZEN-FEED CHECK ───────────────────────────────────────────────────────────
       The default for `headless: true` is chromium-headless-shell, and switching to the
       full browser looks like the safer choice for a suite that leans this hard on media.
       In practice it silently broke the evidence: with it set, consecutive burst captures
       came back near-identical (mean diff ~0.03) while the mock was demonstrably
       rendering at ~9.5fps and the captures were ~1.9s apart - i.e. about eighteen frames
       should have separated them. The video is composited on its own layer and the
       screenshot path in that configuration returns a stale one, so every frame looked
       frozen and the suite reported the §2.9 regression on a perfectly healthy session.

       The instability it was reached for had a different cause and is fixed below, at the
       source: the renderer was being throttled as an occluded window. */
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    permissions: ["camera"],
    // Screenshots are taken explicitly by the spec; these only cover a crash.
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        // no permission prompt, no real device, and a known clip behind getUserMedia
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${VIDEO_PATH}`,
        // autoplay: #aiVideo and the room's samplers all call play() on muted video,
        // but a headless policy block would surface as a frozen feed and read as the
        // very regression this suite reports on.
        "--autoplay-policy=no-user-gesture-required",
        /* ── NEVER LET CHROMIUM THROTTLE THIS PAGE ────────────────────────────────
           A headless window counts as occluded, and an occluded renderer gets its
           timers and requestAnimationFrame throttled hard. Everything this suite
           depends on is a loop: the mock's canvas render loop, the room's pose
           sampler, the recorder's rAF paint loop, and Playwright's own screenshot
           stability check (two consecutive frames with the same box). Throttled,
           they all stall together - which showed up as the room's LIVE CONTINUITY
           bridge firing ("Decart output back after 500ms"), screenshots timing out,
           and a turn taking 90s to settle. The page is never actually visible to
           anyone, so there is nothing to save power for. */
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-background-timer-throttling",
        "--disable-features=CalculateNativeWinOcclusion",
        /* Software compositing, so a screenshot sees the CURRENT video frame. With GPU
           compositing on, #aiVideo lives on its own accelerated layer and the capture
           path returns a stale copy of it - consecutive burst frames came back
           near-identical while the mock was demonstrably rendering, which reads as the
           frozen-feed regression on a healthy session. There is no display here and
           nothing to accelerate for; correctness of the capture is the whole point. */
        "--disable-gpu",
        "--disable-gpu-compositing",
      ],
    },
  },
});
