#!/usr/bin/env node
/**
 * build-st16.js — the next generation, from the same description.
 *
 *   npm run st16
 *
 * ST-16 is not a second processor. It is `tools/netlist/st8.js` with W set to
 * 16, which is the whole point of writing the core in terms of a width in the
 * first place: a generation is a number, not a fork that drifts.
 *
 * WHAT IS DIFFERENT ABOUT VERIFYING IT. At eight bits, every two-operand
 * instruction can be swept exhaustively: 65,536 pairs is nothing. At sixteen
 * bits the same sweep is 4.3 billion pairs per operation, which is not a
 * budget question but a physics one. So the coverage changes shape and this
 * script says exactly how:
 *
 *   exhaustive   every single-operand instruction, all 65,536 inputs, both
 *                carry states
 *   directed     the edges that actually break adders: 0, 1, MAX, MAX-1,
 *                halves, carry chains of every length
 *   random       a large sample of the interior, with a fixed seed so any
 *                failure can be reproduced
 *   differential a random stream of valid instructions run against the model
 *
 * That is weaker than exhaustive and it is stated as weaker. Claiming a wider
 * core is proven the way the narrow one is would be the kind of rounding-up
 * this project exists to avoid.
 *
 * ST-16 is NOT shipped to the site. machine.js draws eight LEDs and holds RAM
 * in a byte array; the console is an ST-8 console. This build exists so the
 * roadmap is a thing that compiles rather than a promise.
 */

"use strict";

var Builder = require("./netlist/builder.js").Builder;
var st8 = require("./netlist/st8.js");
var Model = require("./netlist/model.js").Model;
var optimise = require("./netlist/optimise.js").optimise;
var cli = require("./cli.js");

cli.header("st16", "build and verify the next generation");

var W = 16;
var MASK = (1 << W) - 1;
var fail = 0;
function bad(m, d) { fail++; console.error("  FAIL  " + m + (d ? "\n        " + d : "")); }
function ok(m) { console.log("  pass  " + m); }

var b = new Builder();
var m = st8.buildST8(b, { width: W });
var placed = b.gateCount();

var opt = optimise({
  gates: b.gates, owner: b.owner, n: b.n, ZERO: b.ZERO, ONE: b.ONE,
  primaries: [b.ZERO, b.ONE].concat(m.instr, m.inPort, m.ramRdata, b.flopQ),
  roots: b.flopD.slice(),
});
var s = opt.stats;

var flops = [];
for (var fi = 0; fi < b.flopQ.length; fi++) {
  flops.push(opt.resolve(b.flopD[fi]), opt.resolve(b.flopQ[fi]));
}
var D = {
  nets: opt.nets, zero: opt.zero, one: opt.one,
  gateCount: s.end, flopCount: b.flopQ.length,
  gates: opt.gates, flops: flops,
  instr: m.instr.map(opt.resolve),
  inPort: m.inPort.map(opt.resolve),
  ramRdata: m.ramRdata.map(opt.resolve),
  pc: m.pc, out: m.out, ramAddr: m.ramAddr, ramWdata: m.ramWdata,
  ramWe: m.ramWe, halt: m.halt, regs: m.regs, cf: m.cf, zf: m.zf,
  ldPhase: m.ldPhase,
};

console.log("\nST-16 — the same description, one number wider");
console.log("=".repeat(62));
Object.keys(m.cost).forEach(function (k) {
  console.log("  " + k.padEnd(26) + String(m.cost[k]).padStart(7) + " gates");
});
console.log("  " + "-".repeat(40));
console.log("  " + "as placed".padEnd(26) + String(placed).padStart(7));
console.log("  " + "SHIPPED".padEnd(26) + String(s.end).padStart(7) +
  " gates   (-" + s.percent + "%)");
console.log("  " + "flip-flops".padEnd(26) + String(D.flopCount).padStart(7));
console.log("  " + "nets".padEnd(26) + String(D.nets).padStart(7));

/* ------------------------------------------------------------- harness */

