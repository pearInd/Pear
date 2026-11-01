/* The real-session rig (rebuilt 2026-11-01; kept in scripts/rig/ so a lost scratchpad no longer costs a rebuild - CLAUDE.md §7.15).
   EVERY RUN WITHOUT --dry IS A BILLED ENGINE SESSION. A real FOX product page, the production widget injected with the TEST key in
   demo mode (no registration), a recorded 360 clip as the camera (MediaStreamTrackGenerator, one VideoFrame per tick - never
   canvas.captureStream), and a frame grab of the room's output and input through the billed window.
   usage: node rig.mjs <product> <clip.mp4> <outDir> [--dry]
     --dry  stops before go-live: proves the camera, the widget's facts and the room, bills nothing. */
import { chromium } from "/Users/yairgertner/pear interface/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const [product, clip, out, flag] = process.argv.slice(2);
const DRY = flag === "--dry";
mkdirSync(out, { recursive: true });
const log = (...a) => { const l = `[rig ${new Date().toISOString().slice(11, 23)}] ${a.join(" ")}`; console.log(l); };

const browser = await chromium.launch({
  headless: false,
  args: ["--window-position=40,40", "--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist","--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--window-size=1280,900"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera"] });
const clipBytes = readFileSync(clip);
await context.route("https://app.pear-ai.io/__rig/clip.mp4", (r) => r.fulfill({ status: 200, contentType: "video/mp4", body: clipBytes,
  headers: { "Access-Control-Allow-Origin": "*" } }));

/* The store's marketing popups cover the page in a visible window - taken away while the rig runs (the store page only). */
await context.addInitScript(() => {
  if (!/fox\.co\.il$/.test(location.host)) return;
  setInterval(() => document.querySelectorAll("popup-message, flashy-popup, .ai-popup-overlay").forEach((e) => e.remove()), 300);
});
await context.addInitScript(() => {
  if (location.host !== "app.pear-ai.io") return;
  window.__rig = { facts: [], frames: [], playing: false, camFrames: 0 };
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.type === "PEAR_UPDATE_GARMENT") window.__rig.facts.push({ t: performance.now(), color: d.garment_color_hex, ocr: d.garment_text_ocr,
      plain: d.garment_back_is_plain, url: !!d.garment_url, done: !!d.garment_classify_done });
  });
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!c || !c.video) return orig(c);
    const v = document.createElement("video");
    v.src = "/__rig/clip.mp4"; v.muted = true; v.playsInline = true; v.crossOrigin = "anonymous";
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("clip")); v.load(); });
    v.pause(); v.currentTime = 0;
    window.__rigPlay = () => { if (!window.__rig.playing) { window.__rig.playing = true; window.__rig.playAt = performance.now(); v.play(); } };
    const gen = new MediaStreamTrackGenerator({ kind: "video" });
    const w = gen.writable.getWriter();
    let ts = 0, busy = false;
    /* One VideoFrame per tick from the clip's own current picture (a paused clip repeats its first frame). The write is
       not awaited inside the tick: a slow consumer drops a frame instead of stacking timers on the main thread. */
    setInterval(() => {
      if (busy) return;
      busy = true;
      const f = new VideoFrame(v, { timestamp: ts }); ts += 33333;
      w.write(f).then(() => { window.__rig.camFrames++; busy = false; }, () => { try { f.close(); } catch (_) {} busy = false; });
    }, 33);
    /* Main-thread lag, so a dry run can prove the page keeps pace. */
    window.__rig.lag = []; let last = performance.now();
    setInterval(() => { const n = performance.now(); window.__rig.lag.push(n - last - 50); last = n; }, 50);
    window.__rigClip = v;
    return new MediaStream([gen]);
  };
});

const page = await context.newPage();
page.on("pageerror", (e) => log("pageerror", e.message.slice(0, 160)));
const prompts = [];
page.on("response", async (r) => {
  const u = r.url();
  if (/\/(api\/)?prompt$/.test(new URL(u).pathname) && r.request().method() === "POST") {
    try { const b = JSON.parse(r.request().postData() || "{}"); const j = await r.json();
      prompts.push({ at: Date.now(), host: new URL(u).host, angle: b.angle, test: b.test === true, delta: b.delta, color: b.item && b.item.colorHex,
        ocr: b.item && b.item.textOcr, prompt: j.prompt }); } catch (_) {}
  }
});

