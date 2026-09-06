/**
 * builder.js — a NAND-only structural netlist builder.
 *
 * There is exactly one primitive here: nand(a, b). Everything else in this
 * directory — the ALU, the register file, the whole ST-8 — is composed from
 * it, which is why the gate count the build reports is the honest cost of the
 * design and not an estimate.
 *
 * TOPOLOGICAL ORDER IS FREE. A gate can only name nets that already exist,
 * because a net only exists once some earlier call returned it. Emitting in
 * call order therefore emits in dependency order, and the separate sorting
 * pass a synthesised netlist needs simply does not arise. That property is
 * what lets the EVM walk the table in one pass, and it is the reason this
 * approach is worth the work.
 *
 * Flip-flops are declared before the combinational cone is built, because the
 * cone reads their Q. Their D is attached afterwards, once there is something
 * to attach. A flop nobody drives holds its value, which is the right default
 * for a register.
 */

"use strict";

function Builder() {
  /** Flat triples a, b, y — the shape machine.js walks. */
  this.gates = [];
  /** Which block created each gate, so survivors can be attributed later. */
  this.owner = [];
  this.block = "?";
  this.n = 0;
  /** Net 0 is always 0. Net 1 is always 1 and no gate ever drives it. */
  this.ZERO = this.net();
  this.ONE = this.net();
  this.flopQ = [];
  this.flopD = [];
}

Builder.prototype.net = function () {
  return this.n++;
};

/** `width` fresh nets, index 0 being the least significant bit throughout. */
Builder.prototype.bus = function (width) {
  var out = [];
  for (var i = 0; i < width; i++) out.push(this.net());
  return out;
};

Builder.prototype.nand = function (a, b) {
  var y = this.net();
  this.gates.push(a, b, y);
  this.owner.push(this.block);
  return y;
};

/* --------------------------------------------------------- derived logic */

Builder.prototype.not = function (a) { return this.nand(a, a); };
Builder.prototype.and = function (a, b) { return this.not(this.nand(a, b)); };
Builder.prototype.or = function (a, b) { return this.nand(this.not(a), this.not(b)); };
Builder.prototype.nor = function (a, b) { return this.not(this.or(a, b)); };

Builder.prototype.xor = function (a, b) {
  var t = this.nand(a, b);
  return this.nand(this.nand(a, t), this.nand(b, t));
};

/**
 * s ? b : a. Takes the inverted select so a caller muxing a whole bus pays
 * for the inverter once instead of once per bit.
 */
Builder.prototype.mux = function (a, b, s, ns) {
  if (ns === undefined) ns = this.not(s);
  return this.nand(this.nand(a, ns), this.nand(b, s));
};

/** Bus-wide mux, sharing the one inverter across every bit. */
Builder.prototype.muxBus = function (A, B, s) {
  var ns = this.not(s);
  var out = [];
  for (var i = 0; i < A.length; i++) out.push(this.mux(A[i], B[i], s, ns));
  return out;
};

/** OR of a list, as a balanced tree so depth stays logarithmic. */
Builder.prototype.orAll = function (list) {
  if (!list.length) return this.ZERO;
  var lvl = list.slice();
  while (lvl.length > 1) {
    var next = [];
    for (var i = 0; i < lvl.length; i += 2) {
      next.push(i + 1 < lvl.length ? this.or(lvl[i], lvl[i + 1]) : lvl[i]);
    }
    lvl = next;
  }
  return lvl[0];
};

Builder.prototype.andAll = function (list) {
  if (!list.length) return this.ONE;
  var lvl = list.slice();
  while (lvl.length > 1) {
    var next = [];
    for (var i = 0; i < lvl.length; i += 2) {
      next.push(i + 1 < lvl.length ? this.and(lvl[i], lvl[i + 1]) : lvl[i]);
    }
    lvl = next;
  }
  return lvl[0];
};

/**
 * One-hot select: OR over i of (srcs[i] AND sels[i]).
 *
 * Built as NOT(AND of NAND(src, sel)) rather than as an OR of ANDs, which is
 * the same function for one input less gate per source — De Morgan paying for
 * itself. With no select asserted the result is 0, and several places below
 * rely on that: an instruction that writes nothing simply selects nothing.
 */
Builder.prototype.mux1hot = function (srcs, sels) {
  var t = [];
  for (var i = 0; i < srcs.length; i++) t.push(this.nand(srcs[i], sels[i]));
  return this.nandAll(t);
};

/**
 * NOT(AND of the list), with the inversion folded into the root gate instead
 * of hung off it. An AND is a NAND plus an inverter, so ending the tree on a
 * bare NAND is two gates cheaper than building the AND and then negating it.
 */
