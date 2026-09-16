/* SINGLE-VERIFICATION OTP - "it asked me for the code twice"
   ─────────────────────────────────────────────────────────────────────────────
   THE REPORT THIS CLOSES: a shopper enters the 6-digit code once, and is then
   asked for a code AGAIN before the fitting room opens. Three independent paths
   produced that one symptom, and all three are pinned here.

   ROOT CAUSE 1 - the re-entry guard was a DOM property, and the keyboard path
   never consulted it. Both submitIdentity() and verifyOtp() marked themselves
   "busy" by setting btn.disabled = true. That stops a second CLICK and nothing
   else: setupOtpScreen()/showIdentityGate() also bind Enter on the <input>s, and
   those handlers call the function directly. Two fast Enters - the single most
   ordinary way to submit a 6-digit code - dispatched the request twice, because
   `disabled` on a <button> says nothing about a keydown on an <input>.

   Why a second dispatch COSTS the shopper a code, rather than being harmless:
   the server's OTP store is destructive on BOTH ends.
     · /api/send-otp   does otpStore.set(email, …) - last write wins. Two sends
       mint two different codes and email both. The shopper types the code from
       the first mail to arrive; the server is only holding the second. →
       "Wrong code. Try again." → they go and enter a SECOND code.
     · /api/verify-otp did otpStore.delete(email) on success. Of two in-flight
       verifies carrying the SAME correct code, one wins and one comes back
       `expired` - and whichever response settles last is the one that paints. →
       "That code expired. Send a new one" on a shopper who just verified. →
       they enter a SECOND code.

   ROOT CAUSE 2 - nothing was persisted at the moment the code was accepted.
   verifyOtp() got `{ ok: true }` - the server had ALREADY consumed the code and
   would never accept it again - and then, still having written nothing to
   localStorage, started a SECOND network round trip (POST /api/users) and only
   called setDeviceId()/stampAuthDate() if that one came back too. Anything that
   lost that second response - a 5xx, a timeout, a backgrounded iframe torn down
   mid-flight, a reload - threw away proof of ownership that no longer existed
   anywhere. Next load: no device id → the full identity gate and a fresh OTP.
   The window is a whole Supabase round trip wide, on mobile connections.

   ROOT CAUSE 3 - the degrade paths in finishRegistration() called setDeviceId()
   but never stampAuthDate(). A shopper who verified during an infra wobble was
   let in, and then re-gated by isAuthRefreshDue() on their very next visit,
   because the auth clock had never been stamped at all. Fixed by ROOT CAUSE 2's
   stamp landing at verification time, upstream of every degrade path.

   THE INVARIANT ALL OF THIS DEFENDS: one correct code entered once = access.
   §1-§2 pin the client guards, §3-§4 pin persist-on-accept, §5 pins the server
   half - verification is IDEMPOTENT within the code's own 60s TTL, so a retry
   or a raced duplicate can never be the thing that invalidates a good code.

   EXTRACT MARKER (CLAUDE.md §2.6): this suite slices app.js from the literal
   `const OTP_IN_FLIGHT = { send: false, verify: false };` and server.js from
   `const otpStore = new Map();`. The guard object is declared INSIDE the sliced
   region on purpose - a module-scope flag above the marker would die on a
   ReferenceError in the sandbox while the real file stayed fine (§2.6).
   ============================================================================= */
import { readFileSync } from "node:fs";

