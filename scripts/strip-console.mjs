/* ============================================================================
   strip-console.mjs - removes the room's narrating console calls BEFORE esbuild
   ----------------------------------------------------------------------------
   WHY THIS EXISTS (2026-11-01). build.mjs lists console.log/warn/… as `pure`, but
   esbuild only removes a pure call whose RESULT IS UNUSED, and it keeps any template
   literal with ${…} in it (toString() may have side effects). Three shapes therefore
   shipped narration to every shopper's DevTools:

     .catch((e) => console.warn("[PEAR] … failed:", e))   arrow returns the call → kept
     (ok ? console.log : console.warn)(`…`)                callee not named → kept
     console.log(`[PEAR] stream continuity: … ${x}`)       call removed, the template's
                                                           static text left behind

   This pass parses the source (acorn, already a devDependency) and replaces every
   narrating call - arguments included - with `void 0`, which is what `drop: ["console"]`
   does, minus console.error: that one stays, it is what a real failure leaves behind.

   WHAT IT NEVER DOES: touch a file on disk (build.mjs feeds it text and writes only to
   dist/), or touch the source the tests, trace:prompt and the ?pear_debug support view
   run on.
   ============================================================================ */
import * as acorn from "acorn";

export const NARRATING = new Set([
  "log", "info", "debug", "warn", "group", "groupCollapsed", "groupEnd", "table", "dir", "trace",
]);

const isNarratingMember = (n) =>
  n && n.type === "MemberExpression" && !n.computed &&
  n.object.type === "Identifier" && n.object.name === "console" &&
  n.property.type === "Identifier" && NARRATING.has(n.property.name);

/* console.log(…), console.log.call/apply(…), and (cond ? console.log : console.warn)(…) */
function isNarratingCall(node) {
  if (node.type !== "CallExpression") return false;
  const c = node.callee;
  if (isNarratingMember(c)) return true;
  if (c.type === "MemberExpression" && !c.computed && isNarratingMember(c.object) &&
      c.property.type === "Identifier" && (c.property.name === "call" || c.property.name === "apply")) return true;
  if (c.type === "ConditionalExpression" && isNarratingMember(c.consequent) && isNarratingMember(c.alternate)) return true;
  return false;
}

/* An argument that WRITES something (x = …, x++, delete) would change behaviour when dropped -
   a log line must never carry one. Reported, and the build refuses it. */
function writesInside(node) {
  let found = null;
  (function visit(n) {
    if (found || !n || typeof n.type !== "string") return;
    if (n.type === "AssignmentExpression" || n.type === "UpdateExpression" ||
        (n.type === "UnaryExpression" && n.operator === "delete")) { found = n; return; }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(node);
  return found;
}

/**
 * @param {string} code
 * @param {{ sourceType?: "module" | "script" }} [opts]
 * @returns {{ code: string, removed: number, unsafe: string[] }}
 */
export function stripConsole(code, { sourceType = "module" } = {}) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true });
  } catch (e) {
    if (sourceType === "module") return stripConsole(code, { sourceType: "script" });
    throw e;
  }
  const hits = [];
  const unsafe = [];
  (function visit(n) {
    if (!n || typeof n.type !== "string") return;
    if (isNarratingCall(n)) {
      const w = writesInside(n);
      if (w) unsafe.push(code.slice(n.start, Math.min(n.end, n.start + 120)));
      else { hits.push(n); return; }   // outermost only - its arguments go with it
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(ast);
  hits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const h of hits) out = out.slice(0, h.start) + "void 0" + out.slice(h.end);
  return { code: out, removed: hits.length, unsafe };
}
