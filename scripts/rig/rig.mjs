/* The real-session rig (rebuilt 2026-11-01; kept in scripts/rig/ so a lost scratchpad no longer costs a rebuild - CLAUDE.md §7.15).
   EVERY RUN WITHOUT --dry IS A BILLED ENGINE SESSION. A real FOX product page, the production widget injected with the TEST key in
   demo mode (no registration), a recorded 360 clip as the camera (MediaStreamTrackGenerator, one VideoFrame per tick - never
   canvas.captureStream), and a frame grab of the room's output and input through the billed window.
   usage: node rig.mjs <product> <clip.mp4> <outDir> [--dry] [--no-fabric]
     --no-fabric  the A/B arm: every prompt answer reaches the room with its `Fabric: ...` sentence taken out - the same session,
                  TEST record included, without the colour sentence (2026-11-01, the PEAK A/B).
     --dry  stops before go-live: proves the camera, the widget's facts and the room, bills nothing. */
import { chromium } from "/Users/yairgertner/pear interface/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const [product, clip, out, ...flags] = process.argv.slice(2);
const DRY = flags.includes("--dry");
const NO_FABRIC = flags.includes("--no-fabric");
/* --size=<label>: the size button the rig clicks in the room before go-live (the shopper's own size choice - getSizeDelta). */
const SIZE = (flags.find((f) => f.startsWith("--size=")) || "").slice(7) || null;
/* THE STORE PAGE, CACHED (2026-11-01): FOX answers 429 after a few loads of its product pages, and a rig run that cannot load
   the page measures nothing. The product page's HTML is fetched once and kept in RIG_PAGE_CACHE; every later run is served
   from the file (the page's own assets and photos still load as usual). */
const PAGE_CACHE = process.env.RIG_PAGE_CACHE || "/private/tmp/pear-rig-pages";
/* --hw=<cm>,<kg>: the height and weight typed on the size screen (default 178,74) - the recommended size the --size= delta is
   measured from (getSizeDelta). */
const HW = ((flags.find((f) => f.startsWith("--hw=")) || "").slice(5) || "178,74").split(",").map((x) => x.trim());
/* --synthetic=<spec.json>: {title, images[], sizes[]} - when the store blocks its product pages (FOX answered 429 on every
   /products/* path for hours on 2026-11-01), the rig serves a minimal product page at the product's own address: the real
   photos from the store's CDN as JSON-LD Product.image (a DECLARED source for the widget), a size picker and a Shopify
   add-to-cart form. The widget, the classifier, the room and the engine are the real ones. */
const SYNTH = (() => { const f = (flags.find((x) => x.startsWith("--synthetic=")) || "").slice(12); return f ? JSON.parse(readFileSync(f, "utf8")) : null; })();
function syntheticPage(spec) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ld = { "@context": "https://schema.org", "@type": "Product", name: spec.title, sku: String(product), image: spec.images,
    offers: spec.sizes.map((sz) => ({ "@type": "Offer", name: sz, availability: "https://schema.org/InStock", price: "99.90", priceCurrency: "ILS" })) };
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(spec.title)} | FOX</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
<main class="product"><h1 class="product__title">${esc(spec.title)}</h1>
<div class="product__media">${spec.images.map((u) => `<img src="${esc(u)}" alt="${esc(spec.title)}" width="600">`).join("")}</div>
<form action="/cart/add" method="post"><label>מידה <select name="options[מידה]">${spec.sizes.map((sz) => `<option value="${esc(sz)}">${esc(sz)}</option>`).join("")}</select></label>
<button type="submit" name="add">הוסף לסל</button></form></main></body></html>`;
}
mkdirSync(out, { recursive: true });
const log = (...a) => { const l = `[rig ${new Date().toISOString().slice(11, 23)}] ${a.join(" ")}`; console.log(l); };

const browser = await chromium.launch({
  headless: false,
  args: ["--window-position=40,40", "--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist","--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--window-size=1280,900"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera"] });
const clipBytes = readFileSync(clip);
if (NO_FABRIC) {
  /* The edge's (or the origin's) real answer, its colour sentence removed; every header kept but the length and encoding (the room checks
     X-Pear-Api, the browser the CORS headers). */
  await context.route((u) => /^\/(api\/)?prompt$/.test(u.pathname) && /^(rt|app)\.pear-ai\.io$/.test(u.host), async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const resp = await route.fetch();
    /* the body is re-sent decoded: a kept content-encoding made the room's fetch fail and fall back to the origin */
    const headers = { ...resp.headers() };
    for (const h of ["content-length", "content-encoding", "transfer-encoding"]) delete headers[h];
    let body = await resp.text();
    try { const j = JSON.parse(body); if (typeof j.prompt === "string") j.prompt = j.prompt.replace(/ ?Fabric: [^.]*\./, ""); body = JSON.stringify(j); } catch (_) {}
    await route.fulfill({ status: resp.status(), headers, body });
  });
}
{
  const { existsSync, mkdirSync: mk } = await import("node:fs");
  mk(PAGE_CACHE, { recursive: true });
  const file = `${PAGE_CACHE}/${String(product).replace(/[^0-9a-z_-]/gi, "")}.html`;
  await context.route((u) => u.host === "fox.co.il" && u.pathname === `/products/${product}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (SYNTH) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: syntheticPage(SYNTH) });
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readFileSync(file) });
    const resp = await route.fetch();
    const body = await resp.text();
    if (resp.status() === 200 && body.length > 10000) writeFileSync(file, body);
    return route.fulfill({ status: resp.status(), contentType: "text/html; charset=utf-8", body });
  });
}
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
    /* Before the reveal the camera is the clip's first 0.8s IN A LOOP - a person standing, with a real camera's small motion -
       not one frozen frame: ~15s of pixel-identical input is nothing a real camera sends, and the sessions that drew a giant
       shirt (m2, f1, 2026-11-01) both started from it. At the reveal the clip restarts and plays the turn. */
    v.currentTime = 0; v.play();
    setInterval(() => { if (!window.__rig.playing && v.currentTime > 0.8) v.currentTime = 0; }, 50);
    window.__rigPlay = () => { if (!window.__rig.playing) { window.__rig.playing = true; window.__rig.playAt = performance.now(); v.currentTime = 0; v.play(); } };
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
/* THE NETWORK TAB, AUDITED (2026-11-01): every response body and WebSocket frame the page sees, scanned for anything
   shaped like a key, an engine/vendor word and the prompt's own wording - names and counts only, never a value. */
