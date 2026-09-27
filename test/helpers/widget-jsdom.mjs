/* Loads widget/pear-widget.js into jsdom against a storefront page, clicks the PEAR
   button, and hands back the iframe URL's params - the same real-injection pattern
   stock-dom-scrape / size-chart-scrape use, factored out for the suites that only need
   "what did the widget send the room". Not a test itself (not listed in run.mjs). */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

export const WIDGET = readFileSync(new URL("../../widget/pear-widget.js", import.meta.url), "utf8");
export const PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
export const SHOP = "https://cdn.shopify.com/s/files/1/0842/1823292409";

/** A minimal PDP: two gallery photos, a cart button, and whatever `extra` markup. */
export const PDP = (extra = "", head = "") => `<html lang="en"><head>
  <meta property="og:image" content="${SHOP}-1.jpg?width=1400">${head}</head><body>
  <h1>Classic Tee</h1>
  <ul class="product__media-list">
    <li><img src="${SHOP}-1.jpg?width=800" alt="front"></li>
    <li><img src="${PX}" data-src="${SHOP}-2_back.jpg?width=800" alt="back"></li>
  </ul>
  ${extra}
  <form action="/cart/add" method="post"><input name="id" value="99"><button type="submit" name="add">Add to cart</button></form>
</body></html>`;

export const ldScript = (obj) =>
  `<script type="application/ld+json">${typeof obj === "string" ? obj : JSON.stringify(obj)}</script>`;

/**
 * @param {string} html
 * @param {{url?: string, productJson?: object|null}} [opts]
 * @returns {Promise<{params: URLSearchParams, errors: string[], logs: string[]}>}
 */
export async function openWidget(html, { url = "https://shop.example.com/products/tee", productJson = null } = {}) {
  const errors = [], logs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(`jsdomError: ${e.message}`));
  vc.on("error", (...a) => errors.push(`console.error: ${a.join(" ")}`));
  vc.on("log", (...a) => logs.push(a.join(" ")));
  const dom = new JSDOM(html, { runScripts: "dangerously", url, virtualConsole: vc });
  const { window } = dom;
  const path = new URL(url).pathname.replace(/\/$/, "");
  window.fetch = (u, opts) => {
    const s = String(u);
    if (s.includes("/api/classify-images")) {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        results: body.images.map((x) => (/back|rear/i.test(x) ? "back" : "front")),
        front_image_url: body.front_image_url, back_image_url: "", back_source: "none",
      }) });
    }
    if (s.endsWith(path + ".js")) {
      if (!productJson) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productJson) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  const s = window.document.createElement("script");
  s.setAttribute("data-pear-key", "TEST_KEY");
  s.textContent = WIDGET;
  window.document.head.appendChild(s);
  if (window.document.readyState === "loading") {
    await new Promise((r) => window.document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  window.dispatchEvent(new window.Event("load"));
  await new Promise((r) => setTimeout(r, 40));
  const btn = window.document.querySelector(".pear-widget-btn");
  if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const iframe = window.document.querySelector(".pear-widget-frame");
  const params = new URLSearchParams(iframe ? (iframe.src.split("?")[1] || "") : "");
  /* Closed HERE, always: an open jsdom window keeps the widget's timers alive and the
     suite process never exits. Callers get the params and the captured logs only. */
  window.close();
  return { params, errors, logs };
}
