/* =============================================================================
   PEAR · Orientation decisions - is the shopper facing the lens, and when does the
   reference swap (server-side: a Cloudflare Worker in production)
   -----------------------------------------------------------------------------
   WHY THIS LIVES HERE. Until 2026-09-26 the whole of Layer C's DECISION - the lock and
   its streaks, the yaw corroboration, the side-view pass, the post-peak rule, the fold
   handshake (early turn), predictive BACK, the profile axis and every threshold tuned
   against the clips recorded below - shipped to every shopper inside
   fitting-room/app.js. It is the most tuned logic PEAR owns. The browser now only
   MEASURES (the vote from FaceDetector / the shoulder order / the skin ratio, the
   profile score, the pose loop's |yaw|) and EXECUTES (the swap with its asset guards,
   the hold, the turn flag, the pose and re-anchor dispatches); every tick it sends
   one sample and gets back the actions to take, in order.

   THE CONTRACT. createOrientEngine(knobs) makes one watcher's engine (state is per
   session, like the watcher's own). step(sample) is PURE given the engine's state and
   the sample - every clock reading is the browser's own (s.t, s.yawAt, s.lostAt), so a
   decision does not depend on how long the sample took to arrive, and the same sample
   stream always yields the same actions. The actions are exactly what the old tick did
   inline, in the same order:
     { do: "log", line }                debug only (see `debug` below)
     { do: "turnMark", on }             orientTurnMark(on)
     { do: "holdBegin" | "holdPromote", reason }
     { do: "holdEndIfActive", reason }  if (_orientHoldActive) orientHoldEnd(reason)
     { do: "resetSwapCooldown" }        lastSwapAt = 0
     { do: "profile", next }            maybeApplyProfile(next) - not awaited
     { do: "reanchor" }                 maybeReanchorPrompt() - not awaited
     { do: "swap", next, predictive }   await maybeSwap(next, predictive) - always last
   The sample: { t, vote, faceSeen, poseVoted, profileScore, yawAbs, yawAt, lostAt,
   lock, profile, dualView, dbg? } - see sanitizeOrientSample().

   MOVED, NOT REWRITTEN. Every block below is the app.js code with its comments; the
   tick's reads of module state became reads of the sample and its side effects became
   actions (p5 in the commit that moved it lists each substitution). Proven identical
   by replaying 4,116 scripted sessions through the old watcher and through the new
   shell + this engine - see test/orient-engine.test.mjs.

   KNOBS. The ?early_turn= family and friends still come from the page URL: the
   browser forwards exactly ORIENT_KNOB_KEYS, and the parsers below - moved verbatim -
   read them from a local `location` built from that object.

   DEBUG. The per-tick tuning line prints every threshold, so it is emitted only when
   the SERVER allows it for this connection (createOrientEngine's `debug` option):
   always in local development, and in production only for a support connection that
   presents the debug token. ?orient_debug=1 on its own no longer prints the engine.
   ============================================================================= */

/* ── COPIES of browser values the moved code reads (CLAUDE.md §3 - edit together; the
   pose loop in app.js still uses both, and test/orient-engine.test.mjs asserts they
   agree). ────────────────────────────────────────────────────────────────────── */
const ORIENT_YAW_FRESH_MS = 600;
const PRESENCE_PROMPT_YAW_SUPPRESS_DEG = 25;

/** The URL parameters the engine reads, and the only ones the browser forwards. */
export const ORIENT_KNOB_KEYS = ["pose_pass", "post_peak", "early_turn", "early_turn_return", "early_turn_slow",
  "early_turn_speed", "early_turn_loss", "predict_back"];

function knobSearch(knobs) {
  const q = new URLSearchParams();
  for (const k of ORIENT_KNOB_KEYS) {
    const v = knobs && typeof knobs === "object" ? knobs[k] : undefined;
    if (typeof v === "string") q.set(k, v.slice(0, 16));
  }
  const s = q.toString();
  return s ? "?" + s : "";
}

/** @param {object} knobs - { early_turn: "40", ... } as the page URL carried them
 *  @param {{debug?: boolean}} [opts] */