const NET_SECRETS = [["google api key", /AIza[0-9A-Za-z\-_]{35}/], ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["secret key", /\bsk[-_](?:live_|test_|proj-)?[A-Za-z0-9]{20,}/], ["raw ephemeral token", /\bek_[A-Za-z0-9]{12,}/],
  ["supabase key", /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/], ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/]];
const NET_WORDS = /\b(decart|lucy|gemini|generativelanguage|mediapipe|livekit)\b/i;
const NET_PROMPT = /Drape and fit the EXACT|Strictly preserve|REAR\/BACK/;
const net = { responses: 0, frames: 0, secrets: {}, words: {}, promptIn: {}, token: null };
const netScan = (where, text) => {
  if (typeof text !== "string" || !text) return;
  for (const [name, re] of NET_SECRETS) if (re.test(text)) net.secrets[`${name} @ ${where}`] = (net.secrets[`${name} @ ${where}`] || 0) + 1;
  const w = text.match(NET_WORDS); if (w) net.words[`${w[0].toLowerCase()} @ ${where}`] = (net.words[`${w[0].toLowerCase()} @ ${where}`] || 0) + 1;
  if (NET_PROMPT.test(text)) net.promptIn[where] = (net.promptIn[where] || 0) + 1;
};
page.on("response", async (r) => {
  try {
    const u = new URL(r.url());
    if (!/pear-ai\.io$/.test(u.host)) return;
    const type = r.headers()["content-type"] || "";
    if (!/json|text|javascript/.test(type)) return;
    const body = await r.text();
    net.responses++;
    netScan(`${u.host}${u.pathname.replace(/[0-9a-f]{12,}/g, "*")}`, body);
    if (/^\/api\/(realtime-token|tryon)$/.test(u.pathname)) {
      try { const j = JSON.parse(body); net.token = { keys: Object.keys(j), sealed: typeof j.t === "string" && j.t[0] === "p", tLen: (j.t || "").length,
        lifetimeS: j.exp ? Math.round((new Date(typeof j.exp === "number" && j.exp < 1e12 ? j.exp * 1000 : j.exp) - Date.now()) / 1000) : null }; } catch (_) {}
    }
  } catch (_) {}
});
page.on("websocket", (ws) => {
  const host = (() => { try { return new URL(ws.url()).host + new URL(ws.url()).pathname.replace(/\/k\/[^/]+/, "/k/*"); } catch (_) { return "ws"; } })();
  const seen = (f) => { net.frames++; netScan(`ws ${host}`, typeof f.payload === "string" ? f.payload : ""); };
  ws.on("framesent", seen); ws.on("framereceived", seen);
});
/* The rear/front mask's band requests (/api/garment-box): when each was asked and answered (epoch ms), so a run shows
   whether the mask was ready before go-live (THE BAND IS WAITED FOR UNTIL GO-LIVE, CLAUDE.md §7.16). */
const boxes = new Map();
page.on("request", (q) => { if (/\/api\/garment-box\?/.test(q.url())) boxes.set(q, { asked: Date.now(), url: q.url().replace(/^.*image_url=([^&]+).*region=(\w+).*$/, (m, u, g) => decodeURIComponent(u).split("/").pop() + "|" + g) }); });
page.on("requestfinished", (q) => { const b = boxes.get(q); if (b) b.answered = Date.now(); });
page.on("requestfailed", (q) => { const b = boxes.get(q); if (b) { b.failed = Date.now(); b.error = (q.failure() || {}).errorText; } });
page.on("response", async (r) => {
  const u = r.url();
  if (/\/(api\/)?prompt$/.test(new URL(u).pathname) && r.request().method() === "POST") {
    try { const b = JSON.parse(r.request().postData() || "{}"); const j = await r.json();
      prompts.push({ at: Date.now(), host: new URL(u).host, angle: b.angle, test: b.test === true, delta: b.delta, color: b.item && b.item.colorHex,
        ocr: b.item && b.item.textOcr, prompt: j.prompt }); } catch (_) {}
  }
});

