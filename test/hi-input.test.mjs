/* THE ENGINE SEES THE BODY (2026-10-12, TEST sessions only) - the render input 896x504 from a 1280x720 camera.
   "When I turn 90 degrees it must not guess whether I have a belly." The model works at 1088x624; 512x288 left a
   full-length shopper ~160px tall. §1 the size on literals, §2 the wiring, §3 a shopper's path unchanged. */
import { readFileSync } from "node:fs";
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const i = APP.indexOf("const LIVE_HI_W"), j = APP.indexOf("\n}\n", i);
const BLOCK = APP.slice(i, j + 3);
const make = (search, test) => new Function("location", "traceEnabled", "LIVE_W", "LIVE_H", BLOCK + "\nreturn liveInputSize;")(
  { search }, () => test, 512, 288)();
console.log("\n── §1 the size ──");
check("§1.1 a TEST session: 896x504 to the engine, the camera asked for 1280x720",
  JSON.stringify(make("", true)) === JSON.stringify({ w: 896, h: 504, camW: 1280, camH: 720 }), JSON.stringify(make("", true)));
check("§1.2 a shopper: 512x288 and the camera as before", JSON.stringify(make("", false)) === JSON.stringify({ w: 512, h: 288, camW: 512, camH: 288 }));
check("§1.3 ?hi_input=0 is the old size in a TEST session too", make("?hi_input=0", true).w === 512);
check("§1.4 under 960 wide (two simulcast layers) and 16:9", 896 < 960 && Math.abs(896 / 504 - 16 / 9) < 0.01);
console.log("\n── §2 the wiring ──");
check("§2.1 the desktop camera constraint reads it (typeof-guarded)",
  /const sz = typeof liveInputSize === "function" \? liveInputSize\(\) : \{ camW: LIVE_W, camH: LIVE_H \};\n\s*video\.width  = \{ ideal: sz\.camW \};\n\s*video\.height = \{ ideal: sz\.camH \};/.test(APP));
check("§2.2 the throttle that feeds the engine reads it",
  /const inSize = typeof liveInputSize === "function" \? liveInputSize\(\) : \{ w: LIVE_W, h: LIVE_H \};\n\s*inputThrottle = createThrottledInputStream\(camClone, \{\n\s*fps: LIVE_INFERENCE_FPS, width: inSize\.w, height: inSize\.h,/.test(APP));
check("§2.3 ...and the connect options agree with it", /width: typeof liveInputSize === "function" \? liveInputSize\(\)\.w : LIVE_W,/.test(APP) &&
  /height: typeof liveInputSize === "function" \? liveInputSize\(\)\.h : LIVE_H,/.test(APP));
console.log("\n── §3 the shopper's constants ──");
check("§3.1 LIVE_W / LIVE_H are still 512x288 (what every shopper's session sends)", /const LIVE_W = 512, LIVE_H = 288;/.test(APP));
console.log(fails === 0 ? "\nhi-input: OK" : `\nhi-input: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
