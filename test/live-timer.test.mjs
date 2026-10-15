/* THE CAMERA GUIDE AND THE SELF-TIMER - "if the camera doesn't see the whole body, it doesn't
   give the best result" (2026-09-29), then "it started before the timer ended" and "a second or
   two of loading after zero" (the same day, two 10s sessions). See "CAMERA GUIDE + SELF-TIMER" in
   fitting-room/app.js. ZERO IS THE FITTING: never before it, and no loading screen after it.
   ─────────────────────────────────────────────────────────────────────────────
   Runs the real block on a fake clock:
     §1  the choices and their modes: off / 3 and 5 "prep" (get ready, then numbers timed to the
         expected render) / 10 "during" (numbers from the press); an unreadable choice is off.
     §2  "during": N..1 from the press, zero on time, the stage stays up until the reveal closes it.
     §3  "prep": no number until the session connects; then the numbers are placed so zero lands
         LIVE_TIMER_READY_AFTER_CONNECT_MS after the connect - and a full N is always shown.
     §4  a slow connect under "during": the remaining numbers are spread to the expected render,
         and the number on screen never jumps back.
     §5  the reveal: no plan -> at once (the old path); a render verified early waits for zero EXACTLY;
         THE REPORTED BUG - a second fire() for the same session (onRemoteStream arms more than one
         gate) must not reveal early; a render verified after zero reveals as it lands; a session
         torn down during the hold is never revealed; the first-frame guard is retired by a hold.
     §6  the wiring: fire() goes through it typeof-guarded; goLive() reads the timer once after
         claiming busy, skips the presence wait only under a timer, and reports the connect; teardown
         and a failed go-live stop it; the camera button shows the guide first.
     §7  it never touches the session: no connect, token, send, prompt or orientation call.
     §8  the guide (three steps, no "turn slowly"), the slider, the stage CSS, and the "verified"
         moment - fire-and-forget, typeof-guarded inside the OTP block, never awaited. */
import { readFileSync } from "node:fs";

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}
const APP = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync(new URL("../fitting-room/style.css", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../fitting-room/index.html", import.meta.url), "utf8");
const I18N = readFileSync(new URL("../fitting-room/i18n.js", import.meta.url), "utf8");
const a = APP.indexOf("const LIVE_TIMER_CHOICES");
const b = APP.indexOf("/* ── CODE VERIFIED (2026-09-29)");
if (a < 0 || b < 0 || b < a) { console.log("FAIL  could not slice the self-timer block"); process.exit(1); }
const BLOCK = APP.slice(a, b);
const READY = Number((/const LIVE_TIMER_READY_AFTER_CONNECT_MS = (\d+);/.exec(APP) || [])[1]);
const fnSrc = (start) => { const s = APP.indexOf(start); return s < 0 ? "" : APP.slice(s, APP.indexOf("\n}\n", s) + 3); };
const T0 = 1_000_000;

/* ── a fake stage: clock, timers, elements ─────────────────────────────────── */
function stage({ stored = null } = {}) {
  let now = T0, seq = 1;
  const timers = [];
  const setTimeout_ = (fn, ms) => { const id = seq++; timers.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; };
  const clearTimeout_ = (id) => { const x = timers.find((q) => q.id === id); if (x) x.dead = true; };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = timers.filter((q) => !q.dead && q.at <= end).sort((x, y) => x.at - y.at || x.id - y.id)[0];
      if (!due) break;
      now = Math.max(now, due.at); due.dead = true; due.fn();
    }
    now = end; await flush();
  }
  const classes = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: (c) => s.has(c) }; };
  const el = (id) => ({ id, hidden: true, textContent: "", dataset: {}, classList: classes(), style: { setProperty() {}, removeProperty() {} },
    getBoundingClientRect: () => ({}), offsetWidth: 1, setAttribute() {}, focus() {} });
  const els = Object.fromEntries(["goCountdown", "goCountdownNum", "goCountdownArc", "goCountdownHint", "timerBtn", "timerBtnVal", "timerMenu", "timerTrack"].map((id) => [id, el(id)]));
  const cardEl = el("cameraCard");
  const shown = [];   // [number, ms after T0] for every number the countdown painted
  Object.defineProperty(els.goCountdownNum, "textContent", { get() { return this._t || ""; }, set(v) { this._t = v; if (v) shown.push([Number(v), now - T0]); } });
  const calls = { billing: [], trace: [] };
  const env = {
    $: (id) => els[id] || null, card: () => cardEl, t: (k) => k, tf: (k) => k,
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    Date: class extends Date { static now() { return now; } },
    document: { querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => stored, setItem: () => {} },
    startBillingWindow: (gen) => calls.billing.push({ gen, at: now - T0 }),
    traceOrient: (type, data) => calls.trace.push([type, data]),
  };
  const body = "let sessionGen = 7, firstFrameGuardTimer = 'armed';\n" + BLOCK + `
return { liveTimerMode, readLiveTimerPref, runGoCountdown, cancelGoCountdown, revealAfterCountdown, liveTimerConnected,
  setPlan: (p) => { _liveTimerPlan = p; }, plan: () => _liveTimerPlan, cd: () => _goCountdown,
  bumpGen: () => { sessionGen++; }, guard: () => firstFrameGuardTimer, LIVE_TIMER_CHOICES };`;
  const api = new Function(...Object.keys(env), body)(...Object.values(env));
  return { api, advance, calls, cardEl, els, shown, now: () => now - T0 };
}
const nums = (s) => s.shown.map((x) => x[0]).join(",");