log("product", product, "clip", clip, DRY ? "(dry)" : "(BILLED)");
await page.goto(`https://fox.co.il/products/${product}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const s = document.createElement("script");
  s.src = "https://app.pear-ai.io/widget/pear-widget.js";
  s.setAttribute("data-pear-key", "TEST");
  s.setAttribute("data-pear-demo", "true");
  document.body.appendChild(s);
});
const btn = page.locator(".pear-widget-btn").first();
await btn.waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);   // the widget's gallery scrape + classify start
await btn.click();
log("widget opened");
const frameEl = await page.waitForSelector("iframe.pear-widget-frame", { timeout: 30000 });
const room = await frameEl.contentFrame();
await room.waitForLoadState("domcontentloaded");
const click = async (sel, t = 30000) => { const l = room.locator(sel); await l.waitFor({ state: "visible", timeout: t }); await l.click(); };
await room.locator("#height").waitFor({ state: "visible", timeout: 60000 });
try { await click("#cookieAcceptAll", 15000); } catch (_) { log("no cookie banner"); }
await room.locator("#height").fill("178");
await room.locator("#weight").fill("74");
await room.waitForTimeout(2500);
await room.evaluate(() => { const c = document.getElementById("consentTerms"); if (!c.checked) c.click();
  if (!c.checked) { c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); c.dispatchEvent(new Event("input", { bubbles: true })); } });
try { await click("#btn-next-screen", 15000); } catch (e) { await page.screenshot({ path: `${out}/stuck.png` }); throw e; }
log("size screen passed");
await click("#startCamBtn");
try { await click("#camGuideGo", 8000); } catch (_) { log("no camera guide"); }
await room.waitForFunction(() => window.__rig && window.__rig.camFrames > 30, null, { timeout: 30000 });
await room.waitForTimeout(3000);
const pre = await room.evaluate(() => {
  const w = document.getElementById("webcam");
  return { camFrames: window.__rig.camFrames, webcam: w ? [w.videoWidth, w.videoHeight, w.readyState] : null, facts: window.__rig.facts,
    capture: !document.getElementById("captureBtn").disabled };
});
log("preview", JSON.stringify(pre));
writeFileSync(`${out}/preview.json`, JSON.stringify({ pre, prompts }, null, 1));
await page.screenshot({ path: `${out}/preview.png` });
if (DRY) {
  const pace = await room.evaluate(async () => {
    window.__rigPlay(); const f0 = window.__rig.camFrames, l0 = window.__rig.lag.length; await new Promise((r) => setTimeout(r, 8000));
    const lag = window.__rig.lag.slice(l0).sort((a, b) => a - b);
    return { camFps: (window.__rig.camFrames - f0) / 8, lagP50: Math.round(lag[lag.length >> 1]), lagMax: Math.round(lag[lag.length - 1]),
      clipAt: Math.round(window.__rigClip.currentTime * 1000), over100: lag.filter((x) => x > 100).length, top: lag.slice(-4).map(Math.round), firstBig: window.__rig.lag.slice(l0).findIndex((x) => x > 300) * 50 };
  });
  log("dry pace", JSON.stringify(pace)); writeFileSync(`${out}/pace.json`, JSON.stringify(pace));
  log("dry run done - nothing billed"); await browser.close(); process.exit(0);
}

await room.waitForFunction(() => !document.getElementById("captureBtn").disabled, null, { timeout: 60000 });
const t0 = Date.now();
await click("#captureBtn");
log("GO LIVE pressed");
/* The turn plays from the reveal, and every 100ms the output and the input are grabbed (both at 320 wide) for 7s. */
await room.waitForFunction(() => document.querySelector(".camera-card.show-live"), null, { timeout: 60000 });
const revealMs = Date.now() - t0;
log("revealed after", revealMs, "ms");
await room.evaluate(() => {
  window.__rigPlay();
  const out = document.getElementById("aiVideo"), cam = window.__rigClip;
  const grab = (v) => { const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * (v.videoHeight || 9) / (v.videoWidth || 16));
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.7); };
  const start = performance.now();
  window.__rig.timer = setInterval(() => {
    const t = performance.now() - start;
    if (t > 7000) { clearInterval(window.__rig.timer); window.__rig.grabDone = true; return; }
    try { window.__rig.frames.push({ t: Math.round(t), clipT: Math.round(cam.currentTime * 1000), out: grab(out) }); } catch (e) { window.__rig.grabErr = String(e); }
  }, 100);
});
await room.waitForFunction(() => window.__rig.grabDone, null, { timeout: 20000 });
const frames = await room.evaluate(() => window.__rig.frames);
const facts = await room.evaluate(() => window.__rig.facts);
mkdirSync(`${out}/f`, { recursive: true });
for (const f of frames) {
  const n = String(f.t).padStart(5, "0");
  writeFileSync(`${out}/f/${n}-out.jpg`, Buffer.from(f.out.split(",")[1], "base64"));
}
writeFileSync(`${out}/frames.json`, JSON.stringify(frames.map((f) => ({ t: f.t, clipT: f.clipT }))));
await room.waitForTimeout(8000);   // the session ends and posts its TEST record
writeFileSync(`${out}/session.json`, JSON.stringify({ product, clip, revealMs, facts, prompts, ended: new Date().toISOString() }, null, 1));
log("frames", frames.length, "prompts seen", prompts.length);
await browser.close();
