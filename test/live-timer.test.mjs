/* THE CAMERA GUIDE AND THE SELF-TIMER - "if the camera doesn't see the whole body, it doesn't
   give the best result" (2026-09-29). See "CAMERA GUIDE + SELF-TIMER" in fitting-room/app.js.
   ─────────────────────────────────────────────────────────────────────────────
   The timer may decide only WHEN an already-verified reveal is shown, and what the stage shows
   until then. This suite runs the real block on a fake clock and pins that:
     §1  the choices and their modes: off / 3s counts AFTER the render is verified / 5-10s DURING
         the load; an unreadable stored choice is "off".
     §2  the countdown: shows N..1 off a deadline, marks the card while it runs, clears it at 0,
         resolves true at 0 and false when cancelled.
     §3  the reveal: no plan -> startBillingWindow at once (the timer off is the old path, byte for
         byte in behaviour); a render verified early WAITS for 0 and not a moment longer; a
         countdown already out -> at once; "after" counts 3-2-1 from the verified render; a
         session torn down during the hold is never revealed; the first-frame guard is retired
         when a hold begins (a verified frame is what it waits for).
     §4  the wiring: fire() goes through it typeof-guarded, with the old call as the fallback;
         goLive() reads the timer once, after claiming busy; teardown() and a failed go-live stop
         it; the camera button shows the guide first.
     §5  it never touches the session: no connect, token, send, prompt or orientation call.
     §6  the stage: while it runs the loading and presence overlays are set aside (display only)
         and the preview is not frosted; the timer control is preview-only. */
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
const a = APP.indexOf("const LIVE_TIMER_CHOICES");
const b = APP.indexOf("function openCameraFromButton()");
if (a < 0 || b < 0 || b < a) { console.log("FAIL  could not slice the self-timer block"); process.exit(1); }
const BLOCK = APP.slice(a, b);
const fnSrc = (start) => { const s = APP.indexOf(start); return s < 0 ? "" : APP.slice(s, APP.indexOf("\n}\n", s) + 3); };

/* ── a fake stage: clock, timers, elements ─────────────────────────────────── */
function stage({ stored = null } = {}) {
  let now = 1_000_000, seq = 1;
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
  const el = (id) => ({ id, hidden: true, textContent: "", classList: classes(), style: { setProperty() {}, removeProperty() {} },
    getBoundingClientRect: () => ({}), offsetWidth: 1, setAttribute() {}, focus() {} });
  const els = Object.fromEntries(["goCountdown", "goCountdownNum", "goCountdownArc", "goCountdownHint", "timerBtn", "timerBtnVal", "timerMenu"].map((id) => [id, el(id)]));
  const cardEl = el("cameraCard");
  const shown = [];                 // every number the countdown painted, in order
  const numEl = els.goCountdownNum;
  Object.defineProperty(numEl, "textContent", { get() { return this._t || ""; }, set(v) { this._t = v; shown.push(v); } });
  const calls = { billing: [], trace: [] };
  const env = {
    $: (id) => els[id] || null, card: () => cardEl, t: (k) => k,
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    Date: class extends Date { static now() { return now; } },
    document: { querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => stored, setItem: () => {} },
    startBillingWindow: (gen) => calls.billing.push({ gen, at: now }),
    traceOrient: (type, data) => calls.trace.push([type, data]),
  };
  const body = "let sessionGen = 7, firstFrameGuardTimer = 'armed';\n" + BLOCK + `
return { liveTimerMode, readLiveTimerPref, runGoCountdown, cancelGoCountdown, revealAfterCountdown,
  setPlan: (p) => { _liveTimerPlan = p; }, plan: () => _liveTimerPlan, running: () => !!(_goCountdown && _goCountdown.running),
  bumpGen: () => { sessionGen++; }, guard: () => firstFrameGuardTimer, LIVE_TIMER_CHOICES };`;
  const api = new Function(...Object.keys(env), body)(...Object.values(env));
  return { api, advance, calls, cardEl, els, shown, now: () => now };
}