console.log("── §1 the choices and their modes ──");
{
  const { api } = stage();
  check("off is null; 3 and 5 are \"prep\"; 10 is \"during\"",
    api.liveTimerMode(0) === null && api.liveTimerMode(undefined) === null && api.liveTimerMode(3) === "prep" &&
    api.liveTimerMode(5) === "prep" && api.liveTimerMode(10) === "during");
  check("the choices are exactly off / 3 / 5 / 10", JSON.stringify([...api.LIVE_TIMER_CHOICES]) === "[0,3,5,10]");
  check("a missing or unreadable stored choice reads as off - the default is today's flow",
    stage({ stored: null }).api.readLiveTimerPref() === 0 && stage({ stored: "7" }).api.readLiveTimerPref() === 0 &&
    stage({ stored: "abc" }).api.readLiveTimerPref() === 0 && stage({ stored: "10" }).api.readLiveTimerPref() === 10);
  check("the expected connect-to-render time is a measured value plus a margin (5.1-5.4s measured)", READY >= 5400 && READY <= 6500, String(READY));
}

console.log("\n── §2 \"during\" (10s) ──");
{
  const s = stage();
  let zeroAt = null;
  const h = s.api.runGoCountdown(10, "during");
  h.zero.then((ok) => { zeroAt = ok ? s.now() : -1; });
  check("the stage is up and marks the card from the press", s.els.goCountdown.hidden === false && s.cardEl.classList.contains("is-counting"));
  await s.advance(9999);
  check("10..1, one each, on the second", nums(s) === "10,9,8,7,6,5,4,3,2,1" && s.shown.every(([n, at]) => Math.abs(at - (10 - n) * 1000) <= 20),
    JSON.stringify(s.shown));
  check("...and not zero a moment early", zeroAt === null);
  await s.advance(2);
  check("zero lands at 10.0s", zeroAt !== null && zeroAt >= 10000 && zeroAt <= 10005, String(zeroAt));
  check("...and the stage stays up (\"starting\") until the reveal closes it - never the loading overlay",
    s.els.goCountdown.hidden === false && s.cardEl.classList.contains("is-counting") && s.els.goCountdown.dataset.phase === "late");
  h.close();
  check("close() takes the stage and the card mark down", s.els.goCountdown.hidden === true && !s.cardEl.classList.contains("is-counting"));
}

console.log("\n── §3 \"prep\" (3s / 5s) ──");
for (const N of [5, 3]) {
  const s = stage();
  let zeroAt = null;
  const h = s.api.runGoCountdown(N, "prep");
  h.zero.then((ok) => { zeroAt = ok ? s.now() : -1; });
  await s.advance(2300);
  check(`${N}s: "get ready" and no number before the session connects`, s.shown.length === 0 && s.els.goCountdown.dataset.phase === "prep");
  s.api.liveTimerConnected();                   // connected 2.3s after the press
  await s.advance(READY + 50);
  const first = s.shown[0];
  check(`${N}s: then a full ${N}..1, placed so zero lands ${READY}ms after the connect`,
    nums(s) === Array.from({ length: N }, (_, i) => N - i).join(",") && zeroAt !== null && Math.abs(zeroAt - (2300 + READY)) <= 5 &&
    first && Math.abs(first[1] - (2300 + READY - N * 1000)) <= 20, `${nums(s)} zero@${zeroAt} first@${first && first[1]}`);
}

