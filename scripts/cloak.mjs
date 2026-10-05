/* ============================================================================
   cloak.mjs — no engine name survives in a file a shopper downloads (2026-10-03)
   ----------------------------------------------------------------------------
   ASKED: "nobody should be able to see anything in the code - not the render engine, not
   the classifier, nothing related to any AI we use." The room's OWN code simply stops
   naming them (app.js, server responses). Third-party code cannot: the render SDK, the
   media library inside it and the pose model's loader use those names AT RUNTIME - as
   protobuf type names, graph option names, URLs, error classes, object keys. Renaming
   them breaks the code; leaving them leaves the vendor readable in DevTools.

   SO THIS REWRITES THE SYNTAX, NOT THE VALUES. Every place a matching word can live in a
   parsed program becomes an expression that produces the same value at runtime:
     · a string literal                    "x"            -> D("…")
     · a template literal with a match     `a${e}b`       -> (D("…")+String(e)+"b")
     · a regex literal                     /x/g           -> new RegExp(D("…"),"g")
     · a member name                       o.x / o?.x     -> o[D("…")] / o?.[D("…")]
     · an object / pattern / class key     {x: v}         -> {[D("…")]: v}   (shorthand expanded)
   D() decodes a per-build XOR+base64 string once and caches it. Semantics are unchanged
   (a computed key is the same key; String(e) is the template's ToString). What it hides
   is TEXT: anyone may still run the code - the point is that reading it names nothing.

   PROTOCOL WORDS ARE RENAMED, NOT ENCODED (`rename`): a word that travels on the wire at
   runtime (a message type, a query key) would be decoded and SENT, readable in the
   Network tab. Those get a neutral alias in the bundle, and the edge (lib/rt-proxy.js)
   translates alias <-> real word on the way through.

   A FREE IDENTIFIER (a global the code reads by name) cannot be rewritten safely; it is
   reported in `unhandled` and the build fails on it.
   ============================================================================ */
import { parse } from "acorn";
import { randomBytes, createHash } from "node:crypto";

/** Every word that names an engine, a model or a vendor library we run. */
export const VENDOR_WORDS = /decart|livekit|lucy-|mediapipe|gemini|blaze_?face|blazepose|pose_landmarker|tasks[-_]vision|tflite|nano ?banana/i;

/**
 * @param {string} code  a complete program (a bundle)
 * @param {{ words?: RegExp, rename?: Record<string,string>, sourceType?: "module"|"script", seed?: string }} [opts]
 *   seed - a DETERMINISTIC cloak (the build's): the same input and seed give the same output, so a
 *   content-hashed file name stays the same across builds and stays cached. Without it, random per call.
 * @returns {{ code: string, encoded: number, renamed: number, unhandled: string[] }}
 */