log("product", product, "clip", clip, DRY ? "(dry)" : "(BILLED)", NO_FABRIC ? "NO-FABRIC" : "");
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
await room.locator("#height").fill(HW[0]);
await room.locator("#weight").fill(HW[1]);
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
writeFileSync(`${out}/preview.json`, JSON.stringify({ pre, prompts, boxes: [...boxes.values()] }, null, 1));
await page.screenshot({ path: `${out}/preview.png` });
const sizesOffered = await room.evaluate(() => [...document.querySelectorAll(".pear-sz-btn")].map((b) => b.dataset.sz + (/active|is-on|selected|chosen|recommended/.test(b.className) ? "*" : "")));
log("sizes offered (* = active)", JSON.stringify(sizesOffered), "for", HW.join("cm/") + "kg");
if (DRY) {
  const pace = await room.evaluate(async () => {
    window.__rigPlay(); const f0 = window.__rig.camFrames, l0 = window.__rig.lag.length; await new Promise((r) => setTimeout(r, 8000));
    const lag = window.__rig.lag.slice(l0).sort((a, b) => a - b);
    return { camFps: (window.__rig.camFrames - f0) / 8, lagP50: Math.round(lag[lag.length >> 1]), lagMax: Math.round(lag[lag.length - 1]),
      clipAt: Math.round(window.__rigClip.currentTime * 1000), over100: lag.filter((x) => x > 100).length, top: lag.slice(-4).map(Math.round), firstBig: window.__rig.lag.slice(l0).findIndex((x) => x > 300) * 50 };
  });
  log("dry pace", JSON.stringify(pace)); writeFileSync(`${out}/pace.json`, JSON.stringify(pace));
  writeFileSync(`${out}/network-audit.json`, JSON.stringify(net, null, 1));
  log("network audit", JSON.stringify({ responses: net.responses, frames: net.frames, secrets: net.secrets, words: net.words, promptIn: net.promptIn }));
  log("dry run done - nothing billed"); await browser.close(); process.exit(0);
}

let sizeInfo = null;
if (SIZE) {
  sizeInfo = await room.evaluate((want) => {
    const btns = [...document.querySelectorAll(".pear-sz-btn")];
    const before = btns.filter((b) => /active|is-on|selected|chosen/.test(b.className)).map((b) => b.dataset.sz);
    const b = btns.find((x) => x.dataset.sz === want);
    if (b) b.click();
    const after = btns.filter((x) => /active|is-on|selected|chosen/.test(x.className)).map((x) => x.dataset.sz);
    return { offered: btns.map((x) => x.dataset.sz), recommendedOrActiveBefore: before, clicked: !!b, activeAfter: after };
  }, SIZE);
  log("size", JSON.stringify(sizeInfo));
  if (!sizeInfo.clicked) { log("size", SIZE, "is not offered - stopping before go-live, nothing billed"); await browser.close(); process.exit(2); }
}
await room.waitForFunction(() => !document.getElementById("captureBtn").disabled, null, { timeout: 60000 });
const t0 = Date.now();
await click("#captureBtn");
const goLiveAt = Date.now();
log("GO LIVE pressed");
/* The turn plays from the reveal, and every 100ms the output and the input are grabbed (both at 320 wide) for 7s. */
/* A reveal OR the room's own error - whichever comes first; a stuck go-live leaves its screen and words behind. */
const outcome = await room.waitForFunction(() => {
  if (document.querySelector(".camera-card.show-live")) return "live";
  const e = document.getElementById("camError");
  return e && !e.hidden && e.textContent.trim() ? "error: " + e.textContent.trim().slice(0, 200) : false;
}, null, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => "timeout");
if (outcome !== "live") {
  await page.screenshot({ path: `${out}/stuck.png` });
  log("NO REVEAL -", outcome);
  await room.waitForTimeout(3000);
  await browser.close();
  process.exit(3);
}
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
const boxTimes = [...boxes.values()].map((b) => ({ photo: b.url, askedBeforeGoLiveMs: goLiveAt - b.asked,
  answeredBeforeGoLiveMs: b.answered ? goLiveAt - b.answered : null, tookMs: b.answered ? b.answered - b.asked : null, error: b.error || null }));
log("boxes", JSON.stringify(boxTimes));
writeFileSync(`${out}/network-audit.json`, JSON.stringify(net, null, 1));
log("network audit", JSON.stringify({ responses: net.responses, frames: net.frames, secrets: net.secrets, words: net.words, promptIn: net.promptIn, token: net.token }));
writeFileSync(`${out}/session.json`, JSON.stringify({ product, clip, synthetic: !!SYNTH, hw: HW, noFabric: NO_FABRIC, size: SIZE, sizeInfo, boxTimes, revealMs, facts, prompts, ended: new Date().toISOString() }, null, 1));
log("frames", frames.length, "prompts seen", prompts.length);
await browser.close();