console.log("\n── §4 a slow connect under \"during\" ──");
{
  const s = stage();
  let zeroAt = null;
  s.api.runGoCountdown(10, "during").zero.then(() => { zeroAt = s.now(); });
  await s.advance(6500);                         // showing 4
  s.api.liveTimerConnected();                    // expected render at 6.5 + READY > 10
  await s.advance(READY + 100);
  const seq = s.shown.map((x) => x[0]);
  check("zero moves to the expected render", zeroAt !== null && Math.abs(zeroAt - (6500 + READY)) <= 5, String(zeroAt));
  check("...the numbers still count down one by one - never back up, never skipped",
    seq.every((n, i) => i === 0 || n === seq[i - 1] - 1) && seq[seq.length - 1] === 1, seq.join(","));
  const fast = stage();
  let fastZero = null;
  fast.api.runGoCountdown(10, "during").zero.then(() => { fastZero = fast.now(); });
  await fast.advance(2000); fast.api.liveTimerConnected();
  await fast.advance(8100);
  check("a normal connect (render expected before zero) leaves zero exactly at 10s", fastZero !== null && Math.abs(fastZero - 10000) <= 5, String(fastZero));
}

console.log("\n── §5 the reveal ──");
{
  const off = stage();
  off.api.revealAfterCountdown(7);
  check("no plan (the timer off): startBillingWindow at once, with the same gen - the old path",
    off.calls.billing.length === 1 && off.calls.billing[0].gen === 7 && off.api.guard() === "armed");

  const early = stage();
  early.api.setPlan({ seconds: 10, mode: "during", heldGen: null });
  early.api.runGoCountdown(10, "during");
  await early.advance(2000); early.api.liveTimerConnected();
  await early.advance(5500);                      // verified at 7.5s - the reported session
  early.api.revealAfterCountdown(7);
  await early.advance(69);
  early.api.revealAfterCountdown(7);              // THE BUG: a second gate for the same session fires 69ms later
  await early.advance(1);
  check("THE REPORTED BUG: a second fire() for the same session does NOT reveal before zero",
    early.calls.billing.length === 0, JSON.stringify(early.calls.billing));
  check("...the hold retired the first-frame guard", early.api.guard() === null);
  await early.advance(2400);
  check("...and nothing a moment before zero", early.calls.billing.length === 0);
  await early.advance(40);
  check("...the reveal lands AT zero, exactly once, and the stage is down",
    early.calls.billing.length === 1 && Math.abs(early.calls.billing[0].at - 10000) <= 5 && early.els.goCountdown.hidden === true &&
    !early.cardEl.classList.contains("is-counting"), JSON.stringify(early.calls.billing));

  const late = stage();
  late.api.setPlan({ seconds: 10, mode: "during", heldGen: null });
  late.api.runGoCountdown(10, "during");
  await late.advance(11000);                     // zero passed, the render not yet verified
  check("zero before the render: the stage holds (\"starting\"), nothing revealed", late.calls.billing.length === 0 &&
    late.els.goCountdown.hidden === false && late.els.goCountdown.dataset.phase === "late");
  late.api.revealAfterCountdown(7);
  await late.advance(1);
  check("...and the reveal goes the moment the render lands", late.calls.billing.length === 1 && late.els.goCountdown.hidden === true);

  const prep = stage();
  prep.api.setPlan({ seconds: 5, mode: "prep", heldGen: null });
  prep.api.runGoCountdown(5, "prep");
  await prep.advance(2000); prep.api.liveTimerConnected();
  await prep.advance(5200);                      // verified 5.2s after the connect
  prep.api.revealAfterCountdown(7);
  await prep.advance(READY - 5200 + 10);
  check("\"prep\": the reveal lands at zero, the expected render", prep.calls.billing.length === 1 &&
    Math.abs(prep.calls.billing[0].at - (2000 + READY)) <= 5 && nums(prep) === "5,4,3,2,1", JSON.stringify(prep.calls.billing));

  const noConnect = stage();
  noConnect.api.setPlan({ seconds: 3, mode: "prep", heldGen: null });
  noConnect.api.runGoCountdown(3, "prep");
  await noConnect.advance(6000);
  noConnect.api.revealAfterCountdown(7);        // verified with no connect reported (another connect path)
  await noConnect.advance(3010);
  check("a render verified while still \"get ready\" runs the full numbers, then reveals", nums(noConnect) === "3,2,1" && noConnect.calls.billing.length === 1);

  const torn = stage();
  torn.api.setPlan({ seconds: 10, mode: "during", heldGen: null });
  torn.api.runGoCountdown(10, "during");
  await torn.advance(4000);
  torn.api.revealAfterCountdown(7);
  torn.api.bumpGen();                            // teardown() during the hold
  torn.api.cancelGoCountdown();
  await torn.advance(8000);
  check("a session torn down during the hold is never revealed, and its stage is down",
    torn.calls.billing.length === 0 && torn.els.goCountdown.hidden === true);
}

