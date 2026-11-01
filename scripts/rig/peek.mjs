/* One still per clip at 0.5s and 3s, side by side, to see what the camera input wears before spending a credit on it.
   usage: node peek.mjs out.png clip1.mp4 clip2.mp4 ... */
import { chromium } from "/Users/yairgertner/pear interface/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
const [outPng, ...clips] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 400 } });
await p.setContent("<body style='margin:0;background:#111;color:#eee;font:11px sans-serif'><div id=g style='display:grid;grid-template-columns:repeat(4,1fr);gap:4px'></div></body>");
for (const [i, c] of clips.entries()) {
  const url = "data:video/mp4;base64," + readFileSync(c).toString("base64");
  await p.evaluate(async ([url, i, name]) => {
    const v = document.createElement("video"); v.src = url; v.muted = true; await new Promise((r) => (v.onloadeddata = r));
    for (const t of [0.5, 3.0]) {
      v.currentTime = t; await new Promise((r) => (v.onseeked = r));
      const cv = document.createElement("canvas"); cv.width = 340; cv.height = 340 * v.videoHeight / v.videoWidth;
      cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
      const d = document.createElement("div"); d.textContent = `#${i} ${name.slice(-34)} @${t}s`; d.appendChild(document.createElement("br")); d.appendChild(cv);
      document.getElementById("g").appendChild(d);
    }
  }, [url, i, c.split("/").pop()]);
}
await p.screenshot({ path: outPng, fullPage: true }); await b.close(); console.log(outPng);