console.log("── §1 the choices and their modes ──");
{
  const { api } = stage();
  check("off is null; 3s counts AFTER the render is verified; 5 and 10 count DURING the load",
    api.liveTimerMode(0) === null && api.liveTimerMode(undefined) === null && api.liveTimerMode(3) === "after" &&
    api.liveTimerMode(5) === "during" && api.liveTimerMode(10) === "during");
  check("the choices are exactly off / 3 / 5 / 10", JSON.stringify([...api.LIVE_TIMER_CHOICES]) === "[0,3,5,10]");
  check("a missing or unreadable stored choice reads as off - the default is today's flow",
    stage({ stored: null }).api.readLiveTimerPref() === 0 && stage({ stored: "7" }).api.readLiveTimerPref() === 0 &&
    stage({ stored: "abc" }).api.readLiveTimerPref() === 0 && stage({ stored: "10" }).api.readLiveTimerPref() === 10);
}

console.log("\n── §2 the countdown ──");
{
  const s = stage();
  let result = null;
  const h = s.api.runGoCountdown(5);
  h.done.then((ok) => { result = ok; });
  check("it shows the stage and marks the card while it runs",
    s.els.goCountdown.hidden === false && s.cardEl.classList.contains("is-counting") && h.running);
  await s.advance(4999);
  check("...painting 5, 4, 3, 2, 1 in order, one each", s.shown.join(",") === "5,4,3,2,1", s.shown.join(","));
  check("...and not yet done a moment before zero", result === null && h.running);
  await s.advance(2);
  check("at zero it resolves true, hides the stage and unmarks the card",
    result === true && s.els.goCountdown.hidden === true && !s.cardEl.classList.contains("is-counting") && !h.running);
  const c = stage();
  let cancelled = null;
  c.api.runGoCountdown(10).done.then((ok) => { cancelled = ok; });
  await c.advance(3000);
  c.api.cancelGoCountdown();
  await c.advance(1);
  check("a cancelled countdown resolves false and clears the stage", cancelled === false && c.els.goCountdown.hidden === true &&
    !c.cardEl.classList.contains("is-counting"));
}

console.log("\n── §3 the reveal ──");
{
  const off = stage();
  off.api.revealAfterCountdown(7);
  check("no plan (the timer off): startBillingWindow at once, with the same gen - the old path",
    off.calls.billing.length === 1 && off.calls.billing[0].gen === 7 && off.calls.trace.length === 0 && off.api.guard() === "armed");

  const early = stage();
  early.api.setPlan({ seconds: 10, mode: "during" });
  early.api.runGoCountdown(10);
  await early.advance(6000);                 // verified 6s into a 10s countdown
  early.api.revealAfterCountdown(7);
  check("a render verified early WAITS - nothing revealed while the countdown runs",
    early.calls.billing.length === 0 && early.calls.trace.some((e) => e[0] === "timer-hold"));
  check("...the first-frame guard is retired as the hold begins", early.api.guard() === null);
  await early.advance(3990);
  check("...still nothing just before zero", early.calls.billing.length === 0);
  await early.advance(20);
  check("...and the reveal lands AT zero, once", early.calls.billing.length === 1 && early.calls.billing[0].at - 1_000_000 >= 10_000 &&
    early.calls.billing[0].at - 1_000_000 <= 10_010, JSON.stringify(early.calls.billing));

  const late = stage();
  late.api.setPlan({ seconds: 5, mode: "during" });
  late.api.runGoCountdown(5);
  await late.advance(7000);                  // still loading when the countdown ran out
  late.api.revealAfterCountdown(7);
  check("a countdown that already ran out: the reveal goes at once", late.calls.billing.length === 1 && late.calls.billing[0].at === late.now());

  const after = stage();
  after.api.setPlan({ seconds: 3, mode: "after" });
  after.api.revealAfterCountdown(7);
  check("\"after\" (3s): the 3-2-1 starts only when the verified render is here", after.api.running() && after.calls.billing.length === 0);
  await after.advance(3010);
  check("...and the reveal follows it", after.calls.billing.length === 1 && after.shown.join(",") === "3,2,1", after.shown.join(","));

  const torn = stage();
  torn.api.setPlan({ seconds: 10, mode: "during" });
  torn.api.runGoCountdown(10);
  await torn.advance(4000);
  torn.api.revealAfterCountdown(7);
  torn.api.bumpGen();                        // teardown() during the hold
  await torn.advance(8000);
  check("a session torn down during the hold is never revealed", torn.calls.billing.length === 0);

  const once = stage();
  once.api.setPlan({ seconds: 5, mode: "during" });
  once.api.revealAfterCountdown(7);
  check("the plan is consumed by the reveal - the next session starts clean", once.api.plan() === null);
}