export function createOrientEngine(knobs = {}, { debug = false } = {}) {
  /* The moved knob parsers were written against the page URL; this is the URL they read now. */
  const location = { search: knobSearch(knobs) };
  const ORIENT_DEBUG = debug === true;

  const ORIENT_LOCK_FRAMES    = 10;    // consecutive agreeing samples to unlock (~2.5s @ 250ms/sample)
  const ORIENT_LOCK_MS        = 2500;  // OR this much sustained agreement - whichever comes first (see note above)

  /* FIRST acquisition only - see PENDING_MODE below. Deliberately far lower than
     ORIENT_LOCK_FRAMES: that threshold's job is to stop a CONFIRMED state from
     flapping, and until the first reading lands there is no confirmed state to
     protect. Two agreeing confident samples (~500ms) is enough to establish one, and
     paying the full 2.5s anti-flap cost for it is what made a shopper who was already
     turned around watch the FRONT render on their back for the first few seconds. */
  const ORIENT_ACQUIRE_FRAMES = 2;

  /* ── YAW CORROBORATION - the same 2.5s, seen from three sides ──────────────────────
     ────────────────────────────────────────────────────────────────────────────────
     THREE REPORTS, ONE CAUSE. "The real shirt bleeds through when I turn", "the back
     graphic pops in late", and "the feed freezes during a turn" are the same
     ORIENT_LOCK_FRAMES x ORIENT_SAMPLE_MS = 2.5 seconds of confirmation latency wearing
     different faces. Hold ON and you get the freeze; hold OFF and the model re-renders a
     half-turned shopper in their own shirt; swap late and the graphic arrives after the
     turn. Each "fix" in isolation just moves the symptom to one of the other two.

     The only lever that shrinks all three at once is CONFIRMING FASTER - and the reason
     that was never done is the one written above ORIENT_LOCK_FRAMES: lowering it swaps the
     reference on a head-turn and reintroduces flapping, which is worse than any of the
     three.

     SO CONFIRM FASTER ON MORE EVIDENCE, NOT ON A LOWER BAR. The shared pose loop already
     computes bodyYawDegrees() every BODY_TOPOLOGY_SAMPLE_MS for the topology monitor, and
     nothing in the orientation path has ever consumed it. It is a genuinely 3D measurement
     off MediaPipe's torso landmarks - a different instrument entirely from the 96px
     skin-ratio canvas and the face detector that produce the vote.

     TWO INDEPENDENT SIGNALS, BOTH REQUIRED. The vote decides WHICH side; the yaw swing
     only attests THAT a real torso rotation happened. Neither can stand in for the other:
       · Yaw cannot pick a side. bodyYawDegrees() is asin(out-of-plane / length), capped at
         +/-90, so a shopper facing the camera and one facing away read the same. It is
         never consulted for direction - only to shorten a decision the vote already made.
       · The vote cannot see a torso turn. That is exactly why a head-turn under a flickering
         light could ever have raced it, which is what ORIENT_LOCK_FRAMES defends against -
         and a head-turn moves the head, not the shoulders, so it produces almost no torso
         yaw and earns no corroboration. The defence is intact where it was needed.

     ORIENT_LOCK_FRAMES IS UNTOUCHED and remains the bar whenever yaw is unavailable, stale
     or small: no pose detector, an occluded torso, a phone that never loaded the WASM
     runtime, or simply a shopper who has not actually turned. Corroboration can only ever
     ADD a faster path alongside it; it can never raise the bar and never lower it below
     ORIENT_CORROBORATED_FRAMES.

     THE NUMBERS. 45 degrees is a half-turn of the shoulder line - well past anything a
     head-turn, a lean or a shrug produces. It is measured DOWN from the turn's edge-on peak
     (see makeTurnYawWindow - measuring it from the start of the new vote streak meant the
     return leg could never reach it). 4 frames is ~1s at ORIENT_SAMPLE_MS, still 4 agreeing
     votes rather than a hair trigger. FRESH_MS is ~2.5 pose ticks (yaw is published on every
     POSE_SAMPLE_MS * 2 tick - see startPresenceWatcher): a yaw reading older than that
     describes a body position the shopper has already left, and stale evidence must not
     accelerate anything.

     THE FACE RETURN - the one direction that may confirm on fewer votes. This file already
     records that the two vote directions are not equally reliable: a face DETECTED is strong
     evidence (false positives on hair or a shoulder are rare), a face NOT detected is what
     every dim room and motion blur also looks like. So a return to FRONT that has BOTH a
     FaceDetector detection streak AND a torso turn corroborated by yaw - two different
     instruments agreeing - confirms at ORIENT_FACE_RETURN_FRAMES. Neither alone does: a face
     with no torso rotation is the shopper facing away and glancing over their shoulder at the
     screen, which keeps the full ORIENT_LOCK_FRAMES bar. Geometry backs the pairing: the
     corroborated swing needs the torso back within ~45 degrees of square, and a head cannot
     turn far enough past that to put a frontal face in front of a body still facing away.
     Two, not one: a single detection is the hair trigger the corroborated bar refuses. The
     BACK flip keeps ORIENT_CORROBORATED_FRAMES - its evidence is an absence. */
  const ORIENT_CORROBORATED_FRAMES = 4;    // agreeing votes needed WITH a corroborating yaw swing
  const ORIENT_FACE_RETURN_FRAMES  = 2;    // face DETECTIONS needed for a corroborated return to FRONT
  /* THE POSE FLIP - the face return's symmetric sibling. The pose model's shoulder order (see
     poseShoulderFacing()) is not an absence in either direction: it reads FRONT and BACK with the same
     standing, measured +0.76 / -0.68. So two consecutive shoulder votes for the other side, with the
     turn corroborated by yaw, confirm the flip BOTH ways - which is what makes FRONT -> BACK -> FRONT
     move on one bar instead of a fast return and a slow departure. Corroboration is still required:
     the shoulder order is a torso signal, and a head turned over the shoulder must not flip anything
     before ORIENT_LOCK_FRAMES. */
  const ORIENT_POSE_FLIP_FRAMES    = 2;    // shoulder-order votes needed for a corroborated flip, either way
  /* ── THE SIDE-VIEW PASS - "the back graphic comes a second late, and after the 360 the front never
     comes back" (build 129) ─────────────────────────────────────────────────────────────────────
     THE CAUSE IS THE GAP THE SHOULDER VOTE READS ACROSS. MediaPipe loses the far shoulder near
     edge-on (see makeTurnYawWindow's EDGE-ON GAP), and the pose loop publishes a shoulder order and a
     yaw only from a readable torso - so through that band both keep their LAST readable value, and
     both count as fresh for ORIENT_YAW_FRESH_MS (600ms). A turn crosses the band faster than that.
     Every tick in it the stale shoulder order votes for the side ALREADY locked, which closes the
     window and pins its peak at the last readable |yaw|; the stale yaw is "fresh", so the edge-on
     loss is never inferred either. The peak then sits under ORIENT_YAW_TURN_DEG + the 45-degree
     swing the pose flip needs, predictive BACK never reaches ORIENT_EDGE_ON_DEG, and the flip waits
     for ORIENT_LOCK_FRAMES - or, on a fast turn, never happens at all. turn-yaw-window §2/§9 modelled
     the shoulder vote with the torso readable straight through edge-on, which is why it passed.
     MODELLED (turn-yaw-window §10, the real window and decision, shoulder readings stale across an
     unreadable band): 22 of 48 full-360 profiles (60-150 deg/s, depth 0.6-1, torso readable to 50-90
     degrees) never swapped at all - the back never rendered. With the pass all 48 send BACK and come
     back to FRONT; of the 26 that already did, 10 dispatch earlier and none later.
     THE PASS. Yaw magnitude cannot tell "parked edge-on with a dropped frame" from "went through
     edge-on during the gap" - treating any dropout as edge-on puts BACK on a held profile check. What
     separates them is DESCENT: after a real pass |yaw| falls away from the peak; parked, it does not.
     So a shoulder vote for the other side is also corroborated when the window saw a real turn - a
     readable peak past ORIENT_YAW_TURN_DEG, or the torso reported unreadable since the reading that
     last agreed with the lock - AND |yaw| has since fallen ORIENT_PREDICT_DESCENT_DEG from that
     readable peak (never from an assumed 90). Two shoulder votes are still required
     (ORIENT_POSE_FLIP_FRAMES), a head over the shoulder still moves no torso, and the FaceDetector and
     skin engines never reach it (it only corroborates the pose flip).
     A BACK confirmed on the pass alone goes out at the stage of the turn a predictive BACK does, so it
     is withdrawable the same way (maybeSwap's `withdrawing`) - without that, a glance to 120 degrees
     left BACK on the chest for the full ORIENT_COOLDOWN_MS. THE RESIDUAL COST, stated: under the
     model's harshest noise (30% dropped frames, +/-0.6 edge-on label noise) one 120-degree glance sent
     an early BACK that predictive BACK did not, on the chest 250ms longer than build 129's worst.
     Held and brief profile checks, 100-degree glances, posing twists and a side check of the back put
     nothing on the wire at any noise level.
     Still a model: the band's width on a real webcam is what ?orient_debug=1 prints (`torso lost`,
     `passed`). ?pose_pass=0 turns it off for an A/B. */
  const ORIENT_POSE_PASS = (() => {
    try { return new URLSearchParams(location.search).get("pose_pass") !== "0"; } catch (_) { return true; }
  })();
  /* ── POST-PEAK EVIDENCE - "the prints bleed across and the view chatters at the side" (2026-09-22) ──────────────
     REPORTED: on a 360 the back graphic leaks onto the chest or the front graphic onto the back panel mid-turn, and
     near the side view the reference toggles front/back/front. No clip came with it, so it was taken to the model.
     COUNTED (turn-yaw-window, the §13 grid plus 20-35 deg/s turns, dispatches per 360, not only where they end):
     most 360s send exactly BACK then FRONT, but some send 4-6. At 30 deg/s 56 of 216 modelled turns flapped, at 20
     deg/s 140 - a clean 20 deg/s turn with no noise at all sent B@40 F@100 B@130 F@235 B@290 F@305. Each extra FRONT
     on the way OUT (and BACK on the way back) goes out with the body already past the side view: FRONT on a back
     panel, then BACK again - the reported bleed and the reported chatter, from one cause.
     THE CAUSE: EVIDENCE CAST ON THE WAY INTO THE TURN WAS COUNTED AS A RETURN FROM IT. Every bar that un-does the
     lock assumed the new side's votes begin after the turn's edge-on peak, and until the early trigger that was
     true - the lock only moved once the body had come round. The early trigger (and predictive BACK) move the lock
     AHEAD of the body: BACK goes out at ~35 degrees while the chest still faces the lens, and the shoulders
     correctly keep voting FRONT until ~69. Against a BACK lock those votes disagree, so they build a FRONT streak.
     Abstains never reset a streak, and the shoulder vote abstains from ~69 to ~111. Then, on the far side:
       · the side-view pass (|yaw| 15 down from the peak) corroborated that pre-peak FRONT streak - FRONT at 117;
       · or ORIENT_LOCK_MS counted one pre-peak FRONT vote plus 2.5s of edge-on abstains as "sustained agreement" -
         FRONT at 100 on a slow turn;
       · and the same on the return leg, with the roles swapped - BACK at 290.
     THE RULE: a vote cast while |yaw| was still RISING toward the turn's peak is evidence of LEAVING that side, not
     of returning to it. So every bar that un-does a lock - the vote bar, the corroborated bar, the held time, the
     face return and the pose flip - counts only the votes, and the time, since |yaw| last climbed
     ORIENT_POST_PEAK_RISE_DEG or the torso was first lost to edge-on (makeTurnYawWindow's postPeakVotes /
     postPeakSince; orientFlipDecision caps each bar at them with Math.min, so a cap can only raise a bar).
     TWO CUTS WERE MEASURED AND BACKED OUT FIRST - do not re-run them:
       · restarting the count on EVERY new maximum: +/-4 degrees of jitter on a body standing square sets a new
         maximum every few readings, so BACK left on the chest after a fast 360 kept losing the FRONT votes that
         should undo it - 52 more modelled fast 360s under dropped frames never swapped and 12 ended on BACK;
       · also refusing the vote cast from the reading that restarted the count: after a torso unreadable straight
         through edge-on, that reading is the first one PAST the fold, and 16 fast 360s lost their only BACK.
     MEASURED (turn-yaw-window §14; 20-180 deg/s, k 0.6-1, torso readable to 50-90, 100ms on screen):
       20-35 deg/s, clean + jitter        flapping 360s 64 -> 1    a side sent past the side view, wrong side 62 -> 0
       20-35 deg/s, 15-30% dropped+noise  flapping 360s 127 -> 97                                               53 -> 2
       45-180 deg/s, either               unchanged; §13's fold ledger is byte-identical
     No turn swaps less, ends anywhere but FRONT, or sends more wrong-side swaps than before, and no pose §13
     prices shows the other side for longer. Wobbling 70-110 at the side view: at most 4 dispatches -> 2.
     WHAT IT DOES NOT CHANGE. The normal 360 already met the assumption - the new side's votes come after the peak -
     so it sends exactly what it sent. With no pose reading at all nothing ever restarts the count, which is the bar
     exactly as before. Acquisition is exempt: with no lock there is nothing stale to un-do.
     WHAT IS LEFT, stated: the 97 noisy slow flaps are the early trigger's fold-by-loss firing on a dropped frame at
     |yaw| 20-40 and withdrawing itself ~10 degrees later - the cost ?early_turn_loss's comment already prices, and a
     threshold decision, not this bug. And it is a model: ?orient_debug=1 prints `after peak Nv` on every tick of a
     pending switch - the live check. ?post_peak=0 turns this rule off for an A/B.
     Paired with a fix in makeEarlyTurnTrigger (the rise it fires on is measured from a fresh arm) - the second,
     independent route to FRONT on a back panel the same count found. */
  const ORIENT_POST_PEAK = (() => {
    try { return new URLSearchParams(location.search).get("post_peak") !== "0"; } catch (_) { return true; }
  })();
  /* ── THE FOLD HANDSHAKE - the swap goes out at the SIDE VIEW, not as the turn starts (2026-09-15) ─────────────
     REPORTED, with two clips (pear-tryon-...-FOX-20260915-164257 and -165625, v142): "the front print unmounts too early
     while the front is still partly visible, leaving a plain T-shirt before the back locks on - and the same on the way
     back". Asked for: keep FRONT until past 90 degrees, keep BACK until the chest comes round, never a plain shirt.
     READ FRAME BY FRAME (decoded with per-frame media times; the export repaints a ~10fps render at 30fps):
       · 164257 OUT: PEAK on the chest at 1.738s with the body ~15 degrees round; the very next Decart frame, 1.773s,
         is the same body with a plain chest. Plain through the three-quarter and the side until the back print shows
         at ~2.2s, ~100 degrees. RETURN: back print at 3.304s (~150 degrees), plain at 3.338s with the back still to
         the lens, PEAK back at ~3.74s (~70 degrees). About 400ms of plain shirt on each leg.
       · 165625 OUT: PEAK gone at ~2.15s, body ~35 degrees round; back print at ~2.55s.
       · NOT A STALL, NOT A COVER, NOT A CLEARED REFERENCE. Decart's output kept its ~100ms cadence straight through
         every gap (no repeated frame, so LIVE CONTINUITY never engaged), nothing of ours is drawn over it, and no path
         sends image:null. Each gap is the NEW reference rendered on the OLD side: a back photo has no chest print to
         draw, a front photo has no back print. It begins on the frame the swap lands.
     WHAT THAT MEASURES. The swap appears on screen with the body at about the angle it was SENT at - Decart's output
     trails the camera by about as long as a swap takes, so the two cancel. This trigger was tuned (below) against a
     modelled 700-1000ms dispatch-to-render: under that premise a 20-degree send lands near the side view. In these clips
     it landed at 20, and every degree of lead was plain shirt.
     WHAT THE REQUEST CANNOT MEAN HERE, and was not built. Decart holds ONE reference: GARMENT_BACK cannot "arrive" and be
     verified while GARMENT_FRONT keeps rendering - the swap IS its arrival - and two views cannot be blended across the
     profile: a stitched FRONT|BACK reference is the double-logo bug (COMPOSITE_DEFAULT), two live sessions would double
     the bill and ghost. |yaw| folds at 90 and is depth-compressed, so "110" and "70" are not readings either. The one
     thing the client controls is WHEN the single swap goes out - so it goes out where a real shirt shows neither print.
     THE FOLD, both legs (makeEarlyTurnTrigger): ORIENT_EARLY_TURN_DEFAULT_DEG and _RETURN_DEG at 50, a depth-compressed
     reading near the real side view; the slow path at the same 50; and ORIENT_EARLY_TURN_LOSS_DEG, because MediaPipe
     loses the far shoulder right there and many turns never publish a reading that high - a torso lost while |yaw| was
     still rising past 20 is the fold too. The 45 deg/s gate, the withdrawal, the cooldown rules and every other path
     are unchanged.
     MODELLED (turn-yaw-window §13: the real window, decision, predictive BACK and trigger; 216 full 360s at 45-180
     deg/s, k 0.6-1, torso readable to 50-90; on-screen latency 0/100/250ms - the clips - and 700 for the old premise):
       plain shirt while the side being left still faces the lens   663/539/361ms (v142)  ->  337/244/146ms
       plain shirt on either side of the fold, per 360               1074/995/917ms        ->  519/500/581ms  (700ms: 1267 -> 1217)
       median landing, out / back (90 = the side view)               50-76 / 72-104        ->  80-105 / 70-95
     THE COST, stated: the plain that remains sits just past the side view instead of before it (the back panel comes
     round plain for a beat before its print lands: at 0-250ms, 63-170ms on the way out, 120-266ms on the way back, where
     v142 showed 116-137 / 295-419ms of it on top of its early gap); one modelled 180 deg/s,
     k 0.6 turn gives the fold no reading at all and never swaps (6 of 216 vs 5); and a small pose that rises past 20
     fast and drops a frame reads as the fold - a quick reach, a look back over the shoulder, a slow look to 30 swap up
     to 10 times in 60 under 15-30% dropped frames, withdrawn. In exchange a twist to 38 swaps 4/60 instead of 46/60 and
     a mirror check at 45 11/60 instead of 58/60. A held profile check still swaps - it IS the side view.
     OVERRIDES: ?early_turn=20&early_turn_return=35&early_turn_slow=35&early_turn_loss=0 is v142 exactly.
     STILL A MODEL: one ?orient_debug=1 360 prints `fold handshake:` with the path that fired and the swap timeline -
     the live check on where the swap lands.
     ── WHAT FOLLOWS IS THE 20-DEGREE DEFAULT THIS REPLACED (v134-v142), kept as the record of why it was taken ──
     THE EARLY TURN TRIGGER - ON BY DEFAULT at 20 degrees, gated at 45 deg/s (60 until 2026-09-15).
     WHY IT EXISTS. Traced client side, a swap costs ~nothing: the Blobs are pinned in memory, the
     catalog's rear pair is 43KB/38KB, @decartai/sdk sends it as one set_image message on the signaling
     WebSocket, and the reference is pre-encoded (preEncodeReference). What remains is Decart switching its
     render once it has the reference (~1s by this file's own figure - COND_TRACE_SETTLE_MS). The only
     client lever against a server cycle is sending sooner.
     WHY IT IS ON, AND WHAT IT COSTS - a PRODUCT DECISION (2026-09-14), taken on these modelled numbers
     (turn-yaw-window §11, the build-130 tick, 700-1000ms dispatch-to-render; not yet measured live):
     at 15-45 degrees a posing twist and the start of a 360 are the same reading, so no setting removes the
     trade - it only chooses it. With the trigger off, a full 360 shows the wrong garment 2.5s (700ms
     latency) to 3.0s (1000ms); at 20 degrees gated at 60 deg/s, 0.8s to 1.25s. A slow sway or a held
     weight shift never fires, jitter or not. A FAST pose - a quick twist, a reach, a look at the side view in the mirror, a held profile
     check - starts exactly like a turn and shows the other side's graphic for ~0.75-1.75s until the
     withdrawal lands. The choice offered was: 20 ungated (turns ~0.3s, slow weight shifts past 20 fire
     too), 20 gated (this), or off. ?orient_debug=1 prints DISPATCH_SENT / SERVER_CONFIRMED /
     RENDER_APPLIED and the trigger's live |yaw| speed to re-tune from a real turn.
     OVERRIDES: ?early_turn=0 turns it off (the build-130 behaviour, exactly); ?early_turn=<deg> moves the
     threshold, clamped to [ORIENT_EARLY_TURN_MIN_DEG, ORIENT_EARLY_TURN_MAX_DEG] - under 10 is sway, past
     60 predictive BACK is already earlier; unparseable keeps the default.
     MEASURED AND DECLINED (same model): 12 or 15 (a 14-degree sway fires at 12; an 18-degree weight shift
     shows the back 1.75s at 15, for 0-125ms gained over 20 on a 360); an acceleration gate (sampled at
     240ms, a 12-degree sway reads HIGHER alpha in the 8-12 degree band - 116-351 deg/s2 - than a 360's start
     - 43-208 - and a 90 deg/s turn skips that band between two readings); evaluating the crossing on every
     pose reading instead of the tick (BACK leaves ~60ms sooner and lands in the front hemisphere - more
     wrong-garment time, 367 -> 667ms); firing on predicted time-to-edge-on (worse than a plain 20 even
     with the latency known exactly). No undo beats Decart's own switch: a reach that returns inside 300ms
     still shows the back for the whole render latency.
     BEHAVIOUR (see makeEarlyTurnTrigger): dual-view only; armed by settling square on the locked side;
     fires the other side on the first fresh |yaw| past the threshold while it rises at least the gate's
     speed, BACK sent withdrawable like a predictive BACK; withdrawn the moment the old side's votes return
     under the threshold, before any vote has confirmed the turn. Symmetric: armed facing away, it sends
     FRONT the same way. */
  /* ── THE MIDDLE GROUND - 50 -> 35 outbound, 45 on the return (2026-09-16) ────────────────────
     DIRECTED as a product decision, and the honest label matters: this is the FIRST threshold in
     this block that was NOT set from a measurement. The fold handshake's 50 came from two clips
     read frame by frame plus 216 modelled 360s; v142's 20/35 came from §11's grid. 35/45 came
     from a judgement that the handshake over-corrected - which the numbers below may well
     support, but nobody has yet replayed a ?orient_debug=1 360 against it.

     THE REPORT IT ANSWERS: on a turn the back panel comes round PLAIN for a beat before its print
     lands, and the graphic pops in late. That is the fold handshake's own stated cost, written
     into its comment above ("the plain that remains sits just past the side view instead of
     before it", 63-170ms out / 120-266ms back at 0-250ms latency). Sending earlier moves the
     swap back toward the side view, where a real shirt shows neither print.

     WHAT IT RISKS, and this is the half to read before tuning it again. The handshake exists
     because the swap lands on screen at ABOUT THE ANGLE IT WAS SENT AT - Decart's output trails
     the camera by roughly one swap, so the two cancel. At 35 the swap therefore lands near 35,
     which is still the FRONT hemisphere: the chest is in view, and a back reference rendered on a
     visible chest draws no chest print. That IS the 2026-09-15 report ("the front print unmounts
     too early while the front is still partly visible, leaving a plain T-shirt"), bought back in
     part. The trade is deliberate: less plain time late on the turn, some plain time early.

     THE RETURN LEG KEEPS A 10-DEGREE HYSTERESIS (45, not 35) and it is not symmetry for its own
     sake. The return is the leg with a MEASURED failure: at 20 a live clip caught FRONT landing
     on a back-facing body (see ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG below), and §11 found 35 the
     lowest setting that never does so at any latency. Dropping the return to the outbound's 35
     would sit exactly on that floor with no margin, so it keeps a margin. Asymmetric legs are
     also the v136-v142 design this partially restores, not a new idea.

     TO RESTORE THE FOLD HANDSHAKE EXACTLY, no deploy needed:
       ?early_turn=50&early_turn_return=50&early_turn_slow=50
     TO GO BACK TO v142:  ?early_turn=20&early_turn_return=35&early_turn_slow=35&early_turn_loss=0
     ONE ?orient_debug=1 360 prints `fold handshake:` with the path that fired and the swap
     timeline - if DISPATCH_SENT -> RENDER_APPLIED is well under the 700-1000ms these were tuned
     against, 35 is right and 50 was overshooting; if it is at or above it, 50 was correct and
     this change is re-opening the plain-front report. That log is what settles it.
     ── the fold handshake's own record follows, unchanged, and is still the reason 50 was set ── */
  /* ── 35 -> 40 (2026-09-22, evening), DIRECTED INTO 38-42 AND CALIBRATED THERE ──────────
     REPORTED again: the back graphic bleeds onto the front chest during the outbound turn, and the
     request named a 38-42 degree outbound bound. At 35 the swap lands in the front hemisphere -
     the stated cost of the middle ground, above - and the fold ledger scores exactly that as
     outPlain (BACK on the wire while the chest still faces the lens).
     SWEPT (turn-yaw-window §13's grid; return 50, slow path tracking the outbound leg as always;
     total wrong-side ms per 360 and outPlain at 0/100/250 | 700ms on screen):
         35   total 635 580 596 | 1107   outPlain 318 245 152   never swapped 5 of 216
         38         595 549 582 | 1133            276 207 123                 5
         40         580 540 582 | 1152            258 192 112                 5
         42         556 522 575 | 1169            232 169  95                 5
         50         519 500 581 | 1217            180 125  65                 6
     Every step up buys the reported symptom down at every MEASURED (clip) latency and pays in late
     pop-in (outLate 30/42/90 -> 36/55/116 at 40) and at the unmeasured 700ms column - the same
     trade, in the same direction, the 45->50 return calibration took. The 25-degree landing bar
     does not bind anywhere in 35-58; 40 lands NEARER the side view than 35, whose 0ms median sat
     exactly on the bar's edge (65 -> 71, 77 -> 81, 90 -> 99). Poses: fired 205 -> 197 of the §13
     set, mean wrong-side 280 -> 263ms.
     THE COST UNDER NOISE, found by §14's grid (15-30% dropped frames, edge-on label noise) and not by
     the clean sweep above - smooth in the threshold, stated rather than hidden:
         outbound                         35    38    40    42
         slow noisy 360s that flap        97    99   104   109   (of 288 - fold-by-loss fire + withdraw)
         fast noisy 360s never swapped    16    18    18    18   (of 432)
         clean 360s, wrong side past 90    1     2     2     3   (the 180 deg/s k 0.6 sampling limit)
     40 WITHIN THE DIRECTED RANGE because it keeps the 10-degree hysteresis to the return leg's 50
     that the middle ground argued for - RETURN >= OUTBOUND still holds, with margin.
     ON THE HARNESS (the dispatch-angle instrument, same scripted 360, n=4 each), the true body
     angle BACK goes out at:  35 -> 49.0 54.7 43.9 36.6 (mean 46.1)   40 -> 62.8 50.5 40.4 59.4
     (mean 53.3). Two side changes per 360 in all eight runs; zero token mints.
     NOT TAKEN from the same request, measured: an EWMA on |yaw| (see SMOOTHING THIS SIGNAL below -
     re-run on this build, alpha 0.25 still leaves 84 of 216 turns never swapping), and holding BACK
     "until front chest visibility is restored" on the return (?early_turn_return=0 - see the 45->50
     record: it lands the return past front-square, the back print on a chest facing the camera).
     ?early_turn=35&early_turn_slow=35 restores the middle ground exactly. */
  const ORIENT_EARLY_TURN_DEFAULT_DEG = 40;   // 20 until the fold handshake (50); 35 at the middle ground; 40 since the 2026-09-22 calibration - see above
  /* ?early_turn_return=<deg> - THE RETURN LEG, BACK -> FRONT. SUPERSEDED as a default by the fold handshake (above): both legs now
     send at the side view, 50. What follows is why the return leg was first split from the outbound one - still true of any
     threshold short of the fold, which is the point the handshake takes to its end.
     (v136-v142: the return leg fired later than the way out.)
     LIVE EVIDENCE (the first in this series): pear-tryon-...-FOX-20260914-225423.mp4, a v134-era 360 at ~140 deg/s,
     read frame by frame. Out: "PEAK" holds to ~60 degrees, the side is plain (as a side is), the back graphic
     arrives with the back (2.8s) and holds while facing away. Back: between 3.40s and 3.47s the body jumps
     ~50 degrees and the shirt turns plain brown while the back and back-profile are still to the lens, until
     the chest comes round (~4.2s). A reference replaced while the back was visible - FRONT, and only the early
     trigger sends FRONT that close to facing away (20 degrees past it). The same clip timed Decart's output
     stalls around the swaps at 234-333ms, so this session's swaps were far faster than the 700-1000ms the
     default was first tuned for, and at that speed 20 degrees of lead lands FRONT on the back.
     MODELLED per leg (turn-yaw-window §11, 90-140 deg/s, 250-1000ms dispatch-to-render): the return leg at
     35 is the only setting that puts FRONT on a back-facing body for 0ms at every latency; its cost is the
     back graphic staying on a turning-front chest ~100-190ms longer. Raising BOTH legs is worse overall and
     leaves a plain gap anyway. The outbound leg keeps 20. ?early_turn_return=0 turns the early FRONT off
     (the vote path carries the return); clamped like ?early_turn. Which path sent FRONT in that clip is
     what one ?orient_debug=1 log of a turn would confirm. */
  /* 45 SINCE THE MIDDLE GROUND (2026-09-16): the outbound leg went to 35 and this one keeps a
     10-degree margin over it. Everything above is why the return must never be the LOWER of the
     two - it is the leg that was caught putting FRONT on a back-facing body at 20, and 35 is the
     measured floor rather than a comfortable setting. See ORIENT_EARLY_TURN_DEFAULT_DEG. */
  /* ── 45 -> 50 (2026-09-22), CALIBRATED AGAINST THE MODEL, NOT CHOSEN ──────────────────
     REPORTED, across several rotation videos: on the return arc the back print drops off
     while the rear/side torso is still facing the lens, leaving a plain-shirt window before
     the front print engages.

     THE REPORT IS CORRECT AND THE MODEL AGREES. turn-yaw-window's back-leg ledger splits the
     plain window into EARLY (the side being left has lost its print while it still faces the
     lens - the reported symptom) and LATE (the arriving side's print has not landed yet).
     At 45 the early half was 190/145/96/65ms at 0/100/250/700ms latency. At 50 it is
     155/116/75/57ms - down 12-22% at every latency. The "plain while the side being left
     faces the lens" figure the fold handshake is scored on improves on both legs together:
     508->474, 390->361, 248->227, 89->81ms.

     WHAT IT COSTS, and it is a genuine trade, not a free win. The late half grows -
     105/145/238/610 -> 131/177/278/663ms - so TOTAL plain is slightly better at 0ms
     (644->635) and slightly worse at the long end (250ms 575->596, 700ms 1063->1107). This
     buys the reported symptom down and pays for it in late pop-in, which is the opposite
     report and is not the one open.

     50 IS NOT A GUESS AND NOT THE MAXIMUM. Sweeping the return threshold against
     turn-yaw-window's "both swaps land within 25 degrees of the side view" bar - the
     overshoot guard, and the reason the front print cannot bleed onto a chest already facing
     the camera:
         48 PASS   50 PASS   52 PASS   53 PASS   54 PASS   55 FAIL   58 FAIL   60 FAIL
     The failure edge is between 54 and 55 (at 55 the return's median landing is 60 degrees at
     250ms, 30 off the side view). 50 keeps four degrees of margin rather than sitting on that
     edge, and it is not a novel number: the fold handshake shipped 50/50. Back-leg median
     landing stays inside the bar at every clip latency (95/84/70 against 90).

     THE OUTBOUND LEG IS UNTOUCHED at 35, and RETURN >= OUTBOUND still holds - see the
     invariant below, which is the thing that must never break.

     TWO SETTINGS WERE TRIED FIRST AND BOTH WERE BACKED OUT; do not re-run them.
       · 60 - dispatches later but overshoots the fold: the swap comes down the FAR side of 90
         rather than arriving later, median landing 60 at 250ms, 30 off the bar.
       · 0 (hold until the vote path carries it, i.e. "until the torso is nearly square") -
         total plain grows 10/22/44/53% at 0/100/250/700ms and the return lands at -20 degrees,
         PAST front-square: the back print on a chest facing the camera. Measured, not modelled
         away; the harness put the dispatch at body angle 316.7 on average.

     THE UNDERLYING UNCERTAINTY IS UNCHANGED. Two latency models live in this file - the CLIP
     latencies (0-250ms) this bar is built on, and the 700-1000ms the older comments assume -
     and at 700ms this change is a small net loss rather than a win. One ?orient_debug=1 360
     (DISPATCH_SENT -> RENDER_APPLIED) settles which column to optimise; until then 50 is
     calibrated for the clip latencies, because those are the ones that were measured.
     Everything below is why the return leg must never be the LOWER of the two. */
  const ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG = 50;   // 35 in v142, 50 at the fold handshake, 45 at the middle ground, 50 again since the calibration
  const ORIENT_EARLY_TURN_DEFAULT_SPEED = 45;
  /* ?early_turn_speed=<deg/s> - THE SPEED GATE (see makeEarlyTurnTrigger). A crossing fires only while |yaw| is
     rising at least this fast. Default ORIENT_EARLY_TURN_DEFAULT_SPEED; ?early_turn_speed=0 removes the gate;
     unparseable keeps the default; capped at 1000.
     MODELLED (turn-yaw-window §11, 1000ms render latency, with and without +/-4 degrees of yaw jitter): at 15
     degrees ungated an 18-degree weight shift held fires (and, with jitter, a 14-degree sway); gated at 60
     neither ever fires. The cost of the gate is turn benefit: a slow turn does not clear it either. A gate
     high enough to stop fast poses (80) stops slow turns from benefiting at all, and jitter lets some fast
     poses back through. The gate reads the pose loop's own yaw and reading time; no vote or engine changes.
     ── LOWERED 60 -> 45 (2026-09-15), a PRODUCT DECISION on the numbers below ──────────────────────────────
     REPORTED, from a live clip: on the way out the back graphic popped in only once the back was already
     square to the lens; on the way back it seemed to leave early. Not yet confirmed with ?orient_debug=1.
     WHAT THE MODEL SAYS WAS HAPPENING (turn-yaw-window §11). The gate is in the pose model's |yaw| units,
     and MediaPipe compresses depth: at k=0.75 a real 60 deg/s turn RISES at ~45. Gated at 60 the early
     trigger never fired on that turn - BACK came from the vote path at ~135-150 degrees of body rotation and
     rendered after the back faced the lens: 783ms of plain back at 700ms latency, 1053ms at 1000ms.
     At 45 that turn fires early: 0ms / 120ms. Full 360s (§11's grid): wrong garment 979 -> 563ms at 700ms,
     1438 -> 938ms at 1000ms. Turns at 90-120 deg/s already cleared 60 and are unchanged.
     THE COST, and why 45 and not lower. Every gate under 60 loses the guarantee that a held weight shift
     never swaps: with +/-4 degrees of yaw jitter an 18-degree shift held 1.5s now fires ~1 time in 10
     (~100ms of the back print, withdrawn), and a slow look to 30 degrees held 1s ~2 in 10 (~350ms). At 40
     those were 2/10 (~175ms) and 5/10 (~800ms) for a better full-360 mean (354 / 729ms); 50 kept the
     weight-shift miss and gave back the slow-turn fix. Standing still and swaying still never fire.
     COUPLED, deliberately: ORIENT_TURN_START_SPEED follows this gate, so body re-drapes now also defer on a
     torso rising at 45 deg/s - the wire has to be clear at exactly the speed the trigger can now fire at.
     CONSIDERED AND DECLINED in the same pass: an outbound threshold of 15 (only fast turns gain, ~95-125ms;
     a quick twist to 25 fires 10/10 instead of 5/10), and holding BACK on the return until ~30-35 degrees
     from the lens (the back print on a front-facing chest 63-516ms longer, and no plain-back time removed -
     past side-on a real shirt shows no back print). ?early_turn_speed=60 restores the old gate live. */
  const ORIENT_EARLY_TURN_MIN_SPEED = (() => {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get("early_turn_speed"); } catch (_) { return ORIENT_EARLY_TURN_DEFAULT_SPEED; }
    const v = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(v)) return ORIENT_EARLY_TURN_DEFAULT_SPEED;
    return v <= 0 ? 0 : Math.min(v, 1000);
  })();
  /* ── THE SLOW PATH - "a slow, deliberate 360 gets the back graphic only once the back is square" ─────
     (Since the fold handshake it sits AT the fold, 50, with the fast path - it adds the slow rise there and never sends
     earlier. The numbers below were taken at 35, on the 20-degree default.)
     REPORTED after the gate came down to 45 (6899d9f): a slow turn still misses the early trigger. It is
     the gate doing it, and lowering it further is not the answer - the gate is what keeps ordinary posing
     off the wire, and a pose and the start of a turn are the same reading at 20-30 degrees.
     WHAT SEPARATES THEM IS WHERE THEY STOP. A weight shift or a look to the side settles by ~30 degrees; a
     turn keeps going. So the slow path sits ABOVE that, at ORIENT_EARLY_TURN_SLOW_DEG, and asks for a RISE
     of ORIENT_EARLY_TURN_SLOW_RISE_DEG across ORIENT_EARLY_TURN_SLOW_WINDOW_MS rather than a speed between
     two readings - a longer baseline averages out the jitter that makes a two-reading speed unusable at
     these rates, and a pose that has settled reads a rise of ~0.
     MODELLED (turn-yaw-window §11, 700ms dispatch-to-render, +/-4 degrees of yaw jitter, 10 seeds):
     a 30 deg/s turn sends BACK at 45-53 degrees instead of 128-143 (wrong garment 3875 -> 1250ms), 45 deg/s
     2125 -> 625ms, 60 deg/s 750 -> 125ms; 90 and 120 deg/s are unchanged. Every pose is unchanged too -
     sway 0/10, an 18-degree weight shift 1/10, 25 degrees held 5/10, a slow look to 30 held 6/10, exactly
     as the gate alone. The request's own shape (22 degrees held 150ms at any speed) fires on ALL of those
     10/10, because "held" is what a pose does; it is the rise, not the dwell, that says turn.
     ?early_turn_slow=<deg> moves it, 0 turns the slow path off. */
  /* 35 SINCE THE MIDDLE GROUND (2026-09-16), tracking the outbound leg as it always has: the slow
     path's job is to add the SLOW rise at the same angle the fast path fires at, never earlier.
     Its own floor logic is unchanged - a weight shift or a look to the side settles by ~30, so 35
     still sits above where a pose stops. See ORIENT_EARLY_TURN_DEFAULT_DEG.
     40 SINCE THE 2026-09-22 CALIBRATION, for the same reason - it tracks the outbound leg; the
     sweep in ORIENT_EARLY_TURN_DEFAULT_DEG's comment moved both together. */
  const ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG = 40;   // 35 in v142, 50 at the fold handshake, 35 at the middle ground, 40 since the calibration
  const ORIENT_EARLY_TURN_SLOW_RISE_DEG = 10;
  const ORIENT_EARLY_TURN_SLOW_WINDOW_MS = [450, 960];   // [min, max] age of the reading the rise is measured from
  /* Declared ABOVE the ?early_turn_* parsers that clamp to them. They used to sit below the slow-path parser,
     so ?early_turn_slow=<deg> read them in their temporal dead zone and app.js threw a ReferenceError at load. */
  const ORIENT_EARLY_TURN_MIN_DEG = 10;
  const ORIENT_EARLY_TURN_MAX_DEG = 60;
  const ORIENT_EARLY_TURN_SLOW_DEG = (() => {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get("early_turn_slow"); } catch (_) { return ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG; }
    const deg = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(deg)) return ORIENT_EARLY_TURN_SLOW_DEFAULT_DEG;
    if (deg <= 0) return 0;
    return Math.min(ORIENT_EARLY_TURN_MAX_DEG, Math.max(ORIENT_EARLY_TURN_MIN_DEG, deg));
  })();
  const ORIENT_EARLY_TURN_RETURN_DEG = (() => {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get("early_turn_return"); } catch (_) { return ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG; }
    const deg = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(deg)) return ORIENT_EARLY_TURN_DEFAULT_RETURN_DEG;
    if (deg <= 0) return 0;
    return Math.min(ORIENT_EARLY_TURN_MAX_DEG, Math.max(ORIENT_EARLY_TURN_MIN_DEG, deg));
  })();
  const ORIENT_EARLY_TURN_DEG = (() => {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get("early_turn"); } catch (_) { return ORIENT_EARLY_TURN_DEFAULT_DEG; }
    const deg = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(deg)) return ORIENT_EARLY_TURN_DEFAULT_DEG;
    if (deg <= 0) return 0;
    return Math.min(ORIENT_EARLY_TURN_MAX_DEG, Math.max(ORIENT_EARLY_TURN_MIN_DEG, deg));
  })();
  /* ?early_turn_loss=<deg> - THE FOLD BY LOSS (see makeEarlyTurnTrigger's lossDeg). MediaPipe loses the far
     shoulder at the side view, so on many turns no |yaw| reading ever reaches ORIENT_EARLY_TURN_DEFAULT_DEG: the
     torso simply goes unreadable. A torso lost while |yaw| was still rising past this is read as the fold and swaps
     there. MODELLED (the §13 grid at 100ms): with no loss path the fold never swaps 12 of 216 full 360s and shows
     1348ms of plain per 360 (worse than v142's 995); at 20, 6 and ~500ms. 25 - PRESENCE_PROMPT_YAW_SUPPRESS_DEG, the
     file's other "lost to edge-on" bar - ~100ms more plain and 2 more turns lost; 30 ~250ms more and 3 lost. 20's cost
     is a small pose that rises past 20 fast AND drops a frame near its top - see THE COST above. 0 turns the path off;
     clamped like ?early_turn. */
  const ORIENT_EARLY_TURN_DEFAULT_LOSS_DEG = 20;
  const ORIENT_EARLY_TURN_LOSS_DEG = (() => {
    let raw = null;
    try { raw = new URLSearchParams(location.search).get("early_turn_loss"); } catch (_) { return ORIENT_EARLY_TURN_DEFAULT_LOSS_DEG; }
    const deg = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(deg)) return ORIENT_EARLY_TURN_DEFAULT_LOSS_DEG;
    if (deg <= 0) return 0;
    return Math.min(ORIENT_EARLY_TURN_MAX_DEG, Math.max(ORIENT_EARLY_TURN_MIN_DEG, deg));
  })();

  /* ── PREDICTIVE BACK - "the back artwork rendered over PEAK for a second" ─────────────
     REPORTED, from the exported clip: on FRONT -> BACK the back artwork appears over the front's
     "PEAK" text for about a second before the back settles.
     THE CLIP IS DECART'S OWN OUTPUT. The recorder paints #aiVideo directly (startRecording), so
     no cover of ours is in it. What it shows is timing: BACK was dispatched only after
     ORIENT_CORROBORATED_FRAMES back votes, and a back vote needs the back of the head (~150
     degrees) - the back was already facing the lens, Decart was still rendering the FRONT
     reference onto it, and a switch then takes Decart the better part of a second (see
     COND_TRACE_SETTLE_MS), blending from the one render into the other.
     THERE IS NO LATENT FLUSH TO CALL. @decartai/sdk@0.1.5's realtime surface is set({ prompt,
     enhance, image }) and setPrompt(); image:null clears the reference, which renders the
     model's generic prior - strictly worse. So the lever is WHEN the back reference arrives: while
     the torso is still passing through the side view, where neither print is on show.
     WHY NOT AT 45 DEGREES. The face detector loses a frontal face around there, but 45 is the
     FRONT hemisphere: the chest and its print are still in view, so a back reference sent then is
     the same ghost on the other side of the shirt - and it would fire on every look at a profile.
     |yaw| folds at 90 and cannot say which side of edge-on the shopper is on, so the earliest
     honest evidence is having PASSED it: the window reached ORIENT_EDGE_ON_DEG (or lost the torso
     there), |yaw| has since fallen ORIENT_PREDICT_DESCENT_DEG, no vote has agreed with FRONT since
     the turn began (so no face), and all of it inside ORIENT_PREDICT_DWELL_MS. The dwell is what
     separates a turn passing through from a profile being HELD - lingering at the side view and
     coming back is the one motion yaw cannot tell from finishing the turn.
     THE RESIDUAL COST, stated: a glance to the side that reverses at once looks exactly like a
     turn until the face returns. When that predicts, maybeSwap() lets the face return withdraw it
     inside ORIENT_COOLDOWN_MS (see `withdrawing`), on the fast face-return bar.
     UNMEASURED THRESHOLDS. 60 is set so a depth-compressed reading still reaches it near a real
     90; the ORIENT_DEBUG tick line prints the peak, the descent and the dwell to tune them from
     a real turn. ?predict_back=0 turns the whole path off for an A/B. */
  const ORIENT_EDGE_ON_DEG         = 60;   // a |yaw| reading at or past this counts as reaching the side view
  const ORIENT_PREDICT_DESCENT_DEG = 15;   // fall from that peak that shows the torso kept rotating
  const ORIENT_PREDICT_DWELL_MS    = 900;  // longer than this at the side view is a pose being held
  const ORIENT_PREDICTIVE_BACK = (() => {
    try { return new URLSearchParams(location.search).get("predict_back") !== "0"; } catch (_) { return true; }
  })();
  const ORIENT_YAW_TURN_DEG        = 45;   // |yaw| swing that counts as a real torso rotation

  /* ── THE TURN'S YAW WINDOW - "after a full 360 the back stays on my front" ─────────
     ────────────────────────────────────────────────────────────────────────────────
     REPORTED: turn to the back and the rear asset lands; keep turning to face the camera
     and GARMENT_BACK stays rendered on the shopper's FRONT for a long beat before the front
     returns. Filed next to "there is a visible gap while it swaps sides".

     NOT A FETCH AND NOT A LATCH. Both Blobs are pinned in RAM before connect, and the return
     leg's set() is never skipped (a back Blob and a front Blob are different objects, so
     applyGarment()'s no-op test cannot match). The time was spent CONFIRMING the flip.

     THE ROOT CAUSE. The corroborated path (ORIENT_CORROBORATED_FRAMES, ~1s) used to measure
     its swing from the |yaw| captured when the NEW vote streak began. |yaw| folds at edge-on:
     it climbs to ~90 and falls back to ~0 whether the shopper ends up facing the lens or
     facing away. The edge-on peak - the one thing a head-turn cannot produce - happens in the
     ABSTAIN window between the last vote for the old side and the first vote for the new
     one, so a baseline taken at streak start is always taken AFTER it. On the return leg the
     first "front" vote is FaceDetector re-acquiring a face, which a frontal detector does
     inside ~30-40 degrees of square, leaving at most that much swing to measure - under
     ORIENT_YAW_TURN_DEG. The return leg therefore always paid the full ORIENT_LOCK_FRAMES bar
     (~2.5s) with the back reference on screen. turn-yaw-window.test.mjs replays the numbers.

     THE WINDOW. The swing is now measured DOWN from the peak |yaw| seen since the last vote
     that AGREED with the lock. An agreeing vote means no turn is in progress, so it restarts
     the window at the current reading; every other tick (abstain, or a vote for the other
     side) folds a fresh reading into the peak. A real turn passes through edge-on and comes
     back down, so the swing is there by the first vote for the new side. A head-turn never
     raises the torso's yaw, so ORIENT_LOCK_FRAMES remains the only bar for it. Holding
     edge-on is not a turn either: the swing is peak minus NOW, which is ~0 while still side-on.

     THE ONE CASE IT ACCELERATES THAT THE OLD BASELINE DID NOT: an edge-on excursion that
     returns to the locked side while the vote MISREADS the other side on the way back. That
     flip would still have happened on ORIENT_LOCK_FRAMES of the same misread; it now needs
     ORIENT_CORROBORATED_FRAMES of it. A misread that systematic is a vote problem, not a
     hysteresis one.

     MAGNITUDE ONLY and it never picks a side - the result carries no direction. A stale or
     missing reading is not usable and cannot corroborate; the peak banked before a gap still
     counts once a fresh reading returns.

     ── THE EDGE-ON GAP - "it still falls back to 2.5s sometimes" ────────────────────────
     MediaPipe loses the far shoulder near edge-on: torsoReadable() fails and no yaw is
     published for exactly the band the peak lives in. With depth compressed, the last
     readable reading can sit well under ORIENT_YAW_TURN_DEG, so the swing never clears the bar
     and the flip waits the full ORIENT_LOCK_FRAMES.
     The gap is not treated as "no information". A torso that goes unreadable while the window
     is open and its last reading was already past edgeLossDeg was lost BECAUSE it rotated -
     the same inference startPresenceWatcher() already makes at PRESENCE_PROMPT_YAW_SUPPRESS_DEG
     to withhold "step into the frame" from a turning shopper. That loss is recorded as having
     reached edge-on, and the swing is then measured from 90 - the ceiling of the asin form,
     which is what an occluded shoulder line physically is. NOT extrapolated momentum: no
     angle is invented across the gap, the swing is still computed from a real fresh reading on
     the far side, and yaw still cannot say WHICH side that is - the vote does.
     A torso lost while nearly square (a step toward the lens, a hand across the body) is under
     edgeLossDeg and reads as nothing. An agreeing vote clears the evidence with the rest of the
     window.

     `open` / `turning` are what the mid-turn wire guard reads (see orientTurnMark): open from
     the first vote that does not agree with the lock until one does, turning while open AND the
     torso has visibly rotated - past ORIENT_YAW_TURN_DEG or lost to edge-on.
     `edgeAt` is when this turn reached the side view - the first reading at or past edgeOnDeg,
     or, for a torso lost to edge-on, when its last reading was taken - on the clock `at` is
     given in (the pose loop's reading time). orientPredictBack() measures dwell from it.
     `passed` is the side-view pass (see ORIENT_POSE_PASS): open, a fresh reading, a real turn behind it -
     the readable peak past turnDeg, or `lostAt` (the pose loop's last unreadable inference) later than
     the reading that last agreed with the lock - and |yaw| fallen descentDeg from the readable peak.
     `postPeakVotes` / `postPeakSince` are the votes for the other side since |yaw| last climbed
     peakRiseDeg (or the torso was first lost to edge-on), and when the first of them was taken - see
     ORIENT_POST_PEAK for why a flip may count nothing else.
     @param {number} [turnDeg] the swing that counts as a real torso rotation
     @param {number} [edgeLossDeg] a torso lost past this |yaw| mid-turn was lost to edge-on
     @param {number} [edgeOnDeg] a reading at or past this has reached the side view
     @param {number} [descentDeg] the fall from the readable peak that shows the torso went through
     @returns {{ readonly peak: number|null, readonly edgeLost: boolean, readonly open: boolean,
                 readonly turning: boolean, readonly edgeAt: number|null, readonly lostInTurn: boolean,
                 readonly postPeakVotes: number,
                 observe(vote: "front"|"back"|null, lock: "front"|"back"|null, yawAbs: number|null, at?: number, lostAt?: number):
                   { usable: boolean, swing: number, corroborates: boolean, passed: boolean,
                     postPeakVotes: number, postPeakSince: number|null } }} */
  function makeTurnYawWindow(turnDeg = ORIENT_YAW_TURN_DEG, edgeLossDeg = PRESENCE_PROMPT_YAW_SUPPRESS_DEG,
                             edgeOnDeg = ORIENT_EDGE_ON_DEG, descentDeg = ORIENT_PREDICT_DESCENT_DEG,
                             peakRiseDeg = ORIENT_POST_PEAK_RISE_DEG) {
    let peak = null;        // highest fresh |yaw| since the last vote that agreed with the lock
    let lastFresh = null;   // the most recent fresh |yaw|, to read a gap against
    let lastFreshAt = 0;    // ...and when it was taken
    let edgeLost = false;   // the torso went unreadable mid-turn past edgeLossDeg
    let edgeAt = null;      // when this turn reached the side view
    let open = false;       // a vote has not agreed with the lock since this turn began
    let agreedAt = 0;       // the reading time of the last vote that agreed with the lock
    let lostInTurn = false; // the pose loop could not read the torso after that reading
    let peakMark = null;    // |yaw| when the post-peak count last restarted - the next rise is measured from it
    let postVotes = 0;      // votes for the other side since then (see ORIENT_POST_PEAK)
    let postSince = null;   // ...and the reading time of the first of them
    return {
      get peak() { return peak; },
      get edgeLost() { return edgeLost; },
      get edgeAt() { return edgeAt; },
      get open() { return open; },
      get lostInTurn() { return lostInTurn; },
      get postPeakVotes() { return postVotes; },
      get turning() { return open && (edgeLost || (peak !== null && peak >= turnDeg)); },
      observe(vote, lock, yawAbs, at = Date.now(), lostAt = 0) {
        const fresh = yawAbs !== null && Number.isFinite(yawAbs);
        const edgeLostBefore = edgeLost;
        if (vote && vote === lock) {
          peak = fresh ? yawAbs : null;
          edgeLost = false;
          edgeAt = null;
          open = false;
          agreedAt = at;
        } else {
          open = true;
          if (fresh) {
            peak = peak === null ? yawAbs : Math.max(peak, yawAbs);
            if (edgeAt === null && yawAbs >= edgeOnDeg) edgeAt = at;
          } else if (lastFresh !== null && lastFresh >= edgeLossDeg) {
            edgeLost = true;
            if (edgeAt === null) edgeAt = lastFreshAt;
          }
        }
        /* POST-PEAK EVIDENCE (see ORIENT_POST_PEAK), kept out of the branches above so they read as they
           always have. The count restarts while the body is still turning AWAY: |yaw| has risen peakRiseDeg
           past where it was last marked (a rotation, not the jitter of a pose held still), or the torso is
           first lost to edge-on. The vote on that very tick counts - a reading that moves the mark can be
           the first one past the fold, after the torso went unreadable straight through edge-on; if the body
           is in fact still rising, the next 10 degrees clears it. */
        if (!open) { peakMark = fresh ? yawAbs : null; postVotes = 0; postSince = null; }
        else {
          const rising = fresh && (peakMark === null || yawAbs >= peakMark + peakRiseDeg);
          if (rising) peakMark = yawAbs;
          if (rising || (edgeLost && !edgeLostBefore)) { postVotes = 0; postSince = null; }
          if (vote) { postVotes++; if (postSince === null) postSince = at; }
        }
        if (fresh) { lastFresh = yawAbs; lastFreshAt = at; }
        /* Sticky until the next agreeing vote - which is what clears it - so a dropped frame during a
           pose the shoulders keep voting for (a twist) is erased by the very next readable reading. */
        lostInTurn = open && lostAt > agreedAt;
        const reference = edgeLost ? 90 : peak;
        const usable = fresh && reference !== null;
        const swing = usable ? Math.max(0, reference - yawAbs) : 0;
        /* Measured from the READABLE peak, never from edgeLost's 90: a compressed edge-on reading is
           already well under 90, so descent from 90 is what a parked profile with one dropped frame
           would show. */
        const passed = open && fresh && peak !== null && (peak >= turnDeg || lostInTurn) && peak - yawAbs >= descentDeg;
        return { usable, swing, corroborates: swing >= turnDeg, passed, postPeakVotes: postVotes, postPeakSince: postSince };
      },
    };
  }
  /* How far |yaw| must rise past its last mark for the post-peak count to restart (ORIENT_POST_PEAK). Measured
     as a cumulative rise, not per reading - a slow turn climbs 3-5 degrees a reading. 10 sits above the +/-4
     degrees of yaw jitter the turn model assumes: the first cut restarted the count on every new jitter
     maximum, so a shopper standing square with BACK still on the wire kept losing the FRONT votes that should
     undo it - 52 more modelled fast 360s under dropped frames never swapped, and 12 ended on BACK. The same 10
     the slow path takes for "a rise, not jitter" (ORIENT_EARLY_TURN_SLOW_RISE_DEG). Declared inside the block
     the tests extract, so it stays self-contained (CLAUDE.md 2.6). */
  const ORIENT_POST_PEAK_RISE_DEG = 10;

  /* The flip decision the sampler acts on, lifted out of the tick so it is real code under test
     rather than arithmetic buried in a closure. Every bar is the one documented beside its
     constant: acquisition on ORIENT_ACQUIRE_FRAMES; a flip on ORIENT_LOCK_FRAMES, lowered to
     ORIENT_CORROBORATED_FRAMES by a corroborated turn, OR ORIENT_LOCK_MS of agreement; and the
     face return (see ORIENT_FACE_RETURN_FRAMES) - toward FRONT only, only on FaceDetector
     detections, only with the turn corroborated.
     `turnPassed` (the window's side-view pass - see ORIENT_POSE_PASS) corroborates the pose flip ONLY:
     the corroborated bar and the face return keep the 45-degree swing. `early` is a flip confirmed on
     the pass alone, which the tick sends as withdrawable.
     `postPeakVotes` / `postPeakHeld` cap every UN-DOING bar at the evidence cast after the turn's peak -
     the vote count and the held time alike, all four routes - see ORIENT_POST_PEAK. Acquisition is
     exempt: there is no lock yet for stale evidence to un-do. Both default to Infinity, which is the
     decision exactly as it was before them (and what ?post_peak=0 passes).
     @returns {{ flipBar: number, faceReturn: boolean, poseFlip: boolean, early: boolean, confirmed: boolean }} */
  function orientFlipDecision({ acquiring, needsSwitch, streak, held, yawCorroborates, lock, lastVote, faceStreak, poseStreak = 0, turnPassed = false,
                                postPeakVotes = Infinity, postPeakHeld = Infinity }) {
    const flipBar = yawCorroborates
      ? Math.min(ORIENT_LOCK_FRAMES, ORIENT_CORROBORATED_FRAMES)
      : ORIENT_LOCK_FRAMES;
    const votes = Math.min(streak, postPeakVotes);
    const dwell = Math.min(held, postPeakHeld);
    const faceReturn = !acquiring && lock === "back" && lastVote === "front" &&
      yawCorroborates && Math.min(faceStreak, postPeakVotes) >= ORIENT_FACE_RETURN_FRAMES;
    /* Either direction - see ORIENT_POSE_FLIP_FRAMES. */
    const poseFlip = !acquiring && !!lock && (lastVote === "front" || lastVote === "back") && lastVote !== lock &&
      (yawCorroborates || turnPassed) && Math.min(poseStreak, postPeakVotes) >= ORIENT_POSE_FLIP_FRAMES;
    const confirmed = needsSwitch && (acquiring
      ? streak >= ORIENT_ACQUIRE_FRAMES
      : (votes >= flipBar || dwell >= ORIENT_LOCK_MS || faceReturn || poseFlip));
    const early = confirmed && !acquiring && poseFlip && !yawCorroborates && !(votes >= flipBar || dwell >= ORIENT_LOCK_MS);
    return { flipBar, faceReturn, poseFlip, early, confirmed };
  }

  /* Should BACK go on the wire NOW, ahead of any back vote? See ORIENT_PREDICTIVE_BACK for the
     report and the argument. Only from a FRONT lock; only while the window is open (no vote has
     agreed with FRONT since the turn began, so no face) and turning; only once the torso has
     passed the side view - reached it, then fallen ORIENT_PREDICT_DESCENT_DEG on a fresh reading -
     and only if that took no longer than ORIENT_PREDICT_DWELL_MS, which a held profile does.
     Yaw still never picks a side on its own: the absence of every front vote across a full pass
     through edge-on is what does, and a face returning withdraws it.
     @returns {boolean} */
  function orientPredictBack(args) {
    return orientPredictBackReason(args) === "fire";
  }

  /* The same gate, answering WHY - "fire", or the first condition that held it back, with the
     numbers the thresholds are tuned from. orientPredictBack() is defined as this returning
     "fire", so the decision and its explanation cannot drift apart. It exists because a report of
     "PEAK on the back, the back graphic a second late" is exactly what a turn looks like when the
     prediction did NOT engage and the vote path carried the flip; the ORIENT_DEBUG tick line
     prints this on every tick of an open turn from a FRONT lock, so one logged turn settles which.
     @returns {string} */
  function orientPredictBackReason({ enabled = ORIENT_PREDICTIVE_BACK, acquiring, lock, win, yawAbs, now }) {
    if (!enabled) return "disabled (?predict_back=0)";
    if (acquiring || lock !== "front") return `no FRONT lock (${lock === null ? "acquiring" : lock})`;
    if (!win || !win.open) return "window closed (a vote agrees with FRONT - face in view)";
    if (!win.turning || win.edgeAt === null) {
      const peak = win.peak === null ? "n/a" : `${win.peak.toFixed(0)}°`;
      return `edge-on not reached (peak ${peak} < ${ORIENT_EDGE_ON_DEG}°, torso ${win.edgeLost ? "lost" : "tracked"})`;
    }
    if (yawAbs === null || !Number.isFinite(yawAbs)) return "no fresh yaw reading";
    const reference = win.edgeLost ? 90 : win.peak;
    const fell = reference - yawAbs;
    if (fell < ORIENT_PREDICT_DESCENT_DEG) {
      return `no descent yet (${yawAbs.toFixed(0)}° is ${fell.toFixed(0)}° below ${win.edgeLost ? "edge-on" : "peak " + reference.toFixed(0) + "°"}, need ${ORIENT_PREDICT_DESCENT_DEG}°)`;
    }
    const dwell = now - win.edgeAt;
    if (dwell > ORIENT_PREDICT_DWELL_MS) return `dwell ${dwell}ms > ${ORIENT_PREDICT_DWELL_MS}ms (a held pose)`;
    return "fire";
  }

  /* The opt-in early turn trigger (?early_turn=<deg> - see ORIENT_EARLY_TURN_DEG). Pure state, fed one
     observation per sampler tick; the tick does the dispatching.
     ARMED only by a vote that AGREES with the lock while |yaw| is under `deg` - the shopper settled
     square on that side. FIRES once, on the first fresh |yaw| at or past `deg`, for the other side, and
     disarms: without that, the abstain stretch through edge-on (|yaw| still past `deg`, against the NEW
     lock) would fire straight back. Re-arms only on the new side, square again.
     WITHDRAWS its own swap when the turn does not happen: while the early side is on the lock and no
     vote has agreed with it yet, a vote for the side it left with |yaw| back under `deg` is a pose
     that came back - a twist, a look at the side view. Any vote for the early side confirms the turn
     and ends the watch. A lock that moved some other way (the swap never went out, or a vote-confirmed
     flip) ends it too.
     THE SPEED GATE (`minSpeed`, ?early_turn_speed=<deg/s>): the crossing only fires while |yaw| is RISING at
     least that fast, measured between consecutive pose readings (`at`, the reading's own time). A slow
     drift past the threshold - a sway, a weight shift - keeps the trigger armed without firing; if the
     motion then speeds up while still past the threshold, it fires then. Rising only: a fast return
     from past the threshold is never read as a turn starting. Units are the pose model's |yaw| per
     second, not true body degrees - MediaPipe compresses depth. See ORIENT_EARLY_TURN_MIN_SPEED.
     THE RETURN LEG HAS ITS OWN THRESHOLD (`returnDeg`, used while the lock is BACK). Sending FRONT early swaps
     the back graphic out while the back is still turned to the lens, and FRONT on a back-facing body renders a
     plain back - see ORIENT_EARLY_TURN_RETURN_DEG for the live clip that showed it and the numbers that set it.
     @param {number} deg  |yaw| threshold from a FRONT lock (and from BACK unless returnDeg is given); 0 or less is off
     @param {number} [minSpeed]  rising |yaw| deg/s a crossing needs; 0 or less is no gate
     @param {number} [returnDeg]  |yaw| threshold from a BACK lock; 0 or less never fires FRONT early
     @param {number} [slowDeg]  the slow path's |yaw| threshold (see ORIENT_EARLY_TURN_SLOW_DEG); 0 or less is off
     @param {number} [slowRise]  |yaw| the slow path must have gained across its window
     @param {number[]} [slowWindow]  [min, max] age in ms of the reading that rise is measured from
     THE FOLD BY LOSS (`lossDeg`, ?early_turn_loss - the fold handshake, see ORIENT_EARLY_TURN_DEFAULT_DEG). With the
     threshold at the side view, many turns never publish a reading that high: MediaPipe loses the far shoulder right
     there and the pose loop records the inference as unreadable (`lostAt`, _poseTorsoLostAt) instead. So, while armed,
     a torso lost AFTER the last readable reading - that reading at or past `lossDeg` and still rising (the speed gate,
     or the slow path's rise) - fires too. Evaluated AHEAD of the arming test on purpose: through that gap the shoulder
     order stays fresh for ORIENT_YAW_FRESH_MS and keeps voting for the locked side, and an agreeing vote under the
     threshold would otherwise swallow the tick. A pose that settled (no rise) or a dropped frame while square (under
     `lossDeg`) fires nothing, and any fire is withdrawn exactly like the other two paths.
     @param {number} [lossDeg]  |yaw| the last readable reading needs for a torso loss to count as the fold; 0 or less is off
     @returns {{ readonly armed: "front"|"back"|null, readonly pending: {from: string, to: string}|null,
                 readonly speed: number,
                 observe(o: { vote: "front"|"back"|null, lock: "front"|"back"|null, yawAbs: number|null, at?: number|null, lostAt?: number }):
                   { fire: "front"|"back"|null, withdraw: "front"|"back"|null, via?: "fast"|"slow"|"lost" } }} */
  function makeEarlyTurnTrigger(deg, minSpeed = 0, returnDeg = deg, slowDeg = 0, slowRise = 10, slowWindow = [450, 960], lossDeg = 0) {
    const thresholdFor = (side) => (side === "back" ? returnDeg : deg);
    /* THE SLOW PATH's own window of readings - see ORIENT_EARLY_TURN_SLOW_DEG. Bounded; readings are the
       pose loop's, ~240ms apart, so eight covers well past the window below. */
    const hist = [];
    /* How far |yaw| climbed to reading (y, t) from the one the slow window reaches back to; 0 without one. */
    const riseTo = (y, t) => {
      if (!Number.isFinite(t)) return 0;
      const from = hist.find((h) => t - h.at >= slowWindow[0] && t - h.at <= slowWindow[1]);
      return from ? y - from.y : 0;
    };
    const LOSS_MIN_RISE = 10;   // deg/s the last two readings must still climb for a slow-path rise to count toward a loss
    let armed = null;     // the lock this trigger was armed on
    let pending = null;   // { from, to, via, at } - an early swap that no vote has confirmed yet
    let lastYaw = null, lastAt = null, speed = 0;   // rising |yaw| deg/s between the last two readings
    const none = { fire: null, withdraw: null };
    return {
      get armed() { return armed; },
      get pending() { return pending; },
      get speed() { return speed; },
      observe({ vote, lock, yawAbs, at = null, lostAt = 0 }) {
        if (!(deg > 0) || (lock !== "front" && lock !== "back")) { armed = null; pending = null; return none; }
        const fresh = yawAbs !== null && Number.isFinite(yawAbs);
        /* One reading counted once: a tick that sees the same reading again leaves the speed alone. */
        if (fresh && Number.isFinite(at)) {
          if (lastAt !== null && at > lastAt) speed = (yawAbs - lastYaw) / ((at - lastAt) / 1000);
          if (lastAt === null || at > lastAt) { lastYaw = yawAbs; lastAt = at; hist.push({ y: yawAbs, at }); if (hist.length > 8) hist.shift(); }
        }
        if (pending) {
          /* Ended by the lock leaving the early side (the withdrawal landed, or the swap never went
             out) or by a vote for the early side (the turn is real). Otherwise the withdrawal is
             asked for on EVERY tick its condition holds, not once: maybeSwap() can refuse a tick
             (a swap still applying), and a withdrawal asked for once and refused would be lost. */
          if (lock !== pending.to || vote === pending.to) pending = null;
          /* A fold-by-loss fire went out on NO new reading, so the last one - under the threshold, which is why the
             loss path was needed - and its shoulder vote for the side being left both stay fresh for
             ORIENT_YAW_FRESH_MS. Read as "the pose came back" they withdraw the swap on the very next tick, and
             the side the shopper is turning away from goes straight back on. Only a reading taken after the fire
             can say the pose came back. The other two paths fire ON a reading past the threshold, so a reading
             under it is necessarily newer - this changes nothing for them. */
          else if (pending.via === "lost" && !(Number.isFinite(at) && at > pending.at)) return none;
          else if (vote === pending.from && fresh && yawAbs < thresholdFor(pending.from)) return { fire: null, withdraw: pending.from };
          else return none;
        }
        if (armed !== lock) armed = null;
        const threshold = thresholdFor(lock);
        if (!(threshold > 0)) { armed = null; return none; }
        /* THE FOLD BY LOSS - see lossDeg above. Ahead of the arming test, which a stale agreeing vote would pass.
           "Still rising" is the gate's speed, or the slow path's rise AND the last two readings still climbing: the slow
           window reaches back ~1s, so on its own it also reads a twist that rose and has been HELD for most of a second.
           MODELLED (turn-yaw-window §13): the last-pair clause costs no full 360 anything, and cuts the fires on a twist to
           30 held 0.7s, a slow look to 30 and a 45-degree mirror check by about a third under dropped frames. */
        const lost = lossDeg > 0 && lastAt !== null && Number.isFinite(lostAt) && lostAt > lastAt && lastYaw >= lossDeg &&
          ((minSpeed > 0 ? speed >= minSpeed : speed > 0) || (riseTo(lastYaw, lastAt) >= slowRise && speed >= LOSS_MIN_RISE));
        if (!lost && vote === lock && fresh && yawAbs < threshold) {
          /* A FRESH ARM IS WHERE THIS LEG'S READINGS BEGIN (2026-09-22). Every rise this trigger fires on - the
             fast path's speed, the slow path's window, the loss path's "still rising" - is measured AWAY from the
             side it is armed on, so it may only be measured from readings taken since it was armed there. Kept
             across the arm, the history reached back past the edge-on fold the lock just moved across: |yaw| folds
             at 90, so a reading of ~30 on the way INTO a turn and one of ~40 on the way OUT of it, with the torso
             unreadable between them, read as a +11 deg/s, +10.8-degree rise while the body was de-rotating toward
             back-square. One dropped frame after that fired FRONT at a body angle of 158 degrees (the loss path),
             withdrawn at 180 - modelled, turn-yaw-window §14. The arming reading itself stays as the baseline. */
          if (armed !== lock) { hist.length = 0; if (Number.isFinite(at)) hist.push({ y: yawAbs, at }); speed = 0; }
          armed = lock; return none;
        }
        /* THE FAST PATH: past the threshold, rising at the gate's speed between two readings. */
        const fast = yawAbs >= threshold && (!(minSpeed > 0) || speed >= minSpeed);
        /* THE SLOW PATH: a deliberate slow turn never clears the gate between two readings, but it keeps
           RISING - measured across ORIENT_EARLY_TURN_SLOW_WINDOW_MS, which averages the jitter a
           two-reading speed cannot. Above ORIENT_EARLY_TURN_SLOW_DEG, where poses have stopped. */
        const rise = slowDeg > 0 && fresh ? riseTo(yawAbs, at) : 0;
        const slow = slowDeg > 0 && yawAbs >= Math.max(threshold, slowDeg) && rise >= slowRise;
        const via = fresh && fast ? "fast" : fresh && slow ? "slow" : lost ? "lost" : null;
        if (armed === lock && via) {
          const to = lock === "front" ? "back" : "front";
          armed = null; pending = { from: lock, to, via, at: lastAt };
          return { fire: to, withdraw: null, via };
        }
        return none;
      },
    };
  }

  /* Edge-on detection thresholds. Deliberately FAR looser than the orientation lock's,
     because the two protect different things and carry different costs when wrong. A wrong
     orientation flip swaps the garment reference and shows the wrong side of the shirt on a
     shopper's body - expensive, hence ORIENT_LOCK_FRAMES/ORIENT_LOCK_MS at ~2.5s. A wrong
     profile reading only softens a pose sentence and adds a "preserve their real body
     volume" instruction, which is a true statement at every angle; the worst case is a few
     hundred wasted prompt characters. The asymmetry is the whole reason this can react in
     ~500ms while the lock still takes seconds - and it matters, because a 90-degree turn
     passes through the window this is trying to catch. */
  const ORIENT_PROFILE_ENTER  = 2;     // min samples in the buffer before it may assert anything (~500ms)
  /* ROLLING WINDOW. The per-frame edge-on score is noisy by nature - it is read off a 96px
     canvas with no model behind it - so the decision is made on the MEAN of the last N
     scores rather than on any single frame. This is the anti-jitter mechanism: a shopper
     parked near the threshold angle produces scores that straddle it, and averaging turns
     that into one stable answer instead of a toggle every 250ms. Five samples is ~1.25s of
     evidence, short enough to still catch a turn in progress. */
  const ORIENT_PROFILE_WINDOW = 5;
  /* Mean score over that window required to ASSERT edge-on. Calibrated against the weights
     in profileScore() so that no single weak signal can reach it alone - see that
     function's table. */
  const ORIENT_PROFILE_ENTER_SCORE = 0.55;
  /* FAST PATH, and it is not redundant with the mean above. Averaging over five samples is
     the right answer for a shopper hovering near the threshold angle, but it is the wrong
     one for a decisive turn: the window still holds the square-on scores from before the
     rotation started, so a shopper who is unambiguously side-on has to wait for those to
     age out. Measured on the modelled spin in side-profile.test.mjs §5d, that cost a full
     sample - EDGE-ON landed at ~110° instead of at 90°.
     Two consecutive samples this high mean several independent signals agree at once
     (ambiguous skin AND a foreshortened silhouette - see profileScore's table), which is a
     turn, not noise. Borderline oscillation cannot reach it, so the jitter protection the
     mean provides is untouched: the two paths cover disjoint cases. */
  const ORIENT_PROFILE_FAST_SCORE  = 0.85;
  const ORIENT_PROFILE_FAST_FRAMES = 2;
  /* Consecutive square-on samples required to LEAVE edge-on. The previous build exited on
     the first one; two sustained windows (~500ms) is the anti-jitter half of the same
     asymmetry, and stops a single well-lit frame mid-turn from dropping the depth clause
     and snapping the pose back for one message. Still deliberately short - a stale
     "they are side-on" claim is the same class of false pose assertion this feature exists
     to remove, so it must not outlive the evidence by much. */
  const ORIENT_PROFILE_EXIT   = 2;
  /* Floor below which a per-frame score counts as "no meaningful profile evidence" - used
     both by the squareStreak count above and, as the earliest possible signal, by the turn
     hold below (see orientHoldBegin's "profile-turn-detected" reason): the same asymmetry
     that makes ENTER slow and deliberate but EXIT/abandon fast applies to freezing the last
     dressed frame - a hold that outlives real evidence by much is a stuck still, not a fix. */
  const ORIENT_PROFILE_EXIT_SCORE = 0.25;

  /* ── ONE WATCHER'S DECISION STATE - moved from createOrientationWatcher() ────────── */
  let lastVote = null, streak = 0, streakSince = 0;
  const yawWindow = makeTurnYawWindow();
  const earlyTurn = ORIENT_EARLY_TURN_DEG > 0
    ? makeEarlyTurnTrigger(ORIENT_EARLY_TURN_DEG, ORIENT_EARLY_TURN_MIN_SPEED, ORIENT_EARLY_TURN_RETURN_DEG,
        ORIENT_EARLY_TURN_SLOW_DEG, ORIENT_EARLY_TURN_SLOW_RISE_DEG, ORIENT_EARLY_TURN_SLOW_WINDOW_MS, ORIENT_EARLY_TURN_LOSS_DEG) : null;
  let faceStreak = 0;
  let poseStreak = 0, poseSide = null;
  let profileBuf = [], squareStreak = 0, strongStreak = 0;

  /* THE PROFILE AXIS'S DECISION - the first half of what was maybeUpdateProfile() in app.js,
     moved verbatim: the rolling buffer, the square-on / strong streaks and the enter/exit
     rule. Returns the pose the evidence now calls for; applying it (the cooldown, the
     wire mutex, the dispatch) stays in the browser, in maybeApplyProfile(). */
  function profileNext(score, autoProfile) {
    profileBuf.push(score);
    if (profileBuf.length > ORIENT_PROFILE_WINDOW) profileBuf.shift();
    const mean = profileBuf.reduce((a, b) => a + b, 0) / profileBuf.length;
    // "Square-on" for the EXIT test is the absence of meaningful evidence, not merely a
    // score below the enter threshold - otherwise the two thresholds would sit on top of
    // each other and the shopper would oscillate across the single boundary between them.
    squareStreak = score <= ORIENT_PROFILE_EXIT_SCORE ? squareStreak + 1 : 0;
    strongStreak = score >= ORIENT_PROFILE_FAST_SCORE ? strongStreak + 1 : 0;

    /* ASYMMETRIC BY DESIGN, and the two directions read different statistics.

       ENTER on the windowed MEAN: entering is the decision that must not be made on one
       noisy frame, and averaging is what stops a shopper parked near the threshold angle
       from toggling the pose every 250ms.

       LEAVE on a CONSECUTIVE run of square-on samples: the mean is deliberately slow to
       fall (an old high score lingers in the window for over a second), which would keep
       asserting "side-on" well after the shopper came back around - the same class of
       false pose assertion, pointing the other way. A short consecutive run answers "are
       they square-on NOW?" without waiting for history to decay out. */
    const next = autoProfile
      ? !(squareStreak >= ORIENT_PROFILE_EXIT)
      : (strongStreak >= ORIENT_PROFILE_FAST_FRAMES ||
         (profileBuf.length >= ORIENT_PROFILE_ENTER && mean >= ORIENT_PROFILE_ENTER_SCORE));
    return next;
  }

  /** One tick: the sample in, the actions out. */
  function step(s) {
    const acts = [];
    const act = (a) => acts.push(a);
    const log = (...parts) => { if (ORIENT_DEBUG) act({ do: "log", line: parts.join(" ") }); };
    const vote = s.vote;
    if (vote) {
      if (vote === lastVote) streak++;
      else { lastVote = vote; streak = 1; streakSince = s.t; }
      /* Consecutive FaceDetector DETECTIONS within the current front streak. An abstention
         leaves it alone, like `streak`; a skin-heuristic "front" or any "back" vote breaks
         it - only a detection is the strong direction ORIENT_FACE_RETURN_FRAMES trusts. */
      faceStreak = vote === "front" && s.faceSeen ? faceStreak + 1 : 0;
      /* Consecutive shoulder-order votes for ONE side (see ORIENT_POSE_FLIP_FRAMES). A skin vote
         breaks it, and so does a shoulder vote for the other side. */
      if (s.poseVoted) { poseStreak = vote === poseSide ? poseStreak + 1 : 1; poseSide = vote; }
      else { poseStreak = 0; poseSide = null; }
    }
    const held = lastVote ? s.t - streakSince : 0;

    /* ── DID THE TORSO ACTUALLY ROTATE? ────────────────────────────────────────────
       Independent, 3D corroboration for the vote - see ORIENT_CORROBORATED_FRAMES for
       the full argument. Three things must all hold, and each rules out a specific way
       of being wrong:
         · a fresh reading exists          - stale yaw describes a pose already left;
         · a peak was banked this turn     - without one there is no swing to measure;
         · the swing clears the threshold  - a head-turn moves the head, not the
                                             shoulders, and earns nothing here.
       Abstains to false on every missing piece, which lands on ORIENT_LOCK_FRAMES -
       exactly the behaviour that shipped before this existed.
       The swing is measured DOWN from the peak since the last vote that agreed with the
       lock, NOT from where this vote streak began - see makeTurnYawWindow() for why the
       streak-start baseline could never corroborate the return leg of a 360.
       Observed EVERY tick, abstentions included: the edge-on peak lives in exactly the
       ticks where the vote abstains. `autoOrientation` is read before this tick's
       maybeSwap(), so an agreeing vote is measured against the side actually on the wire. */
    const yawFresh = s.yawAbs !== null && s.t - s.yawAt <= ORIENT_YAW_FRESH_MS;
    /* The reading's own timestamp, not the tick's: the side-view dwell orientPredictBack()
       measures is a property of the pose loop's clock, which runs independently of this one. */
    const turnYaw = yawWindow.observe(vote, s.lock, yawFresh ? s.yawAbs : null, yawFresh ? s.yawAt : s.t, s.lostAt);
    const yawSwing = turnYaw.swing;
    const yawCorroborates = turnYaw.corroborates;
    /* Two DIFFERENT transitions, with deliberately different bars:

       ACQUIRING (autoOrientation === null, PENDING_MODE) - establishing the first
       reading of the session. There is no confirmed state to protect, so the full
       anti-flap threshold buys nothing and costs the shopper 2.5s of the wrong side
       rendered on their body. Two agreeing confident samples settle it.

       FLIPPING (a side is already locked) - un-doing a confirmed reading, which is
       exactly what the hysteresis exists for. Unchanged: ORIENT_LOCK_FRAMES
       consecutive agreeing votes OR ORIENT_LOCK_MS of sustained agreement.

       Note `acquiring` also makes needsSwitch true when the first vote happens to be
       "front": the lock still has to MOVE (null → "front") for the state to become
       confirmed, and that transition must be recorded rather than silently skipped. */
    const acquiring = s.lock === null;
    const needsSwitch = !!lastVote && (acquiring || lastVote !== s.lock);
    /* THE FLIP BAR IS THE MINIMUM OF TWO PATHS, NEVER A LOWERED SINGLE ONE.
       ORIENT_LOCK_FRAMES / ORIENT_LOCK_MS are byte-for-byte the bar they always were and
       still carry every flip on their own. The corroborated path is an ADDITIONAL route
       that requires MORE total evidence than the original - 4 agreeing votes AND a
       45-degree torso rotation measured on a different instrument - in exchange for
       reaching the decision in ~1s instead of ~2.5s. A flip can still only happen on a
       vote streak; yaw never picks a side. Acquiring is untouched: there is no locked
       side to protect, so it already settles on two samples.
       The arithmetic lives in orientFlipDecision(), which adds exactly one path: the face
       return (ORIENT_FACE_RETURN_FRAMES) - FRONT only, detections only, corroborated only. */
    const { flipBar, faceReturn, poseFlip, early, confirmed } = orientFlipDecision({
      acquiring, needsSwitch, streak, held, yawCorroborates, lock: s.lock, lastVote, faceStreak, poseStreak,
      turnPassed: ORIENT_POSE_PASS && turnYaw.passed,
      /* Only evidence from after the turn's peak may un-do the lock - see ORIENT_POST_PEAK. */
      postPeakVotes: ORIENT_POST_PEAK ? turnYaw.postPeakVotes : Infinity,
      postPeakHeld: !ORIENT_POST_PEAK ? Infinity : turnYaw.postPeakSince === null ? 0 : s.t - turnYaw.postPeakSince,
    });

    if (ORIENT_DEBUG) {
      /* The per-tick tuning line. The browser contributes what only it measured (s.dbg:
         the engine behind the vote and its confidence, the skin ratio, the silhouette width,
         the rendered state); everything about the DECISION is added here. Emitted only for a
         session the server allowed to debug - see createOrientEngine()'s `debug`. */
      const d = s.dbg || {};
      const confidence = (d.confidence || "n/a") + (s.poseVoted ? ` (pose ${poseStreak}/${ORIENT_POSE_FLIP_FRAMES})` : "");
      const status = confirmed ? (acquiring ? "ACQUIRING" : "SWITCHING")
        : needsSwitch ? (acquiring ? "waiting-to-acquire" : "waiting-to-switch") : "locked";
      const progress = acquiring
        ? ` (${streak}/${ORIENT_ACQUIRE_FRAMES}f)`
        : ` (${streak}/${flipBar}f${yawCorroborates ? "+yaw" : ""}, ${held}/${ORIENT_LOCK_MS}ms` +
          `, yawΔ${yawSwing.toFixed(0)}° from ${yawWindow.edgeLost ? "edge-on (torso lost)" : "peak " + (yawWindow.peak === null ? "n/a" : yawWindow.peak.toFixed(0) + "°")}` +
          `, face ${faceStreak}/${ORIENT_FACE_RETURN_FRAMES}${faceReturn ? " FACE-RETURN" : ""}${poseFlip ? (early ? " POSE-FLIP(pass)" : " POSE-FLIP") : ""}` +
          `, torso lost ${yawWindow.lostInTurn ? "yes" : "no"}, passed ${turnYaw.passed ? (ORIENT_POSE_PASS ? "yes" : "yes (off: ?pose_pass=0)") : "no"}` +
          `, after peak ${turnYaw.postPeakVotes}v${ORIENT_POST_PEAK ? "" : " (off: ?post_peak=0)"})`;
      const mean = profileBuf.length ? profileBuf.reduce((a, b) => a + b, 0) / profileBuf.length : 0;
      const pose = `pose=${s.profile ? "EDGE-ON" : "square-on"}` +
        ` | ratio=${d.ratio || "n/a"}` +
        ` | score=${Number(s.profileScore).toFixed(2)}(avg ${mean.toFixed(2)}/${ORIENT_PROFILE_ENTER_SCORE})` +
        ` | w=${d.narrow || "n/a"}`;
      const predict = s.dualView && s.lock === "front" && yawWindow.open
        ? ` | predict: ${orientPredictBackReason({ acquiring, lock: s.lock, win: yawWindow,
            yawAbs: yawFresh ? s.yawAbs : null, now: s.t })}`
        : "";
      const earlyState = earlyTurn
        ? ` | early ${ORIENT_EARLY_TURN_DEG}°: ${earlyTurn.pending ? `${earlyTurn.pending.to.toUpperCase()} sent early, unconfirmed` : earlyTurn.armed ? `armed on ${earlyTurn.armed.toUpperCase()}` : "not armed"}` +
          ` (|yaw| rising ${earlyTurn.speed.toFixed(0)}°/s${ORIENT_EARLY_TURN_MIN_SPEED > 0 ? `, gate ${ORIENT_EARLY_TURN_MIN_SPEED}°/s` : ""})`
        : "";
      log(`[PEAR][ORIENT] state=${d.state || "n/a"} | ${pose} | confidence=${confidence} | ${status}` +
        (needsSwitch ? progress : "") + predict + earlyState);
    }

    /* Raise the hold the INSTANT a turn looks like it is starting - one disagreeing
       vote against a locked side, OR early evidence the shopper is turning edge-on - so
       the frame we freeze is still a good dressed one. Waiting for `confirmed` (front/
       back) or the ENTER threshold (profile, ~500ms of corroboration by design - see
       ORIENT_PROFILE_ENTER's comment) is too late for the same reason either way.
       THE GAP THIS CLOSES: maybeUpdateProfile() never re-uploads the reference image, so
       the ASSET can never be wrong while turning edge-on - but that says nothing about
       the PIXELS in the meantime. Until its prompt update actually lands, Lucy is still
       regenerating a foreshortened, mid-turn person against a prompt that has not caught
       up - per ROTATION_CONTINUITY's own comment, the exact condition under which the
       most probable completion is the shopper's real shirt. SIDE_PROFILE_DEPTH is a
       probabilistic bias on that frame, not a guarantee (see COMPOSITE_TEMPORAL's
       comment) - this is the deterministic backstop the front/back axis already had and
       the profile axis never got when it was added.
       Excluded while ACQUIRING (dual-view) / before anything has ever been dressed
       (single-view): there is no confirmed side, or no rendered frame at all, to
       protect yet, and freezing the very first frames of a session would just stall
       the reveal.

       TWO TIERS, mirroring syncOrientationWatcher()'s split. `dualView` sessions have a
       front/back LOCK to protect, so frontBackTurn uses it exactly as before (`acquiring`
       is meaningless without a lock - autoOrientation never leaves PENDING for a
       single-view item, since maybeSwap() never runs for one). `holdReady` is the
       readiness gate for the profile axis specifically, and it needs its OWN readiness
       signal for single-view sessions, where there is no lock to be "acquiring": once
       the very first frame has ever been dressed (isGarmentApplied), a profile reading
       is worth protecting the same way a dual-view one is. */
    /* ╔════════════════════════════════════════════════════════════════════════╗
       ║  THE 90-DEGREE FREEZE. This block WAS the bug. Read before restoring.  ║
       ╚════════════════════════════════════════════════════════════════════════╝
       REPORTED: "the feed freezes for a second or two, but ONLY when I turn sideways,
       and ONLY live - the recording of the same session is smooth."

       That asymmetry is the whole diagnosis, and it rules out WebRTC entirely. The
       recorder's paint loop draws #aiVideo directly (see startRecording); the freeze
       was #orientFadeCanvas - an opaque still snapshot, z-index 6, pinned over #aiVideo
       inside #cameraCard - which the recorder cannot see. Live: frozen. Replay: smooth.
       Nothing was ever wrong with the stream.

       WHAT RAISED IT, and why it lasted so long. `enteringProfile` fired at
       lastProfileScore > ORIENT_PROFILE_EXIT_SCORE - the EXIT threshold, 0.25, which is
       deliberately low because its job is hysteresis on the way OUT. Used as an entry
       trigger it fires the instant a shopper starts to turn. Release then required
       autoProfile to actually flip, which needs ORIENT_PROFILE_ENTER samples at >= 0.55
       (~500ms at best), plus a tick to notice. So even a clean 90-degree turn froze the
       view for ~750ms - and a shopper who lingered anywhere between 0.25 and 0.55, which
       is most of a real rotation, held it raised until the 4s ceiling. That is the
       "1-2 second freeze".

       WHY IT IS RETIRED RATHER THAN RETUNED. Its stated purpose was to cover the window
       "until its prompt update actually lands" - the pose sentence catching up. There is
       no pose sentence any more. Under strict image-only conditioning the prompt is one
       frozen string, so maybeUpdateProfile()'s applyActive() finds the image AND the
       prompt unchanged and dispatches nothing at all (see applyGarment's no-op skip).
       The hold was freezing the live view for up to four seconds to hide a transition
       that no longer transitions anything. Retuning the threshold would only shorten a
       freeze that has no remaining purpose.

       THE FRONT/BACK HOLD STAYS, and the difference is not cosmetic: that one covers a
       real ASSET swap - with COMPOSITE_DEFAULT off, a confirmed flip changes the
       reference image and re-uploads it - so there genuinely is a window in which the
       model is between garments. It ends when the swap completes, not on a guess.

       TO RESTORE THE PROFILE HOLD you would first have to give it something to cover:
       restore a pose clause to the prompt (see IMAGE_ONLY_PROMPT's restore list) so the
       profile transition dispatches again. Then raise it on ORIENT_PROFILE_ENTER_SCORE,
       never on the EXIT threshold. */
    const dualView = s.dualView;
    /* PREDICTIVE BACK - see ORIENT_PREDICTIVE_BACK. Evaluated only when no vote-confirmed
       switch is due this tick; dispatched at the bottom of the tick, beside it. */
    const predictBack = dualView && !confirmed && orientPredictBack({
      acquiring, lock: s.lock, win: yawWindow, yawAbs: yawFresh ? s.yawAbs : null, now: s.t,
    });
    /* THE TURN OWNS THE WIRE from here until a vote agrees with the lock again - see
       orientTurnMark(). Spans the abstain stretch through edge-on that the hold below does
       not, which is where a body re-drape used to start and then hold the wire against the
       swap. Includes a confirmed switch (needsSwitch), so it is still up while maybeSwap()
       below is dispatching. */
    act({ do: "turnMark", on: dualView && !acquiring && (needsSwitch || yawWindow.turning) });
    const frontBackTurn = dualView && !acquiring && needsSwitch && !confirmed;
    if (frontBackTurn) {
      /* Bank the frame on the FIRST disagreeing vote, exactly as before - this is the
         last instant the render is reliably a good dressed one. */
      act({ do: "holdBegin", reason: "turn-detected" });
      /* ── BUT ONLY COVER THE FEED ON EVIDENCE OF A REAL TORSO ROTATION ──────────
         REPORTED: "the live view freezes whenever I move." It did, and for up to the
         4s ceiling, because showing was fused to banking: any single disagreeing vote
         - a head-turn, a shrug, a flickering light moving the skin ratio - stopped the
         shopper's video even though no flip was coming. The MP4 export was smooth
         throughout, which is the tell: the recorder samples #aiVideo UNDERNEATH this
         overlay, so the stream was never the problem, only what was drawn over it.

         yawCorroborates is the same 45-degree torso swing ORIENT_CORROBORATED_FRAMES
         already trusts to shorten the flip bar - a genuinely 3D reading off MediaPipe's
         shoulder landmarks, on a different instrument from the vote. A head-turn moves
         the head, not the shoulders, and earns nothing here. Note this only gates the
         DISPLAY: the flip bar, the hysteresis and the banked frame are all untouched.

         ABSTAINS TOWARD THE OLD BEHAVIOUR, which is what keeps this from being a
         regression on the devices that need the cover most. `yawUsable` is false with no
         pose detector, an occluded torso, a phone that never loaded the WASM runtime, or
         no peak banked yet this turn - and in every one of those cases we
         cannot tell a real turn from a head-turn, so we cover exactly as before. The
         freeze is only skipped where yaw is present AND positively says no torso
         rotation is happening. And a swap that confirms anyway still promotes at its own
         call site below, so the reference-replacement window is never left uncovered. */
      const yawUsable = turnYaw.usable;
      if (!yawUsable) act({ do: "holdPromote", reason: "no-yaw-signal" });
      else if (yawCorroborates) act({ do: "holdPromote", reason: "turn-corroborated" });
    }
    /* The shopper turned back / straightened up before the flip confirmed: no swap is
       coming, so drop the hold now rather than sitting on a still until the ceiling. */
    else act({ do: "holdEndIfActive", reason: "turn-abandoned" });

    /* THE EARLY TURN TRIGGER (on by default, see ORIENT_EARLY_TURN_DEG) - `earlyTurn` is null with
       ?early_turn=0 and this block does nothing. Only when no vote-confirmed or predictive swap is due.
       HANDLED HERE AND IT ENDS THE TICK, ahead of the pose/re-anchor updates below: they take the
       `applying` mutex in this very tick, and maybeSwap() would find it held and drop the dispatch -
       the reason predictive BACK stands aside from them too. */
    const earlyAct = earlyTurn && dualView && !acquiring && !confirmed && !predictBack
      ? earlyTurn.observe({ vote, lock: s.lock, yawAbs: yawFresh ? s.yawAbs : null, at: yawFresh ? s.yawAt : null,
          lostAt: s.lostAt })
      : null;
    if (earlyAct && earlyAct.fire) {
      /* The pre-turn streak must not count against the early side - predictive BACK's reason. */
      lastVote = null; streak = 0; faceStreak = 0; poseStreak = 0; poseSide = null;
      if (ORIENT_DEBUG) {
        const yawTxt = s.yawAbs === null ? "n/a" : `${s.yawAbs.toFixed(0)}°`;
        const how = earlyAct.via === "lost"
          ? `torso lost at the side view after |yaw| ${yawTxt} rising at ${earlyTurn.speed.toFixed(0)}°/s (?early_turn_loss=${ORIENT_EARLY_TURN_LOSS_DEG})`
          : `|yaw| ${yawTxt} crossed ${s.lock === "back" ? "?early_turn_return=" + ORIENT_EARLY_TURN_RETURN_DEG : "?early_turn=" + ORIENT_EARLY_TURN_DEG}° ` +
            `${earlyAct.via === "slow" ? "on the slow path" : `rising at ${earlyTurn.speed.toFixed(0)}°/s`}`;
        log(`[PEAR][ORIENT] fold handshake: ${how} from a settled ${String(s.lock).toUpperCase()} - ` +
          `sending ${earlyAct.fire.toUpperCase()} at the side view, ahead of any vote`);
      }
      act({ do: "swap", next: earlyAct.fire, predictive: earlyAct.fire === "back" });   // an early BACK is withdrawable like a predictive one
      return acts;
    }
    if (earlyAct && earlyAct.withdraw) {
      if (ORIENT_DEBUG) {
        log(`[PEAR][ORIENT] early turn WITHDRAWN: ${earlyAct.withdraw.toUpperCase()} votes came back under ` +
          `${ORIENT_EARLY_TURN_DEG}° before any vote confirmed the turn - restoring ${earlyAct.withdraw.toUpperCase()}`);
      }
      /* The cooldown is anti-flap. Withdrawing an early swap no vote ever confirmed is the one flap that
         must not wait for it - the FRONT direction already skips it (lastSwapPredictive); this gives
         BACK the same. Bounded: the trigger has to re-arm square on this side, and its next fire still
         meets the cooldown this withdrawal starts. */
      if (earlyAct.withdraw === "back") act({ do: "resetSwapCooldown" });
      act({ do: "swap", next: earlyAct.withdraw, predictive: false });
      return acts;
    }

    /* The pose axis, updated every tick. Skipped when a DUAL-VIEW swap is confirmed and
       about to run: maybeSwap() re-applies the entire payload, which picks up whatever
       autoProfile is by then anyway, so firing a second set() alongside it would be pure
       redundancy inside the exact window the flicker fix works to keep quiet.

       `confirmed` alone is NOT that signal for a single-view item: `acquiring` is
       `autoOrientation === null`, and for single-view sessions autoOrientation never
       leaves null (maybeSwap - the only place that ever sets it - is a no-op for them),
       so `confirmed` can go permanently true the moment the front/back vote settles,
       with no swap ever actually pending behind it. Gating on `dualView` too is what
       keeps this axis running for the entire life of a single-view session instead of
       going silent the moment the shopper is first read as "front". */
    /* NOT AWAITED - these run in the background, and the tick moves on. Both end in
       applyActive(), which can take a network round-trip; awaiting them here held
       `sampling` true for that whole time, so the NEXT orientation sample was skipped
       and the watcher's effective rate dropped from 250ms to however long Decart took
       to answer. That never froze #aiVideo (the video is composited independently of
       this timer), but it did make the orientation signal go stale during exactly the
       movement it is meant to be tracking - the turn - which is a slower, quieter
       version of the same complaint.

       Safe without the await because the mutex is INSIDE them, not here:
       maybeUpdateProfile() and maybeReanchorPrompt() both check and set the shared
       `applying` flag before doing anything, so two overlapping ticks still cannot
       produce two concurrent applies. What is lost is only the tick's knowledge of when
       they finished, which nothing below uses. maybeSwap() stays awaited - it owns the
       hold's lifecycle and the tick must not run ahead of it.
       A PREDICTIVE swap stands in exactly the same place: the re-anchor would otherwise take
       the `applying` mutex first in this very tick, and maybeSwap() would find it held and
       drop the prediction. */
    if (!(dualView && (confirmed || predictBack))) {
      act({ do: "profile", next: profileNext(s.profileScore, s.profile) });
      /* Same redundancy argument as maybeUpdateProfile()'s skip above: a pending
         dual-view swap is about to re-apply the whole payload anyway. Called AFTER
         maybeUpdateProfile(), not instead of it - a fresh transition this very tick
         already stamps lastReanchorAt itself (see that function's comment), so
         back-to-back calls here never double-fire for the same transition.
         NOT gated on pose: the drift this counters is pose-independent, so a shopper
         standing still square-on needs it exactly as much as one holding a profile -
         see REANCHOR_MS's comment. */
      act({ do: "reanchor" });
    }

    /* A BACK confirmed on the side-view pass alone (see ORIENT_POSE_PASS) goes out at the stage of the
       turn a predictive BACK does, so it is sent as one: a return to FRONT withdraws it inside the
       cooldown instead of leaving it on the chest. Every other confirmed flip is sent as before. */
    if (dualView && confirmed && early && lastVote === "back") act({ do: "swap", next: "back", predictive: true });
    else if (dualView && confirmed) act({ do: "swap", next: lastVote, predictive: false });
    else if (predictBack) {
      /* THE PRE-TURN STREAK MUST NOT OUTLIVE THE PREDICTION. lastVote is still the "front"
         the shopper was voting before they turned (abstentions never clear it), and faceStreak
         may already sit past ORIENT_FACE_RETURN_FRAMES - against a BACK lock that is a
         ready-made face return, and the very next tick would withdraw the prediction on
         evidence that predates it. Cleared first, so only votes cast AFTER the dispatch count. */
      lastVote = null; streak = 0; faceStreak = 0; poseStreak = 0; poseSide = null;
      if (ORIENT_DEBUG) {
        log(`[PEAR][ORIENT] predictive BACK: passed the side view ` +
          `(${yawWindow.edgeLost ? "torso lost at edge-on" : "peak " + yawWindow.peak.toFixed(0) + "°"}, ` +
          `now ${s.yawAbs.toFixed(0)}°, ${s.t - yawWindow.edgeAt}ms since edge-on, no face since the turn began)`);
      }
      act({ do: "swap", next: "back", predictive: true });
    }
    return acts;
  }

  /* What used to be the watcher's "FOLD HANDSHAKE ON" console line - the knobs in force. */
  function armLine() {
    if (!earlyTurn) return "[PEAR] AI Auto - fold handshake OFF (?early_turn=0)";
    return `[PEAR] AI Auto - FOLD HANDSHAKE (early turn trigger) ON at ${ORIENT_EARLY_TURN_DEG}°, ` +
      `return ${ORIENT_EARLY_TURN_RETURN_DEG}°, slow ${ORIENT_EARLY_TURN_SLOW_DEG}°, loss ${ORIENT_EARLY_TURN_LOSS_DEG}°, ` +
      `gate ${ORIENT_EARLY_TURN_MIN_SPEED}°/s`;
  }

  return {
    step,
    armLine,
    /* For the suites that pin the moved helpers directly (turn-yaw-window and friends). */
    internals: {
      makeTurnYawWindow, orientFlipDecision, orientPredictBack, orientPredictBackReason, makeEarlyTurnTrigger, profileNext,
      ORIENT_LOCK_FRAMES, ORIENT_LOCK_MS, ORIENT_ACQUIRE_FRAMES, ORIENT_CORROBORATED_FRAMES, ORIENT_FACE_RETURN_FRAMES,
      ORIENT_POSE_FLIP_FRAMES, ORIENT_POSE_PASS, ORIENT_POST_PEAK, ORIENT_EARLY_TURN_DEG, ORIENT_EARLY_TURN_RETURN_DEG,
      ORIENT_EARLY_TURN_MIN_SPEED, ORIENT_EARLY_TURN_DEFAULT_SPEED, ORIENT_EARLY_TURN_SLOW_DEG, ORIENT_EARLY_TURN_LOSS_DEG,
      ORIENT_EDGE_ON_DEG, ORIENT_PREDICT_DESCENT_DEG, ORIENT_PREDICT_DWELL_MS, ORIENT_PREDICTIVE_BACK, ORIENT_YAW_TURN_DEG,
      ORIENT_POST_PEAK_RISE_DEG, ORIENT_PROFILE_ENTER, ORIENT_PROFILE_WINDOW, ORIENT_PROFILE_ENTER_SCORE,
      ORIENT_PROFILE_FAST_SCORE, ORIENT_PROFILE_FAST_FRAMES, ORIENT_PROFILE_EXIT, ORIENT_PROFILE_EXIT_SCORE,
      ORIENT_YAW_FRESH_MS, PRESENCE_PROMPT_YAW_SUPPRESS_DEG,
    },
  };
}

