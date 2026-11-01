/* Runs side by side: the same crop of the room's output at the same moments, one row per run, each labelled.
   usage: node compare.mjs <out.png> <box x0,y0,x1,y1> <t1,t2,...ms> <label=runDir> [<label=runDir> ...] */
import { chromium } from "/Users/yairgertner/pear interface/node_modules/playwright/index.mjs";
import { readFileSync, readdirSync } from "node:fs";
const [outPng, boxA, tsA, ...runs] = process.argv.slice(2);
const box = boxA.split(",").map(Number), ts = tsA.split(",").map(Number);
const rows = runs.map((r) => { const [label, dir] = r.split("="); const files = readdirSync(`${dir}/f`).filter((f) => f.endsWith("-out.jpg")).sort();
  return { label, cells: ts.map((t) => { const f = files.reduce((a, x) => Math.abs(parseInt(x) - t) < Math.abs(parseInt(a) - t) ? x : a);
    return { t: parseInt(f), src: "data:image/jpeg;base64," + readFileSync(`${dir}/f/${f}`).toString("base64") }; }) }; });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.setContent(`<style>body{margin:0;background:#111;color:#eee;font:13px sans-serif}.r{display:flex;gap:4px;align-items:flex-start;margin:4px}
.l{width:120px;padding-top:20px}.c{width:200px}.c div{font-size:11px}canvas{width:200px;display:block}</style><div id=g></div>`);
await p.evaluate(async ([rows, box]) => {
  for (const r of rows) {
    const row = document.createElement("div"); row.className = "r"; row.innerHTML = `<div class=l>${r.label}</div>`;
    for (const c of r.cells) {
      const im = new Image(); im.src = c.src; await new Promise((ok) => (im.onload = ok));
      const [x0, y0, x1, y1] = box; const sw = im.naturalWidth * (x1 - x0), sh = im.naturalHeight * (y1 - y0);
      const cv = document.createElement("canvas"); cv.width = 200; cv.height = Math.round(200 * sh / sw);
      cv.getContext("2d").drawImage(im, im.naturalWidth * x0, im.naturalHeight * y0, sw, sh, 0, 0, cv.width, cv.height);
      const d = document.createElement("div"); d.className = "c"; d.innerHTML = `<div>${(c.t / 1000).toFixed(1)}s</div>`; d.appendChild(cv); row.appendChild(d);
    }
    document.getElementById("g").appendChild(row);
  }
}, [rows, box]);
await p.screenshot({ path: outPng, fullPage: true }); await b.close(); console.log(outPng);
