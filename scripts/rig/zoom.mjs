/* Zoomed torso crops of the output at chosen moments, the product photo beside them, and each crop's median fabric colour
   (the darkest half of the torso box - the print is light, the fabric is the dark part).
   usage: node zoom.mjs <runDir> <productPhotoUrl> <box x0,y0,x1,y1 as fractions> <t1,t2,...ms> [name=zoom.png] */
import { chromium } from "/Users/yairgertner/pear interface/node_modules/playwright/index.mjs";
import { readFileSync, readdirSync } from "node:fs";
const [dir, photo, boxA, tsA, name = "zoom.png"] = process.argv.slice(2);
const box = boxA.split(",").map(Number);
const files = readdirSync(`${dir}/f`).filter((f) => f.endsWith("-out.jpg")).sort();
const pick = tsA.split(",").map(Number).map((t) => files.reduce((a, f) => Math.abs(parseInt(f) - t) < Math.abs(parseInt(a) - t) ? f : a));
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 700 } });
await p.setContent(`<style>body{margin:0;background:#111;color:#eee;font:12px sans-serif}#g{display:flex;flex-wrap:wrap;gap:6px;padding:6px}
.c{width:180px}.c canvas,.c img{width:180px;display:block}.sw{height:22px}</style><div id=g></div>`);
const res = await p.evaluate(async ([cells, box, photo]) => {
  const out = [];
  const add = (label, src, crop) => new Promise((ok) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => {
    const [x0, y0, x1, y1] = crop ? box : [0, 0, 1, 1];
    const sw = im.naturalWidth * (x1 - x0), sh = im.naturalHeight * (y1 - y0);
    const cv = document.createElement("canvas"); cv.width = 180; cv.height = Math.round(180 * sh / sw);
    const cx = cv.getContext("2d"); cx.drawImage(im, im.naturalWidth * x0, im.naturalHeight * y0, sw, sh, 0, 0, cv.width, cv.height);
    /* the fabric: the central 60% of the crop, darkest half of its pixels, per-channel median */
    const d = cx.getImageData(cv.width * 0.2, cv.height * 0.2, cv.width * 0.6, cv.height * 0.5).data; const px = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2], d[i] + d[i + 1] + d[i + 2]]);
    px.sort((a, z) => a[3] - z[3]); const dark = px.slice(0, px.length >> 1);
    const med = (k) => { const v = dark.map((q) => q[k]).sort((a, z) => a - z); return v[v.length >> 1]; };
    const rgb = [med(0), med(1), med(2)]; const hex = "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    const el = document.createElement("div"); el.className = "c"; el.innerHTML = `<div>${label} ${hex}</div>`; el.appendChild(cv);
    const s = document.createElement("div"); s.className = "sw"; s.style.background = hex; el.appendChild(s);
    document.getElementById("g").appendChild(el); out.push({ label, hex, rgb }); ok(); }; im.onerror = () => ok(); im.src = src; });
  await add("product", photo, false);
  for (const c of cells) await add(c.label, c.src, true);
  return out;
}, [pick.map((f) => ({ label: `${(parseInt(f) / 1000).toFixed(1)}s`, src: "data:image/jpeg;base64," + readFileSync(`${dir}/f/${f}`).toString("base64") })), box, photo]);
await p.screenshot({ path: `${dir}/${name}`, fullPage: true }); await b.close();
console.log(JSON.stringify(res)); console.log(`${dir}/${name}`);