const APP    = readFileSync(new URL("../fitting-room/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SERVER = readFileSync(new URL("../server.js",           import.meta.url), "utf8").replace(/\r\n/g, "\n");

let fails = 0;
function check(label, cond, detail) {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${detail}`);
}

function extract(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find "${startMarker}"`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`could not find end marker "${endMarker}" after "${startMarker}"`);
  return src.slice(start, end);
}

const load = (code, exports) =>
  import("data:text/javascript," + encodeURIComponent(code + "\nexport {" + exports.join(",") + "};"));

/* ── the OTP/identity block of app.js, run headless ──────────────────────────
   Everything the block reaches for that lives elsewhere in app.js ($, t, toast,
   routeUser, the countdown, the device-id accessors) is stubbed here. __state
   records the ORDER of every side effect and every request, which is what §3
   needs: "was the session written before the /api/users round trip started".  */
const CLIENT_PRELUDE = `
let PEAR_OTP_PENDING = null;
let PEAR_REAUTH_USER = null;

const __state = { order: [], routed: [], sizeFormShown: 0, toasts: [], storage: {}, logs: [] };
const __els = {};

function $(id) {
  if (!__els[id]) __els[id] = {
    id, value: "", textContent: "", hidden: false, disabled: false,
    dataset: {}, style: {}, focus() {}, addEventListener() {},
  };
  return __els[id];
}

const t = (k) => k;
const console = {
  log:  (...a) => __state.logs.push(a.join(" ")),
  warn: (...a) => __state.logs.push(a.join(" ")),
  error:(...a) => __state.logs.push(a.join(" ")),
};

function toast(m) { __state.toasts.push(m); }
function routeUser(u) { __state.order.push("routeUser"); __state.routed.push(u); }
function showSizeForm() { __state.order.push("showSizeForm"); __state.sizeFormShown++; }
function startOtpCountdown() {}
function stopOtpCountdown() {}
function clearReturningCheckGate() {}

function getDeviceId() { return __state.storage.pear_device_id || ""; }
function setDeviceId(v) { __state.order.push("setDeviceId"); __state.storage.pear_device_id = v; }
function stampAuthDate() { __state.order.push("stampAuthDate"); __state.storage.pear_last_auth_date = new Date().toISOString(); }
function newUuid() { return "uuid-fresh-device"; }

let __fetchImpl = async () => ({ ok: false, status: 500, json: async () => null });
function __setFetch(fn) { __fetchImpl = fn; }
const fetch = (url, init) => { __state.order.push("fetch:" + url); return __fetchImpl(url, init); };

function __setPending(p) { PEAR_OTP_PENDING = p; }
function __setReauth(u) { PEAR_REAUTH_USER = u; }
function __getPending() { return PEAR_OTP_PENDING; }
`;

const CLIENT_BLOCK = extract(
  APP,
  "const OTP_IN_FLIGHT = { send: false, verify: false };",
  "/**\n * Send the visitor's measurements",
);

const CLIENT_EXPORTS = [
  "verifyOtp", "submitIdentity", "resendOtp", "hideOtpScreen", "showOtpScreen",
  "finishRegistration", "$", "__state", "__setFetch", "__setPending", "__setReauth", "__getPending",
];

/* Node caches ESM by URL, and a data: URL IS its URL - without the counter every
   freshClient() in this file would hand back ONE shared module instance and the
   §s would silently score each other's side effects. */
let __sandboxSeq = 0;
async function freshClient() {
  return load(`/* sandbox ${++__sandboxSeq} */\n` + CLIENT_PRELUDE + "\n" + CLIENT_BLOCK, CLIENT_EXPORTS);
}

/* A stand-in for the two server endpoints, with the SAME destructive semantics
   the real ones have: send overwrites, verify consumes. The client is supposed
   to be the thing that never provokes them. */
function fakeBackend(opts = {}) {
  const codes = new Map();           // email -> code currently valid
  const calls = { send: 0, verify: 0, users: 0, relink: 0 };
  const sent  = [];                  // every code the shopper was emailed
  if (opts.seed) codes.set(opts.seed.email, opts.seed.code);

  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  return {
    calls, sent, codes,
    impl: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (url === "/api/send-otp") {
        calls.send++;
        const code = String(100000 + calls.send);   // a DIFFERENT code every send
        codes.set(body.email, code);
        sent.push(code);
        return json({ ok: true });
      }
      if (url === "/api/verify-otp") {
        calls.verify++;
        const have = codes.get(body.email);
        if (have === undefined) return json({ ok: false, error: "expired" });
        if (have !== String(body.code)) return json({ ok: false, error: "invalid" });
        codes.delete(body.email);                   // single-use, exactly like server.js
        return json({ ok: true });
      }
      if (url === "/api/users") {
        calls.users++;
        if (opts.usersHangs) return new Promise(() => {});
        if (opts.usersStatus && opts.usersStatus !== 200) {
          return json({ ok: false, error: "upstream" }, opts.usersStatus);
        }
        return json({ ok: true, user: { id: "u1", name: body.name, email: body.email, height: 170, weight: 65 } });
      }
      if (url === "/api/users/relink") { calls.relink++; return json({ id: "u1", name: "Dana", email: body.email }); }
      throw new Error("unexpected request: " + url);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

/* ══════════════════════════════════════════════════════════════════════════════
   §1 verifyOtp() - two Enters must not spend two verifications
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §1 the code is verified ONCE, however hard the shopper hits Enter ──");
{
  const m = await freshClient();
  const be = fakeBackend({ seed: { email: "dana@example.com", code: "424242" } });
  m.__setFetch(be.impl);
  m.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });
  m.$("otp-error").hidden = true;                    // the state showOtpScreen() leaves behind

  // Two synchronous calls - EXACTLY what two fast Enters on #otpInput produce,
  // since that handler calls verifyOtp() directly and never looks at the button.
  const a = m.verifyOtp("424242");
  const b = m.verifyOtp("424242");
  await Promise.all([a, b]);
  await tick();

  check("§1.1 exactly one /api/verify-otp was dispatched",
        be.calls.verify === 1, `dispatched ${be.calls.verify}`);
  check("§1.2 the shopper is never told a code they just used 'expired'",
        m.$("otp-error").hidden === true && m.$("otp-error").textContent === "",
        `#otp-error visible with: ${m.$("otp-error").textContent}`);
  check("§1.3 the visitor is routed into the room exactly once",
        m.__state.routed.length === 1, `routed ${m.__state.routed.length}x`);
  check("§1.4 the second Enter is a silent no-op, not an error toast",
        m.__state.toasts.length === 0, JSON.stringify(m.__state.toasts));
}

/* A guard that never releases is worse than no guard - it would strand a shopper
   who mistypes once. */
{
  const m = await freshClient();
  const be = fakeBackend({ seed: { email: "dana@example.com", code: "424242" } });
  m.__setFetch(be.impl);
  m.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });
  m.$("otp-error").hidden = true;

  await m.verifyOtp("000000");                       // wrong
  check("§1.5 a wrong code still reports back", m.$("otp-error").hidden === false);
  await m.verifyOtp("424242");                       // now right - guard must have released
  check("§1.6 the guard releases, so a retry after a typo still works",
        m.__state.routed.length === 1 && be.calls.verify === 2,
        `routed ${m.__state.routed.length}, verify calls ${be.calls.verify}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   §2 submitIdentity() - two Enters must not mint two codes
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §2 one 'Continue' = one code in the shopper's inbox ──");
{
  const m = await freshClient();
  const be = fakeBackend();
  m.__setFetch(be.impl);
  m.$("userName").value  = "Dana";
  m.$("userEmail").value = "dana@example.com";

  const a = m.submitIdentity();
  const b = m.submitIdentity();
  await Promise.all([a, b]);
  await tick();

  check("§2.1 exactly one /api/send-otp was dispatched",
        be.calls.send === 1, `dispatched ${be.calls.send}`);
  check("§2.2 only one code exists, so the one that arrives is the one that works",
        be.sent.length === 1, JSON.stringify(be.sent));

  // And the code the shopper actually received still verifies.
  m.__setFetch(be.impl);
  await m.verifyOtp(be.sent[0]);
  await tick();
  check("§2.3 the emailed code verifies first try",
        m.__state.routed.length === 1, `routed ${m.__state.routed.length}`);
}

{
  const m = await freshClient();
  const be = fakeBackend();
  m.__setFetch(be.impl);
  m.$("userName").value  = "D";                      // too short
  m.$("userEmail").value = "dana@example.com";
  await m.submitIdentity();
  check("§2.4 a rejected form never burns a send", be.calls.send === 0);
  m.$("userName").value = "Dana";
  await m.submitIdentity();
  check("§2.5 …and the guard released, so the corrected form sends", be.calls.send === 1);
}

/* A resend legitimately mints a NEW code, so it keeps no send guard of its own -
   but it must not overwrite the code a verify is already on the wire with. */
{
  const m = await freshClient();
  const be = fakeBackend({ seed: { email: "dana@example.com", code: "424242" }, usersHangs: true });
  m.__setFetch(be.impl);
  m.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });

  m.verifyOtp("424242");                             // in flight, not awaited
  await m.resendOtp();                               // shopper gets impatient
  check("§2.6 a resend cannot overwrite the code a verify is already checking",
        be.calls.send === 0, `send dispatched ${be.calls.send}`);

  // …and once the verify is no longer in flight, resend works normally.
  const m2 = await freshClient();
  const be2 = fakeBackend({ seed: { email: "dana@example.com", code: "424242" } });
  m2.__setFetch(be2.impl);
  m2.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });
  await m2.resendOtp();
  check("§2.7 …but an ordinary resend still sends", be2.calls.send === 1);
}

/* ══════════════════════════════════════════════════════════════════════════════
   §3 The session is written the INSTANT the code is accepted
   ─────────────────────────────────────────────────────────────────────────────
   The server consumed the code inside /api/verify-otp. From that moment the
   proof exists nowhere else, so it must be on disk before anything else is
   allowed to fail. /api/users hangs forever here to prove the ordering.
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §3 proof of ownership is stored before the next round trip, not after ──");
{
  const m = await freshClient();
  const be = fakeBackend({ seed: { email: "dana@example.com", code: "424242" }, usersHangs: true });
  m.__setFetch(be.impl);
  m.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });

  m.verifyOtp("424242");                             // deliberately NOT awaited
  await tick();

  check("§3.1 the device id is stored while /api/users is still in flight",
        m.__state.storage.pear_device_id === "dev-1", JSON.stringify(m.__state.storage));
  check("§3.2 the auth date is stamped while /api/users is still in flight",
        !!m.__state.storage.pear_last_auth_date, JSON.stringify(m.__state.storage));

  const order = m.__state.order;
  const stored = Math.max(order.indexOf("setDeviceId"), order.indexOf("stampAuthDate"));
  const usersAt = order.indexOf("fetch:/api/users");
  check("§3.3 both writes happen BEFORE the /api/users request, not after it",
        stored !== -1 && usersAt !== -1 && stored < usersAt, order.join(" → "));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §4 A degraded registration still counts as authenticated
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §4 an infra wobble never costs the shopper a second verification ──");
{
  const m = await freshClient();
  const be = fakeBackend({ seed: { email: "dana@example.com", code: "424242" }, usersStatus: 502 });
  m.__setFetch(be.impl);
  m.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });

  await m.verifyOtp("424242");
  await tick();

  check("§4.1 the shopper is let through to the measurement form",
        m.__state.sizeFormShown === 1, `shown ${m.__state.sizeFormShown}x`);
  check("§4.2 the device id survived the degrade",
        m.__state.storage.pear_device_id === "dev-1");
  check("§4.3 the auth clock was stamped, so the next visit is not re-gated",
        !!m.__state.storage.pear_last_auth_date,
        "unstamped → isAuthRefreshDue() returns true → full OTP again next load");
}

/* The 30-day re-auth path (Case 2): a known device re-proving ownership must be
   stamped too, and must route the EXISTING user rather than registering again. */
{
  const m = await freshClient();
  const be = fakeBackend({ seed: { email: "dana@example.com", code: "424242" } });
  m.__setFetch(be.impl);
  m.__setPending({ deviceId: "dev-1", name: "Dana", email: "dana@example.com" });
  m.__setReauth({ id: "u1", name: "Dana", email: "dana@example.com", height: 170, weight: 65 });

  const a = m.verifyOtp("424242");
  const b = m.verifyOtp("424242");                   // the same two-Enter race, on the re-auth path
  await Promise.all([a, b]);
  await tick();

  check("§4.4 re-auth verifies once", be.calls.verify === 1, `dispatched ${be.calls.verify}`);
  check("§4.5 re-auth never re-registers the user", be.calls.users === 0);
  check("§4.6 re-auth stamps the auth clock", !!m.__state.storage.pear_last_auth_date);
  check("§4.7 re-auth routes the existing profile once",
        m.__state.routed.length === 1 && m.__state.routed[0] && m.__state.routed[0].id === "u1",
        JSON.stringify(m.__state.routed));
}

/* ══════════════════════════════════════════════════════════════════════════════
   §5 The server half - verification is idempotent inside the code's own TTL
   ─────────────────────────────────────────────────────────────────────────────
   A client guard cannot cover a retry the client never chose: a dropped
   response, a mobile radio retransmitting the POST, a proxy replay. If the
   first attempt consumed the code, all of those become "enter a new code".
   Re-verifying the SAME code for the SAME email stays OK until the code's
   original 60s expiry - the window is NOT extended by consumption, so this adds
   no exposure a live code did not already have. A different code is still
   refused, and an expired one is still expired.
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §5 /api/verify-otp is idempotent, and still strictly time-boxed ──");
{
  const SERVER_PRELUDE = `
const __routes = {};
const app = { post: (p, _lim, h) => { __routes[p] = h; } };
const userLimiter = null;
const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const console = { log() {}, warn() {}, error() {} };
// Shadowed so /api/send-otp can never reach Resend from a test run, whatever
// RESEND_API_KEY happens to be set to in the shell.
const fetch = async () => { throw new Error("no network in tests"); };
function __res() {
  return { _status: 200, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; } };
}
`;
  const SERVER_BLOCK = extract(SERVER, "const otpStore = new Map();", "/* POST /api/users - identify");
  const s = await load(SERVER_PRELUDE + "\n" + SERVER_BLOCK, ["__routes", "__res", "otpStore", "OTP_TTL_MS"]);

  const verify = s.__routes["/api/verify-otp"];
  const call = (email, code) => { const r = s.__res(); verify({ body: { email, code } }, r); return r._body; };

  s.otpStore.set("dana@example.com", { code: 424242, expires: Date.now() + s.OTP_TTL_MS });

  check("§5.1 the first verification succeeds", call("dana@example.com", "424242")?.ok === true);
  check("§5.2 a duplicate of the SAME code succeeds too - a retry is not a failure",
        call("dana@example.com", "424242")?.ok === true,
        JSON.stringify(call("dana@example.com", "424242")));
  const wrong = call("dana@example.com", "999999");
  check("§5.3 a DIFFERENT code is still refused after consumption",
        wrong?.ok === false && wrong?.error === "invalid", JSON.stringify(wrong));

  // Consumption must not extend the code's life by a single millisecond.
  s.otpStore.set("stale@example.com", { code: 111111, expires: Date.now() - 1 });
  const stale = call("stale@example.com", "111111");
  check("§5.4 an expired code is expired, consumed or not",
        stale?.ok === false && stale?.error === "expired", JSON.stringify(stale));
  check("§5.5 …and the expired record is dropped from the store",
        s.otpStore.has("stale@example.com") === false);

  const unknown = call("nobody@example.com", "424242");
  check("§5.6 an email that was never sent a code is expired, not ok",
        unknown?.ok === false && unknown?.error === "expired", JSON.stringify(unknown));

  // The replay grace is scoped to ONE email - consuming Dana's code must not
  // make Ben's address verifiable with it.
  const crossed = call("ben@example.com", "424242");
  check("§5.7 the grace does not leak across emails",
        crossed?.ok === false && crossed?.error === "expired", JSON.stringify(crossed));

  /* Keeping consumed records means the map no longer frees itself on a
     successful verify, so /api/send-otp sweeps. This exercises that call path
     for real - it is the one line of the server change that §5.1-§5.7 never
     reach, and a typo there would only ever surface in production. */
  s.otpStore.set("dead@example.com",  { code: 222222, expires: Date.now() - 1,          consumed: true });
  s.otpStore.set("alive@example.com", { code: 333333, expires: Date.now() + 30_000 });
  const sendRes = s.__res();
  await s.__routes["/api/send-otp"]({ body: { email: "newcomer@example.com", name: "Newcomer" } }, sendRes);

  check("§5.8 send-otp sweeps the expired record a consumed verify no longer deletes",
        s.otpStore.has("dead@example.com") === false, [...s.otpStore.keys()].join(","));
  check("§5.9 …and leaves a still-live code for another shopper alone",
        s.otpStore.get("alive@example.com")?.code === 333333);
  check("§5.10 …and the newcomer's own code was minted before the mail was attempted",
        /^\d{6}$/.test(String(s.otpStore.get("newcomer@example.com")?.code || "")),
        JSON.stringify(s.otpStore.get("newcomer@example.com")));
  check("§5.11 a send that cannot reach the mailer is reported, not swallowed",
        sendRes._status === 502 && sendRes._body?.ok === false,
        `${sendRes._status} ${JSON.stringify(sendRes._body)}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   §6 Source-level: every submit path goes through the guard
   ─────────────────────────────────────────────────────────────────────────────
   §1/§2 prove the guard works when the function is called twice. This pins the
   other half of the original bug - that the Enter handlers exist at all and are
   wired to the same guarded entry point, so no future edit reintroduces a
   keyboard path that side-steps it.
   ═════════════════════════════════════════════════════════════════════════════ */
console.log("\n── §6 the keyboard paths route through the guarded functions ──");
{
  check("§6.1 #otpInput's Enter handler calls verifyOtp()",
        /otpInput[\s\S]{0,400}?Enter[\s\S]{0,120}?verifyOtp\(/.test(APP));
  check("§6.2 the identity fields' Enter handler calls submitIdentity()",
        /userName[\s\S]{0,400}?Enter[\s\S]{0,120}?submitIdentity\(/.test(APP));
  check("§6.3 the guard is declared INSIDE the extracted region (CLAUDE.md §2.6)",
        CLIENT_BLOCK.startsWith("const OTP_IN_FLIGHT = { send: false, verify: false };"));
  check("§6.4 verifyOtp checks the guard before doing anything else",
        /async function verifyOtp\(code\)\s*\{[\s\S]{0,400}?OTP_IN_FLIGHT\.verify/.test(APP));
  check("§6.5 submitIdentity checks the guard before doing anything else",
        /async function submitIdentity\(\)\s*\{[\s\S]{0,1400}?OTP_IN_FLIGHT\.send/.test(APP));
  check("§6.6 both guards are released in a finally, never on the happy path alone",
        (CLIENT_BLOCK.match(/finally\s*\{[\s\S]{0,200}?OTP_IN_FLIGHT\.(send|verify)\s*=\s*false/g) || []).length >= 2);
}

console.log(fails === 0 ? "\nOTP single-verification: OK" : `\nOTP single-verification: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
