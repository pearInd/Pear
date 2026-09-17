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

   NO RETRIES, deliberately. A flaky visual check is a broken visual check, and a
   retry would hide exactly the intermittent freeze/flash this suite is for.
   ============================================================================= */
import { defineConfig } from "@playwright/test";
import { ensureFixtures, VIDEO_PATH } from "./test/e2e/fixtures.mjs";

ensureFixtures({ log: () => {} });

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,          // one camera, one session, one deterministic turn
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  outputDir: "test-results",
  use: {
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
      ],
    },
  },
});