console.log("\n── §4 the wiring ──");
{
  const arm = APP.slice(APP.indexOf("function armFirstFrameBilling(video, gen) {"), APP.indexOf("function watchPostFireLuma"));
  check("fire() reveals through the timer, typeof-guarded, with startBillingWindow(gen) as the fallback",
    /if \(typeof revealAfterCountdown === "function"\) revealAfterCountdown\(gen\);\s*\n\s*else startBillingWindow\(gen\);/.test(arm));
  const live = fnSrc("async function goLive() {");
  const busyAt = live.indexOf("busy = true"), readAt = live.indexOf("liveTimerMode(liveTimerSec)");
  check("goLive() reads the timer once, after claiming busy, and starts a DURING countdown right there",
    busyAt > 0 && readAt > busyAt && (live.match(/liveTimerMode\(/g) || []).length === 1 &&
    /if \(liveTimer === "during"\) runGoCountdown\(liveTimerSec\);/.test(live));
  check("...and a go-live that never opened a session stops it", /if \(!isLive\(\)\) \{[\s\S]{0,400}cancelGoCountdown\(\)[\s\S]{0,80}_liveTimerPlan = null;/.test(live));
  const td = fnSrc("function teardown() {");
  /* After the sessionGen bump is fine, and deliberate: the held reveal resolves asynchronously and
     checks the gen then (§3 "torn down during the hold"). It also keeps image-first's fixed window
     over teardown()'s head, which looks for stopFrameFreezeWatch() within 2600 characters. */
  check("teardown() stops it and drops the plan (a held reveal then dies on the sessionGen bump)",
    /cancelGoCountdown\(\)/.test(td) && /_liveTimerPlan = null/.test(td) && td.indexOf("sessionGen++") < td.indexOf("cancelGoCountdown"));
  check("the camera button shows the guide first, once per room load; its button opens the camera",
    /\$\("startCamBtn"\)\.addEventListener\("click", \(\) => \{\s*\n\s*if \(!_camGuideShown\) showCamGuide\(\);\s*\n\s*else openCameraFromButton\(\);/.test(APP) &&
    /\$\("camGuideGo"\)\?\.addEventListener\("click", \(\) => \{ hideCamGuide\(\); openCameraFromButton\(\); \}\);/.test(APP));
}

console.log("\n── §5 it never touches the session ──");
{
  const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("no connect, token, send, prompt, reference or orientation call in the timer block",
    !/connectRealtime|mintEphemeralToken|rtClient|sendCondition|applyGarment|applyActive|wirePrompt|maybeSwap|openOrientChannel|releaseInputGate/.test(code));
}

console.log("\n── §6 the stage ──");
{
  check("while it runs, the loading and presence overlays are set aside - display only",
    /\.camera-card\.is-counting #scanOverlay,\s*\n\.camera-card\.is-counting #presenceOverlay \{ display: none !important; \}/.test(CSS));
  check("...and the preview is not frosted under it", /\.camera-card\.is-counting:has\(> #scanOverlay:not\(\[hidden\]\)\) #webcam \{ filter: none; \}/.test(CSS));
  check("the timer control is preview-only: gone while live, on a result or a clip, while counting or loading",
    /\.camera-card\.show-live \.cam-timer,\s*\n\.camera-card\.show-result \.cam-timer,\s*\n\.camera-card\.show-clip \.cam-timer,\s*\n\.camera-card\.is-counting \.cam-timer,\s*\n\.camera-card:has\(> #scanOverlay:not\(\[hidden\]\)\) \.cam-timer \{ display: none; \}/.test(CSS));
  check("the markup is there: guide, timer menu (off/3/5/10) and the countdown stage",
    /id="camGuide"/.test(HTML) && /id="camGuideGo"/.test(HTML) && /id="timerBtn"/.test(HTML) &&
    ["0", "3", "5", "10"].every((v) => HTML.includes(`data-timer="${v}"`)) && /id="goCountdown"/.test(HTML));
}

console.log(fails === 0 ? "\nlive-timer: OK" : `\nlive-timer: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