export function cloak(code, { words = VENDOR_WORDS, rename = {}, sourceType = "module", seed = null } = {}) {
  const ast = parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  const det = seed === null ? null : createHash("sha256").update(`cloak:${seed}:`).update(code).digest();
  let fn, n = 0;
  do { fn = "$" + (det ? createHash("sha256").update(det).update(String(n++)).digest("hex").slice(0, 6) : randomBytes(3).toString("hex")); } while (code.includes(fn));
  const key = det ? det.subarray(0, 24) : randomBytes(24);
  const enc = (s) => { const b = Buffer.from(s, "utf8"); for (let i = 0; i < b.length; i++) b[i] ^= key[i % key.length]; return b.toString("base64"); };
  const has = (s) => typeof s === "string" && words.test(s);
  const renamed = (s) => Object.prototype.hasOwnProperty.call(rename, s);
  let encoded = 0, renames = 0;
  const unhandled = [];
  const D = (s) => { encoded++; return `${fn}(${JSON.stringify(enc(s))})`; };
  /* Minified code glues a keyword to a literal (`case"x":`, `return"x"`): an expression that starts with an
     identifier character needs the space the literal did not. */
  const glue = (node, text) => (/[A-Za-z0-9_$]/.test(code[node.start - 1] || "") && /^[A-Za-z0-9_$]/.test(text) ? " " + text : text);
  /* A key or a member name: a rename stays a plain name; a match becomes a computed key. */
  const keyText = (name) => {
    if (renamed(name)) { renames++; return { computed: false, text: rename[name] }; }
    if (has(name)) return { computed: true, text: D(name) };
    return null;
  };

  const children = (node) => {
    const out = [];
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range") continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") out.push(c); }
      else if (v && typeof v.type === "string") out.push(v);
    }
    return out.sort((a, b) => a.start - b.start);
  };
  /* The node's source with its children regenerated - the identity when nothing inside changed. */
  const stitch = (node, override = new Map()) => {
    let s = "", at = node.start;
    for (const c of children(node)) {
      if (c.start < at) continue;   // a child sharing its parent's range (a shorthand) is handled by the parent
      s += code.slice(at, c.start) + (override.has(c) ? override.get(c) : gen(c, node));
      at = c.end;
    }
    return s + code.slice(at, node.end);
  };

  function gen(node, parent) {
    switch (node.type) {
      case "Literal": {
        if (typeof node.value === "string") {
          if (parent && parent.type === "ExpressionStatement" && parent.directive) return code.slice(node.start, node.end);
          if (renamed(node.value)) { renames++; return JSON.stringify(rename[node.value]); }
          if (has(node.value)) return glue(node, D(node.value));
        } else if (node.regex && has(node.regex.pattern)) {
          return glue(node, `new RegExp(${D(node.regex.pattern)},${JSON.stringify(node.regex.flags)})`);
        }
        return code.slice(node.start, node.end);
      }
      case "TemplateLiteral": {
        if (parent && parent.type === "TaggedTemplateExpression") {
          if (node.quasis.some((q) => has(q.value.raw))) unhandled.push(`tagged template: ${code.slice(node.start, node.start + 60)}`);
          return stitch(node);
        }
        const cooked = node.quasis.map((q) => q.value.cooked);
        if (!cooked.some((q) => has(q) || renamed(q))) return stitch(node);
        const parts = [];
        node.quasis.forEach((q, i) => {
          const v = q.value.cooked;
          if (v) parts.push(renamed(v) ? JSON.stringify(rename[v]) : has(v) ? D(v) : JSON.stringify(v));
          if (i < node.expressions.length) parts.push(`String(${gen(node.expressions[i], node)})`);
        });
        return `(${parts.length ? parts.join("+") : '""'})`;
      }
      case "MemberExpression": {
        if (!node.computed && node.property.type === "Identifier") {
          const k = keyText(node.property.name);
          if (k) {
            const obj = gen(node.object, node);
            if (!k.computed) return `${obj}${node.optional ? "?." : "."}${k.text}`;
            return `${obj}${node.optional ? "?." : ""}[${k.text}]`;
          }
        }
        return stitch(node);
      }
      case "Property": {
        if (!node.computed && (node.key.type === "Identifier" || (node.key.type === "Literal" && typeof node.key.value === "string"))) {
          const name = node.key.type === "Identifier" ? node.key.name : node.key.value;
          const k = keyText(name);
          if (k) {
            const keyOut = k.computed ? `[${k.text}]` : k.text;
            if (node.shorthand) {
              /* {x} / {x = 1} (a pattern default): the value carries the binding. */
              return `${keyOut}:${gen(node.value, node)}`;
            }
            return code.slice(node.start, node.key.start) + keyOut + stitch({ ...node, start: node.key.end, key: null, type: "PropertyRest" });
          }
        }
        return stitch(node);
      }
      case "MethodDefinition":
      case "PropertyDefinition": {
        if (!node.computed && (node.key.type === "Identifier" || (node.key.type === "Literal" && typeof node.key.value === "string"))) {
          const name = node.key.type === "Identifier" ? node.key.name : node.key.value;
          const k = keyText(name);
          if (k) return code.slice(node.start, node.key.start) + (k.computed ? `[${k.text}]` : k.text) + stitch({ ...node, start: node.key.end, key: null });
        }
        return stitch(node);
      }
      case "Identifier": {
        /* A binding or a free reference that names a vendor: a global the code reads by name. Not rewritable. */
        if (has(node.name)) unhandled.push(`identifier ${node.name}`);
        return code.slice(node.start, node.end);
      }
      default:
        return stitch(node);
    }
  }

  const body = gen(ast, null);
  const kb = JSON.stringify([...key]);
  const decoder = `var ${fn}=(()=>{const k=${kb},c=new Map,t=new TextDecoder;return s=>{let r=c.get(s);if(r===void 0){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i)^k[i%k.length];r=t.decode(u);c.set(s,r)}return r}})();`;
  /* A hashbang must stay first; nothing else in a bundle precedes the decoder. */
  const shebang = body.startsWith("#!") ? body.slice(0, body.indexOf("\n") + 1) : "";
  return { code: shebang + decoder + body.slice(shebang.length), encoded, renamed: renames, unhandled };
}

/** Every vendor word left readable in a text - the build's final guard. */
export function vendorHits(text, words = VENDOR_WORDS) {
  const re = new RegExp(words.source, words.flags.includes("g") ? words.flags : words.flags + "g");
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " "));
  return [...out];
}
