/**
 * optimise.js — make the die smaller without changing what it computes.
 *
 * WHY THIS IS THE UPGRADE THAT MATTERS. On chain, a gate is not free: the
 * contract walks the whole table every step, so gas per cycle scales with the
 * gate count almost exactly. Fewer gates is not a tidiness exercise — it is
 * the difference between a chip the market keeps alive and one that stalls,
 * because a step only happens when someone thinks it is worth the gas.
 *
 * A structural build is honest but naive: writing `or(a, b)` twice emits the
 * inverters twice, and a decoder produces lines nobody asks for. A synthesiser
 * would clean that up. We do not have one, so this is ours.
 *
 * FOUR REWRITES, all local, all semantics-preserving:
 *
 *   constant folding    NAND(x, 0) is always 1. NAND(1, 1) is 0. NAND(1, x)
 *                       is NOT x, and is rewritten as NAND(x, x) so it can
 *                       then be shared with every other NOT of x.
 *   common subexpression  NAND is commutative, so (a,b) and (b,a) are the
 *                       same gate. The first one wins and the rest become
 *                       references to it.
 *   double negation     NOT(NOT(x)) is x. Every `and()` is a NAND followed by
 *                       an inverter, so these pile up wherever ANDs feed ORs.
 *   dead gate removal   anything no flip-flop's D depends on, transitively,
 *                       is computed for nobody. The unused lines of the 5-to-32
 *                       opcode decoder live here: there are 29 instructions.
 *
 * One forward pass reaches a fixpoint for the first three, because gates
 * arrive in topological order and each is rewritten against inputs that were
 * already rewritten. Dead code is then one backward pass.
 *
 * NOTHING HERE IS TRUSTED. The optimised netlist is what gets verified and
 * what ships; the unoptimised one is never written to disk. If a rewrite is
 * wrong, the 1,052,672-vector sweep and the differential run say so and the
 * build refuses to emit.
 */

"use strict";

/**
 * @param {object} input
 *   gates      flat triples from the Builder
 *   n          how many nets the Builder allocated
 *   ZERO, ONE  the constant nets
 *   primaries  nets that must survive: constants, inputs, every flip-flop Q
 *   roots      nets whose value is actually needed: every flip-flop D
 * @returns { gates, nets, resolve, stats }
 *   resolve(oldNet) gives the net that carries the same value afterwards.
 */
function optimise(input) {
  var gates = input.gates;
  var n = input.n;
  var ZERO = input.ZERO;
  var ONE = input.ONE;

  var sub = new Int32Array(n).fill(-1);
  var i;
  for (i = 0; i < input.primaries.length; i++) {
    sub[input.primaries[i]] = input.primaries[i];
  }

  var seen = new Map();     // "lo:hi" → the net that already computes it
  var notOf = new Map();    // an inverter's output → what it inverts
  var kept = [];
  var keptOwner = [];       // which block placed each survivor
  var owner = input.owner || [];
  var stats = { start: gates.length / 3, fold: 0, cse: 0, doubleNeg: 0,
                contradiction: 0, dead: 0 };

  for (i = 0; i < gates.length; i += 3) {
    var a = sub[gates[i]];
    var b = sub[gates[i + 1]];
    var y = gates[i + 2];

    if (a < 0 || b < 0) {
      throw new Error("gate " + (i / 3) + " reads a net that was never defined");
    }

    // A zero input pins the output high, whatever the other input does.
    if (a === ZERO || b === ZERO) { sub[y] = ONE; stats.fold++; continue; }
    if (a === ONE && b === ONE) { sub[y] = ZERO; stats.fold++; continue; }
    // NAND(1, x) is NOT x. Written as NAND(x, x), it joins the pool of
    // inverters and the next NOT of x costs nothing.
    if (a === ONE) { a = b; stats.fold++; }
    else if (b === ONE) { b = a; stats.fold++; }

    if (a === b && notOf.has(a)) { sub[y] = notOf.get(a); stats.doubleNeg++; continue; }

    // A signal NANDed with its own inverse is always 1. Muxes on mutually
    // exclusive selects throw these off constantly.
    if (a !== b && (notOf.get(a) === b || notOf.get(b) === a)) {
      sub[y] = ONE; stats.contradiction++; continue;
    }

    var key = a < b ? a + ":" + b : b + ":" + a;
    var hit = seen.get(key);
    if (hit !== undefined) { sub[y] = hit; stats.cse++; continue; }

    sub[y] = y;
    seen.set(key, y);
    kept.push(a, b, y);
    keptOwner.push(owner[i / 3]);
    if (a === b) notOf.set(y, a);
  }

  /* ------------------------------------------------------ dead gate removal */

  var need = new Uint8Array(n);
  for (i = 0; i < input.roots.length; i++) {
    var r = sub[input.roots[i]];
    if (r >= 0) need[r] = 1;
  }
  // Backwards, so a gate is visited after everything that could want it.
  for (i = kept.length - 3; i >= 0; i -= 3) {
    if (!need[kept[i + 2]]) continue;
    need[kept[i]] = 1;
    need[kept[i + 1]] = 1;
  }
  var live = [];
  var liveOwner = [];
  var byBlock = {};
  for (i = 0; i < kept.length; i += 3) {
    if (!need[kept[i + 2]]) continue;
    live.push(kept[i], kept[i + 1], kept[i + 2]);
    var who = keptOwner[i / 3] || "?";
    liveOwner.push(who);
    byBlock[who] = (byBlock[who] || 0) + 1;
  }
  stats.dead = (kept.length - live.length) / 3;
  stats.byBlock = byBlock;

  /* ----------------------------------------------------------- renumbering
   * Constants first so they keep the low indices, then the primaries, then
   * the surviving gates in the order they were emitted. Because a gate only
   * ever names constants, primaries or earlier gates, sequential numbering
   * preserves the topological order the interpreter depends on. */

  var map = new Int32Array(n).fill(-1);
  var next = 0;
  map[ZERO] = next++;
  map[ONE] = next++;
  for (i = 0; i < input.primaries.length; i++) {
    if (map[input.primaries[i]] < 0) map[input.primaries[i]] = next++;
  }
  for (i = 0; i < live.length; i += 3) map[live[i + 2]] = next++;

  var out = [];
  for (i = 0; i < live.length; i += 3) {
    out.push(map[live[i]], map[live[i + 1]], map[live[i + 2]]);
  }

  stats.end = out.length / 3;
  stats.saved = stats.start - stats.end;
  stats.percent = ((stats.saved / stats.start) * 100).toFixed(1);

  return {
    gates: out,
    nets: next,
    zero: map[ZERO],
    one: map[ONE],
    resolve: function (oldNet) {
      var s = sub[oldNet];
      if (s < 0) throw new Error("net " + oldNet + " has no value after optimisation");
      var m = map[s];
      if (m < 0) throw new Error("net " + oldNet + " was removed as dead but is exported");
      return m;
    },
    stats: stats,
    owners: liveOwner,
  };
}

module.exports = { optimise: optimise };
