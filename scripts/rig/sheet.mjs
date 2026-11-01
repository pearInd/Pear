/* Contact sheet: every Nth grabbed moment, the camera input (cut from the clip at the moment's own clip time) above the room's
   output, labelled with seconds since the reveal. usage: node sheet.mjs <runDir> [step=2] [from=0] [to=7000] [name=sheet.png] */
import { chromium } from "/Users/yairgertner/pear interface/node_modules/playwright/index.mjs";
import { readFileSync, existsSync } from "node:fs";
const [dir, stepA = "2", fromA = "0", toA = "7000", name = "sheet.png"] = process.argv.slice(2);
const frames = JSON.parse(readFileSync(`${dir}/frames.json`, "utf8")).filter((f, i) => i % Number(stepA) === 0 && f.t >= Number(fromA) && f.t <= Number(toA));
const clip = JSON.parse(readFileSync(`${dir}/session.json`, "utf8")).clip;
const b64 = (p) => readFileSync(p).toString("base64");
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
await p.setContent(`<style>body{margin:0;background:#111;font:11px sans-serif;color:#eee}.g{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;padding:4px}
.c img,.c canvas{width:100%;display:block}.l{padding:2px}</style><div class=g id=g></div>`);
await p.evaluate(async ([clipB64, cells]) => {
  const v = document.createElement("video"); v.src = "data:video/mp4;base64," + clipB64; v.muted = true; await new Promise((r) => (v.onloadeddata = r));
  for (const c of cells) {
    const d = document.createElement("div"); d.className = "c";
    d.innerHTML = `<div class=l>${(c.t / 1000).toFixed(1)}s · clip ${(c.clipT / 1000).toFixed(2)}</div>`;
    v.currentTime = c.clipT / 1000; await new Promise((r) => (v.onseeked = r));
    const cv = document.createElement("canvas"); cv.width = 320; cv.height = Math.round(320 * v.videoHeight / v.videoWidth);
    cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height); d.appendChild(cv);
    const im = document.createElement("img"); im.src = "data:image/jpeg;base64," + c.out; d.appendChild(im);
    document.getElementById("g").appendChild(d); await new Promise((r) => (im.complete ? r() : (im.onload = r)));
  }
}, [b64(clip), frames.map((f) => { const n = String(f.t).padStart(5, "0"); const op = `${dir}/f/${n}-out.jpg`;
  return { t: f.t, clipT: f.clipT, out: existsSync(op) ? b64(op) : "" }; })]);
await p.screenshot({ path: `${dir}/${name}`, fullPage: true }); await b.close();
console.log(`${dir}/${name}`, frames.length, "moments");