console.log("\n── §6 the wiring ──");
{
  const arm = APP.slice(APP.indexOf("function armFirstFrameBilling(video, gen) {"), APP.indexOf("function watchPostFireLuma"));
  check("fire() reveals through the timer, typeof-guarded, with startBillingWindow(gen) as the fallback",
    /if \(typeof revealAfterCountdown === "function"\) revealAfterCountdown\(gen\);\s*\n\s*else startBillingWindow\(gen\);/.test(arm));
  const live = fnSrc("async function goLive() {");
  const busyAt = live.indexOf("busy = true"), readAt = live.indexOf("liveTimerMode(liveTimerSec)");
  check("goLive() reads the timer once, after claiming busy, and starts the stage in its mode",
    busyAt > 0 && readAt > busyAt && (live.match(/liveTimerMode\(/g) || []).length === 1 &&
    /runGoCountdown\(liveTimerSec, liveTimer\);/.test(live) && /heldGen: null/.test(live));
  /* The presence gate runs under a timer too, as on main: skipping it for a day let a session open
     on a shopper whose legs were out of frame, and the render invented long trousers and shoes. */
  check("...and runs main's presence gate under a timer too - the engine first sees the whole body",
    /const presence = await awaitBodyPresence\(isBottomsGarment\(activeItem\)\);/.test(live) && !/_liveTimerPlan \? "timer"/.test(live));
  check("...and reports the connect right after waitConnected()",
    /await waitConnected\(CONNECT_TIMEOUT_MS\);[\s\S]{0,300}liveTimerConnected\(\);/.test(live));
  check("...and a go-live that never opened a session stops it", /if \(!isLive\(\)\) \{[\s\S]{0,400}cancelGoCountdown\(\)[\s\S]{0,80}_liveTimerPlan = null;/.test(live));
  const td = fnSrc("function teardown() {");
  check("teardown() stops it and drops the plan (a held reveal then dies on the sessionGen bump)",
    /cancelGoCountdown\(\)/.test(td) && /_liveTimerPlan = null/.test(td) && td.indexOf("sessionGen++") < td.indexOf("cancelGoCountdown"));
  check("the camera button shows the guide first, once per room load; its button opens the camera",
    /\$\("startCamBtn"\)\.addEventListener\("click", \(\) => \{\s*\n\s*if \(!_camGuideShown\) showCamGuide\(\);\s*\n\s*else openCameraFromButton\(\);/.test(APP) &&
    /\$\("camGuideGo"\)\?\.addEventListener\("click", \(\) => \{ hideCamGuide\(\); openCameraFromButton\(\); \}\);/.test(APP));
}

console.log("\n── §7 it never touches the session ──");
{
  const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("no connect, token, send, prompt, reference or orientation call in the timer block",
    !/connectRealtime|mintEphemeralToken|rtClient|sendCondition|applyGarment|applyActive|wirePrompt|maybeSwap|openOrientChannel|releaseInputGate/.test(code));
}

console.log("\n── §8 the guide, the slider, the stage and the verified moment ──");
{
  const guide = HTML.slice(HTML.indexOf('id="camGuide"'), HTML.indexOf('id="camGuideGo"'));
  check("the guide has three steps, the full-body one first - and no \"turn slowly\"",
    (guide.match(/<li class="cam-guide__step/g) || []).length === 3 && /cam-guide__step--key[^>]*style="--i:0"/.test(guide) &&
    !/camGuideStep4|הסתובבו לאט/.test(HTML) && !/camGuideStep4|הסתובבו לאט/.test(I18N));
  check("the timer is a draggable glass slider over off / 3 / 5 / 10",
    /id="timerTrack"/.test(HTML) && /cam-timer__pill/.test(HTML) && ["0", "3", "5", "10"].every((v) => HTML.includes(`data-timer="${v}"`)) &&
    /slider\.addEventListener\("pointermove"/.test(BLOCK) && /LIVE_TIMER_RUBBER_BAND/.test(BLOCK));
  check("while it runs, the loading and presence overlays are set aside - display only - and the preview is sharp",
    /\.camera-card\.is-counting #scanOverlay,\s*\n\.camera-card\.is-counting #presenceOverlay \{ display: none !important; \}/.test(CSS) &&
    /\.camera-card\.is-counting:has\(> #scanOverlay:not\(\[hidden\]\)\) #webcam \{ filter: none; \}/.test(CSS));
  check("the timer control is preview-only", /\.camera-card\.show-live \.cam-timer,\s*\n\.camera-card\.show-result \.cam-timer,\s*\n\.camera-card\.show-clip \.cam-timer,\s*\n\.camera-card\.is-counting \.cam-timer,/.test(CSS));
  const otp = APP.slice(APP.indexOf("async function verifyOtp(code) {"), APP.indexOf("async function resendOtp()"));
  check("the verified moment plays after the proof is stored, typeof-guarded and NOT awaited - it never holds the flow",
    /stampAuthDate\(\);[\s\S]{0,400}if \(typeof celebrateOtpVerified === "function"\) celebrateOtpVerified\(\);[\s\S]{0,40}if \(reauth\)/.test(otp) &&
    !/await celebrateOtpVerified/.test(otp));
  check("...it is pointer-transparent and on top of everything", /\.otp-success \{\s*\n\s*position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;/.test(CSS) && /id="otpSuccess"/.test(HTML));
}

console.log("\n── §9 the pose model's first inference is never paid inside a fitting ──");
{
  /* 2026-09-29: a 10s session froze ~1.9s at the reveal and bridged to the raw camera - the first
     MediaPipe inference (run by the presence gate the timer skips) landed on the fitting's first
     second. It is warmed in preview now, and at a timer's go-live as a backstop. */
  const warm = fnSrc("function warmPoseInference() {");
  check("the warm-up runs the first inferences off to the side, and never once the fitting is on screen",
    /loadPoseLandmarker\(\)\.then/.test(warm) && /detectPoseFrame\(detector, video\)/.test(warm) &&
    /if \(billingStarted\) return;/.test(warm) && /if \(_poseInferenceWarmed\) return;/.test(warm));
  /* 2026-09-30: only under a self-timer - with it off, go-live is main's to the millisecond. */
  check("...it runs when the camera opens in preview - only with a timer set",
    /if \(ok && liveTimerSec > 0\) warmPoseInference\(\);/.test(fnSrc("function openCameraFromButton() {")) &&
    /if \(liveTimerSec > 0 && typeof warmPoseInference === "function" && typeof localStream !== "undefined" && localStream\) warmPoseInference\(\);/.test(fnSrc("function setLiveTimer(seconds) {")));
  const live = fnSrc("async function goLive() {");
  check("...and at a timer's go-live, a backstop for a press before the preview warm-up finished",
    /runGoCountdown\(liveTimerSec, liveTimer\);[\s\S]{0,300}warmPoseInference\(\);/.test(live));
  const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "");
  check("...and it lives outside the timer block: the block runs no inference, and only ASKS for the warm-up, typeof-guarded",
    !/detectPoseFrame|function warmPoseInference/.test(code) &&
    (code.match(/warmPoseInference\(/g) || []).length === (code.match(/typeof warmPoseInference === "function"[^;]*warmPoseInference\(\)/g) || []).length);
}

console.log(fails === 0 ? "\nlive-timer: OK" : `\nlive-timer: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