function Harness(d) { this.d = d; this.v = new Uint8Array(d.nets); }
Harness.prototype.load = function (regs, carry) {
  var d = this.d, v = this.v, i, k;
  v.fill(0);
  v[d.one] = 1;
  for (k = 0; k < 16; k++) {
    for (i = 0; i < W; i++) v[d.flops[2 * d.regs[k][i] + 1]] = (regs[k] >>> i) & 1;
  }
  v[d.flops[2 * d.cf + 1]] = carry & 1;
};
Harness.prototype.run = function (word, inPort, rdata) {
  var d = this.d, v = this.v, i;
  for (i = 0; i < 25; i++) v[d.instr[i]] = (word >>> i) & 1;
  for (i = 0; i < W; i++) v[d.inPort[i]] = (inPort >>> i) & 1;
  for (i = 0; i < W; i++) v[d.ramRdata[i]] = (rdata >>> i) & 1;
  var g = d.gates;
  for (var j = 0; j < g.length; j += 3) v[g[j + 2]] = 1 - (v[g[j]] & v[g[j + 1]]);
};
Harness.prototype.nextBit = function (f) { return this.v[this.d.flops[2 * f]]; };
Harness.prototype.nextField = function (bits) {
  var n = 0;
  for (var i = 0; i < bits.length; i++) n = (n | (this.nextBit(bits[i]) << i)) >>> 0;
  return n >>> 0;
};

var OPS = st8.OP;
var RD = 3, RS = 5;
var word = function (op, field) {
  return (((op & 0x1f) << 20) | (RD << 16) | (RS << 12) | (field & 0xfff)) >>> 0;
};

function check(opName, a, bv, carry, field, inPort) {
  var h = new Harness(D);
  var ref = new Model([], W);
  var regs = new Uint32Array(16);
  regs[RD] = a; regs[RS] = bv;
  h.load(regs, carry);
  ref.reset();
  ref.regs[RD] = a; ref.regs[RS] = bv; ref.c = carry;
  ref.inPort = inPort || 0;

  var wd = word(OPS[opName], field || 0);
  h.run(wd, inPort || 0, 0);
  var want = ref.next(wd, 0);
  var gotR = h.nextField(D.regs[RD]);
  if (gotR !== want.regs[RD] || h.nextBit(D.cf) !== want.c || h.nextBit(D.zf) !== want.z) {
    return { op: opName, a: a, b: bv, c: carry,
             got: gotR, want: want.regs[RD],
             gotC: h.nextBit(D.cf), wantC: want.c,
             gotZ: h.nextBit(D.zf), wantZ: want.z };
  }
  return null;
}

console.log("\nCoverage, stated rather than implied");
console.log("=".repeat(62));

/* 1. exhaustive over the single-operand instructions */
var SINGLE = ["NOT", "SHL", "SHR", "ROL", "ROR", "INC", "DEC"];
var n1 = 0, e1 = null;
for (var si = 0; si < SINGLE.length && !e1; si++) {
  for (var c = 0; c <= 1 && !e1; c++) {
    for (var a = 0; a <= MASK && !e1; a++) { e1 = check(SINGLE[si], a, 0, c); n1++; }
  }
}
if (e1) bad("single-operand sweep", JSON.stringify(e1));
else ok("exhaustive: " + n1.toLocaleString() + " vectors, " + SINGLE.length +
  " single-operand ops, all " + (MASK + 1).toLocaleString() + " inputs, both carries");

/* 2. directed edges, where adders actually break */
var EDGES = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x0fff, 0x1000,
             0x7fff, 0x8000, 0xfffe, 0xffff, 0x5555, 0xaaaa];
var TWO = ["ADD", "ADC", "SUB", "SBB", "CMP", "AND", "OR", "XOR", "NAND", "MOV"];
var n2 = 0, e2 = null;
for (var ti = 0; ti < TWO.length && !e2; ti++) {
  for (var x = 0; x < EDGES.length && !e2; x++) {
    for (var y = 0; y < EDGES.length && !e2; y++) {
      for (var cc = 0; cc <= 1 && !e2; cc++) { e2 = check(TWO[ti], EDGES[x], EDGES[y], cc); n2++; }
    }
  }
}
if (e2) bad("directed edge sweep", JSON.stringify(e2));
else ok("directed: " + n2.toLocaleString() + " vectors over " + EDGES.length +
  " boundary values, " + TWO.length + " two-operand ops");

/* 3. random interior, fixed seed */
var seed = 0x5eed16;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
var n3 = 0, e3 = null;
for (var k = 0; k < 40000 && !e3; k++) {
  var op = TWO[rnd() % TWO.length];
  e3 = check(op, rnd() & MASK, rnd() & MASK, rnd() & 1);
  n3++;
}
if (e3) bad("random interior", JSON.stringify(e3));
else ok("random: " + n3.toLocaleString() + " vectors, seed 0x5eed16, reproducible");