/* ── THE WIRE ──────────────────────────────────────────────────────────────────
   A sample is shopper-controlled: every field is coerced to the type the tick reads,
   and anything else takes the value that means "no evidence" (an abstaining vote, no
   yaw, no lock). The debug facts are passed through only when the connection may debug. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const side = (v) => (v === "front" || v === "back" ? v : null);
const short = (v) => (typeof v === "string" ? v.slice(0, 200) : undefined);
export function sanitizeOrientSample(raw, { debug = false } = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const s = {
    t: num(o.t) ?? 0,
    vote: side(o.vote),
    faceSeen: o.faceSeen === true,
    poseVoted: o.poseVoted === true,
    profileScore: num(o.profileScore) ?? 0,
    yawAbs: num(o.yawAbs),
    yawAt: num(o.yawAt) ?? 0,
    lostAt: num(o.lostAt) ?? 0,
    lock: side(o.lock),
    profile: o.profile === true,
    dualView: o.dualView === true,
  };
  if (debug && o.dbg && typeof o.dbg === "object") {
    s.dbg = { state: short(o.dbg.state), confidence: short(o.dbg.confidence), ratio: short(o.dbg.ratio), narrow: short(o.dbg.narrow) };
  }
  return s;
}

/** The knob object the browser sent, reduced to ORIENT_KNOB_KEYS with string values. */
export function sanitizeOrientKnobs(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of ORIENT_KNOB_KEYS) if (typeof raw[k] === "string") out[k] = raw[k].slice(0, 16);
  return out;
}