Builder.prototype.nandAll = function (list) {
  if (list.length === 0) return this.ZERO;
  if (list.length === 1) return this.not(list[0]);
  var half = Math.ceil(list.length / 2);
  return this.nand(this.andAll(list.slice(0, half)), this.andAll(list.slice(half)));
};

/**
 * A binary mux tree driven straight from the select bits, with no decoder in
 * front of it. Cheaper than a one-hot mux wherever the one-hot vector is not
 * already needed for something else: the read port for rs is the case here,
 * because nothing but that read ever asks which register rs names.
 */
Builder.prototype.muxTree = function (srcs, sel) {
  var lvl = srcs;
  for (var k = 0; k < sel.length; k++) {
    // Recomputed per level and per bit; the optimiser shares them back.
    var ns = this.not(sel[k]);
    var next = [];
    for (var i = 0; i < lvl.length; i += 2) {
      next.push(this.mux(lvl[i], lvl[i + 1], sel[k], ns));
    }
    lvl = next;
  }
  return lvl[0];
};

/** Bus-wide one-hot mux: `srcs` is a list of buses, all the same width. */
Builder.prototype.mux1hotBus = function (srcs, sels, width) {
  var out = [];
  for (var b = 0; b < width; b++) {
    var col = [];
    for (var i = 0; i < srcs.length; i++) col.push(srcs[i][b]);
    out.push(this.mux1hot(col, sels));
  }
  return out;
};

/**
 * bits → 2^n one-hot lines, line k asserted when the bits read k with
 * bits[0] as the least significant. Built as a tree: each level doubles the
 * line count, so the cost is 2^n ANDs rather than n gates per line.
 */
Builder.prototype.decode = function (bits) {
  var lines = [this.not(bits[0]), bits[0]];
  for (var k = 1; k < bits.length; k++) {
    var s = bits[k];
    var ns = this.not(s);
    var next = new Array(lines.length * 2);
    for (var i = 0; i < lines.length; i++) {
      next[i] = this.and(lines[i], ns);
      next[i + lines.length] = this.and(lines[i], s);
    }
    lines = next;
  }
  return lines;
};

/* ---------------------------------------------------------- full adder */

/** One bit of addition. Returns the sum bit and the carry out. */
Builder.prototype.fullAdder = function (a, b, cin) {
  var s1 = this.xor(a, b);
  var sum = this.xor(s1, cin);
  var cout = this.or(this.and(a, b), this.and(s1, cin));
  return { sum: sum, cout: cout };
};

/** Ripple-carry adder, little-endian. */
Builder.prototype.adder = function (A, B, cin) {
  var sum = [];
  var c = cin;
  for (var i = 0; i < A.length; i++) {
    var r = this.fullAdder(A[i], B[i], c);
    sum.push(r.sum);
    c = r.cout;
  }
  return { sum: sum, cout: c };
};

/** Add one. Cheaper than a general adder: the constant folds the logic away. */
Builder.prototype.increment = function (A) {
  var out = [];
  var c = this.ONE;
  for (var i = 0; i < A.length; i++) {
    out.push(this.xor(A[i], c));
    c = i === A.length - 1 ? c : this.and(A[i], c);
  }
  return out;
};

/* ------------------------------------------------------------ registers */

/**
 * Declare `width` flip-flops. Q exists immediately so the combinational cone
 * can read it; D is attached later with .drive(). Left undriven, a flop holds.
 */
Builder.prototype.flops = function (width) {
  var self = this;
  var q = [];
  var idx = [];
  for (var i = 0; i < width; i++) {
    idx.push(this.flopQ.length);
    var qn = this.net();
    this.flopQ.push(qn);
    this.flopD.push(null);
    q.push(qn);
  }
  return {
    q: q,
    idx: idx,
    drive: function (d) {
      if (d.length !== idx.length) throw new Error("drive width mismatch");
      for (var i = 0; i < idx.length; i++) self.flopD[idx[i]] = d[i];
    },
  };
};

/** Every flop that was never driven holds its own Q. */
Builder.prototype.sealFlops = function () {
  for (var i = 0; i < this.flopD.length; i++) {
    if (this.flopD[i] === null) this.flopD[i] = this.flopQ[i];
  }
};

Builder.prototype.gateCount = function () { return this.gates.length / 3; };

/**
 * The flat [d, q, d, q, ...] pairs machine.js indexes by flop number.
 * Call only after sealFlops().
 */
Builder.prototype.flopPairs = function () {
  var out = [];
  for (var i = 0; i < this.flopQ.length; i++) out.push(this.flopD[i], this.flopQ[i]);
  return out;
};

module.exports = { Builder: Builder };