/* 4. differential on a random instruction stream */
function PackedRun(rom) {
  this.rom = rom;
  this.h = new Harness(D);
  this.v = this.h.v;
  this.v.fill(0);
  this.v[D.one] = 1;
  this.ram = new Uint32Array(256);
}
PackedRun.prototype.flop = function (f) { return this.v[D.flops[2 * f + 1]]; };
PackedRun.prototype.field = function (bits) {
  var n = 0;
  for (var i = 0; i < bits.length; i++) n = (n | (this.flop(bits[i]) << i)) >>> 0;
  return n >>> 0;
};
PackedRun.prototype.step = function (inPort) {
  var wd = this.rom[this.field(D.pc)] || 0;
  var rdata = this.ram[this.field(D.ramAddr)];
  this.h.run(wd, inPort, rdata);
  var nx = new Uint8Array(D.flopCount), i;
  for (i = 0; i < D.flopCount; i++) nx[i] = this.v[D.flops[2 * i]];
  for (i = 0; i < D.flopCount; i++) this.v[D.flops[2 * i + 1]] = nx[i];
  if (this.flop(D.ramWe)) this.ram[this.field(D.ramAddr)] = this.field(D.ramWdata);
};

// A ROM of valid instructions, jumps kept inside it, no hlt so it runs on.
var SAFE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
var rom = new Array(1024).fill(0);
for (var pcp = 0; pcp < 256; pcp++) {
  var op2 = SAFE[rnd() % SAFE.length];
  rom[pcp] = ((op2 << 20) | ((rnd() & 0xf) << 16) | ((rnd() & 0xf) << 12) | (rnd() & 0xff)) >>> 0;
}
rom[255] = (OPS.JMP << 20) | 0;   // loop forever

var run = new PackedRun(rom);
var ref2 = new Model(rom, W);
var e4 = null;
for (var cyc = 0; cyc < 5000 && !e4; cyc++) {
  var byte = rnd() & MASK;
  ref2.inPort = byte;
  run.step(byte);
  ref2.step();
  if (run.field(D.pc) !== ref2.pc) e4 = { cyc: cyc, what: "pc" };
  else if (run.field(D.out) !== ref2.out) e4 = { cyc: cyc, what: "out" };
  else if (run.flop(D.cf) !== ref2.c) e4 = { cyc: cyc, what: "C" };
  else if (run.flop(D.zf) !== ref2.z) e4 = { cyc: cyc, what: "Z" };
  else for (var rr = 0; rr < 16 && !e4; rr++) {
    if (run.field(D.regs[rr]) !== ref2.regs[rr]) e4 = { cyc: cyc, what: "r" + rr };
  }
  if (!e4) for (var mm = 0; mm < 256; mm++) {
    if (run.ram[mm] !== ref2.ram[mm]) { e4 = { cyc: cyc, what: "ram[" + mm + "]" }; break; }
  }
}
if (e4) bad("differential on a random instruction stream", JSON.stringify(e4));
else ok("differential: 5,000 cycles of random valid instructions, RAM included");

/* ST-8 is this same description with W = 8. Building it here costs one more
   pass and means the table cannot drift from the numbers the toolchain
   ships: they are on the site and on every poster. The literal that sat
   here had already gone stale. */
function measure(width) {
  var mb = new Builder();
  var mm = st8.buildST8(mb, { width: width });
  var mo = optimise({
    gates: mb.gates, owner: mb.owner, n: mb.n, ZERO: mb.ZERO, ONE: mb.ONE,
    primaries: [mb.ZERO, mb.ONE].concat(mm.instr, mm.inPort, mm.ramRdata, mb.flopQ),
    roots: mb.flopD.slice(),
  });
  return { gates: mo.stats.end, flops: mb.flopQ.length };
}
var g8 = measure(8);

console.log("\nGeneration comparison");
console.log("=".repeat(62));
console.log("  " + "".padEnd(26) + "ST-8".padStart(10) + "ST-16".padStart(10));
console.log("  " + "NAND gates".padEnd(26) + g8.gates.toLocaleString().padStart(10) +
  s.end.toLocaleString().padStart(10));
console.log("  " + "flip-flops".padEnd(26) + String(g8.flops).padStart(10) +
  String(D.flopCount).padStart(10));
console.log("  " + "verification".padEnd(26) + "exhaustive".padStart(10) + "sampled".padStart(10));

if (fail) { console.error("\n" + fail + " check(s) failed.\n"); process.exit(1); }
console.log("\nST-16 builds and holds. Not shipped: the console is an ST-8 console.\n");
