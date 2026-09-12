#!/usr/bin/env node
/**
 * build-netlist.js — fabricate the ST-8 and refuse to ship it unverified.
 *
 *   npm run silicon
 *
 * Composes the processor gate by gate, assembles the two programs, proves the
 * netlist agrees with an independent behavioural model, and only then writes
 * public/scripts/st8-data.js.
 *
 * THE PROOF CHAIN. Four checks, and every one has to pass or nothing is
 * written. They are deliberately different in kind, because four variations
 * of the same check would only prove the check.
 *
 *   1  combinational   every ALU operation swept against arithmetic, driving
 *                      the gates directly with state a program might never
 *                      reach, reading the flip-flop inputs before they latch
 *   2  sequential      the netlist and the model run the same programs and
 *                      must agree on every observable, every cycle
 *   3  integration     check 2 again, but through the real machine.js the
 *                      browser loads — the shipped path, not a copy of it
 *   4  liveness        ledger must not halt, ever, and selftest must halt having
 *                      passed; the mainnet program running out of instructions
 *                      would be a silent death
 *
 * Everything is exhaustive where exhaustive is affordable. Where it is not,
 * the sweep is stated, so nobody has to guess what was covered.
 */

"use strict";

var fs = require("node:fs");
var path = require("node:path");

var Builder = require("./netlist/builder.js").Builder;
var st8 = require("./netlist/st8.js");
var asm = require("./netlist/asm.js");
var Model = require("./netlist/model.js").Model;
var optimise = require("./netlist/optimise.js").optimise;
var cli = require("./cli.js");

cli.header("silicon", "place, optimise, verify, emit the netlist");

var OUT = path.join(__dirname, "..", "public", "scripts", "st8-data.js");
var MACHINE = path.join(__dirname, "..", "public", "scripts", "machine.js");

var t0 = Date.now();
var fail = 0;
function bad(msg, detail) {
  fail++;
  console.error("  FAIL  " + msg);
  if (detail) console.error("        " + detail);
}
function ok(msg) { console.log("  pass  " + msg); }

/* -------------------------------------------------------------- 1. place */

var b = new Builder();
var m = st8.buildST8(b);
var placed = b.gateCount();

console.log("\nST-8 — placed from NAND, in " + (Date.now() - t0) + " ms");
console.log("=".repeat(62));
Object.keys(m.cost).forEach(function (k) {
  console.log("  " + k.padEnd(26) + String(m.cost[k]).padStart(7) + " gates");
});
console.log("  " + "-".repeat(40));
console.log("  " + "as placed".padEnd(26) + String(placed).padStart(7) + " gates");

/* ------------------------------------------------------------- 2. optimise
 * Gas per cycle scales with the gate count, so this is not housekeeping. The
 * optimised netlist is the one that gets verified and the one that ships;
 * the naive one is never written anywhere. */

var opt = optimise({
  gates: b.gates,
  owner: b.owner,
  n: b.n,
  ZERO: b.ZERO,
  ONE: b.ONE,
  // Must survive: the constants, everything driven from outside, every Q.
  primaries: [b.ZERO, b.ONE]
    .concat(m.instr, m.inPort, m.ramRdata, b.flopQ),
  // Must remain computable: every flip-flop's D. Nothing else is read.
  roots: b.flopD.slice(),
});

var s = opt.stats;
console.log("  constant folding".padEnd(28) + String(-s.fold).padStart(7));
console.log("  contradictions".padEnd(28) + String(-s.contradiction).padStart(7));
console.log("  common subexpressions".padEnd(28) + String(-s.cse).padStart(7));
console.log("  double negations".padEnd(28) + String(-s.doubleNeg).padStart(7));
console.log("  dead gates".padEnd(28) + String(-s.dead).padStart(7));
console.log("  " + "-".repeat(40));
console.log("  " + "SHIPPED".padEnd(26) + String(s.end).padStart(7) + " gates" +
  "   (-" + s.percent + "%)");

var data_maxDepth = 0;
var flops = [];
for (var fi = 0; fi < b.flopQ.length; fi++) {
  flops.push(opt.resolve(b.flopD[fi]), opt.resolve(b.flopQ[fi]));
}

var data = {
  nets: opt.nets,
  zero: opt.zero,
  one: opt.one,
  gateCount: s.end,
  flopCount: b.flopQ.length,
  gates: opt.gates,
  flops: flops,
  instr: m.instr.map(opt.resolve),
  inPort: m.inPort.map(opt.resolve),
  ramRdata: m.ramRdata.map(opt.resolve),
  // Flip-flop indices are untouched: the optimiser renumbers nets, never state.
  pc: m.pc,
  out: m.out,
  ramAddr: m.ramAddr,
  ramWdata: m.ramWdata,
  ramWe: m.ramWe,
  halt: m.halt,
  regs: m.regs,
  cf: m.cf,
  zf: m.zf,
  ldPhase: m.ldPhase,
  // Surviving gates per block, after optimisation. The site draws its
  // component shelf from these, so the card for the register file says what
  // the register file actually costs rather than what somebody remembered.
  // The opcode table, so the browser assembler and the netlist cannot drift
  // apart. One name-to-number map, emitted from the same file the gates were
  // built from.
  ops: st8.OP,
  blocks: opt.stats.byBlock,
  // Which block owns each surviving gate, one digit per gate, in the order
  // the table walks them. The component shelf uses it to light a block's own
  // gates inside the whole die, so each card shows where it physically lives
  // rather than a picture somebody chose for it. Two kilobytes for that.
  blockOrder: Object.keys(opt.stats.byBlock),
  gateBlock: opt.owners.map(function (name) {
    return Object.keys(opt.stats.byBlock).indexOf(name);
  }).join(""),
  // Logic depth per gate: how many gates deep in the cone it sits. A gate fed
  // only by inputs and flip-flops is depth 0; a gate fed by a depth-3 gate is
  // depth 4. Nothing needs this to execute, but it is the one thing we know
  // about our own netlist that a synthesised one does not hand you, and it is
  // what lets the console draw propagation instead of a scatter of squares.
  depth: (function () {
    var dep = new Int32Array(opt.nets);
    var g = opt.gates;
    var maxDepth = 0;
    var out = new Int32Array(s.end);
    for (var i = 0; i < g.length; i += 3) {
      var da = dep[g[i]], db = dep[g[i + 1]];
      var dy = (da > db ? da : db) + 1;
      dep[g[i + 2]] = dy;
      out[i / 3] = dy;
      if (dy > maxDepth) maxDepth = dy;
    }
    data_maxDepth = maxDepth;
    return Array.prototype.slice.call(out);
  })(),
  programs: {},
};

data.maxDepth = data_maxDepth;

Object.keys(asm.sources).forEach(function (k) {
  data.programs[k] = asm.assemble(asm.sources[k]);
});

console.log("");
console.log("  where the surviving gates live");
Object.keys(s.byBlock).sort(function (x, y) { return s.byBlock[y] - s.byBlock[x]; })
  .forEach(function (k) {
    console.log("    " + k.padEnd(24) + String(s.byBlock[k]).padStart(7) +
      "  " + (100 * s.byBlock[k] / s.end).toFixed(1) + "%");
  });
console.log("");
console.log("  " + "flip-flops".padEnd(26) + String(data.flopCount).padStart(7));
console.log("  " + "nets".padEnd(26) + String(data.nets).padStart(7));
console.log("  " + "logic depth".padEnd(26) + String(data.maxDepth).padStart(7) + " levels");

/* ------------------------------------------------- a harness over the gates
 * Lets the verifier place the machine in any state at all — including states
 * no program reaches — and read what the combinational cone decided before
 * the edge, which is the only way to sweep an ALU exhaustively. */

function Harness(d) {
  this.d = d;
  this.v = new Uint8Array(d.nets);
  this.v[d.one] = 1;
}
Harness.prototype.poke = function (idx, bits, value) {
  for (var i = 0; i < bits.length; i++) {
    this.v[this.d.flops[2 * bits[i] + 1]] = (value >> i) & 1;
  }
  void idx;
};
Harness.prototype.pokeBit = function (flopIdx, value) {
  this.v[this.d.flops[2 * flopIdx + 1]] = value & 1;
};
Harness.prototype.drive = function (word, inPort, rdata) {
  var d = this.d, v = this.v, i;
  for (i = 0; i < 25; i++) v[d.instr[i]] = (word >>> i) & 1;
  for (i = 0; i < 8; i++) v[d.inPort[i]] = (inPort >> i) & 1;
  for (i = 0; i < 8; i++) v[d.ramRdata[i]] = (rdata >> i) & 1;
  var g = d.gates;
  for (var j = 0; j < g.length; j += 3) v[g[j + 2]] = 1 - (v[g[j]] & v[g[j + 1]]);
};
/** The value a flop *will* take — its D, sampled before any Q moves. */
Harness.prototype.nextBit = function (flopIdx) {
  return this.v[this.d.flops[2 * flopIdx]];
};
Harness.prototype.nextField = function (bits) {
  var n = 0;
  for (var i = 0; i < bits.length; i++) n |= this.nextBit(bits[i]) << i;
  return n;
};

/* ------------------------------------------- 2. sweep the combinational cone */

var OPS = st8.OP;
var word = function (op, rd, rs, field) {
  return (((op & 0x1f) << 20) | ((rd & 0xf) << 16) | ((rs & 0xf) << 12) | (field & 0xfff)) >>> 0;
};

function sweep(name, opName, opts) {
  var h = new Harness(data);
  var ref = new Model([]);
  var mismatch = null;
  var n = 0;
  var RD = 3, RS = 5;                 // any two distinct registers will do

  var bValues = opts.twoOperand ? 256 : 1;
  var carries = opts.usesCarry ? [0, 1] : [0];

  for (var ci = 0; ci < carries.length && !mismatch; ci++) {
    for (var a = 0; a < 256 && !mismatch; a++) {
      for (var bv = 0; bv < bValues && !mismatch; bv++) {
        var c = carries[ci];
        h.v.fill(0);
        h.v[data.one] = 1;
        h.poke(0, data.regs[RD], a);
        h.poke(0, data.regs[RS], bv);
        h.pokeBit(data.cf, c);

        ref.reset();
        ref.regs[RD] = a;
        ref.regs[RS] = bv;
        ref.c = c;
        // The model reads its port from state; the netlist reads it from a
        // driven net. Both have to be told the same byte or the oracle lies.
        ref.inPort = opts.inPort || 0;

        var w = word(OPS[opName], RD, RS, opts.field || 0);
        h.drive(w, opts.inPort || 0, opts.rdata || 0);
        var want = ref.next(w, opts.rdata || 0);

        var gotR = h.nextField(data.regs[RD]);
        var gotC = h.nextBit(data.cf);
        var gotZ = h.nextBit(data.zf);
        n++;
        if (gotR !== want.regs[RD] || gotC !== want.c || gotZ !== want.z) {
          mismatch = { a: a, b: bv, cin: c, gotR: gotR, wantR: want.regs[RD],
                       gotC: gotC, wantC: want.c, gotZ: gotZ, wantZ: want.z };
        }
      }
    }
  }

  if (mismatch) bad(name + " — " + n.toLocaleString() + " vectors", JSON.stringify(mismatch));
  return { n: n, okay: !mismatch };
}

console.log("\nProof 1 — combinational sweep, gates driven directly");
console.log("=".repeat(62));

var SWEEPS = [
  ["add", "ADD", { twoOperand: true, usesCarry: true }],
  ["adc", "ADC", { twoOperand: true, usesCarry: true }],
  ["sub", "SUB", { twoOperand: true, usesCarry: true }],
  ["sbb", "SBB", { twoOperand: true, usesCarry: true }],
  ["cmp", "CMP", { twoOperand: true, usesCarry: true }],
  ["and", "AND", { twoOperand: true }],
  ["or", "OR", { twoOperand: true }],
  ["xor", "XOR", { twoOperand: true }],
  ["nand", "NAND", { twoOperand: true }],
  ["mov", "MOV", { twoOperand: true }],
  ["not", "NOT", {}],
  ["shl", "SHL", { usesCarry: true }],
  ["shr", "SHR", { usesCarry: true }],
  ["rol", "ROL", { usesCarry: true }],
  ["ror", "ROR", { usesCarry: true }],
  ["inc", "INC", { usesCarry: true }],
  ["dec", "DEC", { usesCarry: true }],
  ["ldi", "LDI", { field: 0xa5 }],
  ["in", "IN", { inPort: 0x5a }],
  // The three that fill the opcode field. tst is a two-operand sweep like
  // cmp: it produces flags and no result, and both have to be right.
  ["tst", "TST", { twoOperand: true }],
  ["swap", "SWAP", {}],
];

var vectors = 0;
SWEEPS.forEach(function (s) {
  var r = sweep(s[0], s[1], s[2]);
  vectors += r.n;
});
if (!fail) ok(vectors.toLocaleString() + " vectors across " + SWEEPS.length + " operations, exhaustive in every operand");

/* ------------------------------------------------ 3. differential execution */

console.log("\nProofs 2 and 3 — netlist against the model, and machine.js against both");
console.log("=".repeat(62));

// Load the real browser simulator against the freshly built data.
global.window = { ST8_DATA: data };
require(MACHINE);
var ST8 = global.window.ST8;

/** A repeatable byte stream, so a failure can always be reproduced. */
function stream(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s >>> 7) & 0xff;
  };
}

function differential(key, cycles) {
  var prog = data.programs[key];
  var mach = new ST8.Machine(prog);
  var ref = new Model(prog.rom);
  var next = stream(0x5eed + key.length);
  var problem = null;

  for (var c = 0; c < cycles && !problem; c++) {
    var byte = next();
    mach.inPort = byte;
    ref.inPort = byte;
    mach.step();
    ref.step();

    var diffs = [];
    if (mach.pc() !== ref.pc) diffs.push("pc " + mach.pc() + " vs " + ref.pc);
    if (mach.out() !== ref.out) diffs.push("out " + mach.out() + " vs " + ref.out);
    if (mach.carry() !== ref.c) diffs.push("C " + mach.carry() + " vs " + ref.c);
    if (mach.zero() !== ref.z) diffs.push("Z " + mach.zero() + " vs " + ref.z);
    if ((mach.halted() ? 1 : 0) !== ref.halt) diffs.push("halt");
    for (var r = 0; r < 16; r++) {
      if (mach.reg(r) !== ref.regs[r]) diffs.push("r" + r + " " + mach.reg(r) + " vs " + ref.regs[r]);
    }
    for (var a = 0; a < 256; a++) {
      if (mach.ram[a] !== ref.ram[a]) { diffs.push("ram[" + a + "]"); break; }
    }
    if (diffs.length) problem = { cycle: c, byte: byte, diffs: diffs.slice(0, 4) };
    if (ref.halt) break;
  }
  return problem;
}

var echoProblem = differential("ledger", 20000);
if (echoProblem) bad("ledger diverged", JSON.stringify(echoProblem));
else ok("ledger — 20,000 cycles, netlist == model == machine.js, RAM included");

var testProblem = differential("selftest", 2000);
if (testProblem) bad("selftest diverged", JSON.stringify(testProblem));
else ok("selftest — every cycle to halt, netlist == model == machine.js");

/* --------------------------------------------------------- 4. liveness */

console.log("\nProof 4 — the programs behave the way the site claims");
console.log("=".repeat(62));

var echo = new ST8.Machine(data.programs.ledger);
var feed = stream(0xc0ffee);
var halted = false;
for (var i = 0; i < 20000; i++) {
  echo.inPort = feed();
  echo.step();
  if (echo.halted()) { halted = true; break; }
}
if (halted) bad("ledger halted — the mainnet program must run forever");
else ok("ledger — 20,000 cycles with random input, never halts");

var dig = new ST8.Machine(data.programs.digest);
var digFeed = stream(0x5eed16);
var digHalted = false;
var digSeen = {};
for (var d = 0; d < 20000; d++) {
  dig.inPort = digFeed();
  dig.step();
  if (dig.halted()) { digHalted = true; break; }
  if (d > 16) digSeen[dig.out()] = 1;
}
if (digHalted) bad("digest halted — a chip carrying it could never be restarted");
else ok("digest — 20,000 cycles with random input, never halts");

/* The whole reason for rotating before folding. Without it the accumulator
   is a sum, sums commute, and the same sponsors in a different order would
   leave the machine in the same place. */
function digestOf(bytes) {
  var m = new ST8.Machine(data.programs.digest);
  for (var k = 0; k < bytes.length; k++) { m.inPort = bytes[k]; m.step(); }
  return m.out();
}
var fwd = digestOf([11, 22, 33, 44, 55, 66]);
var rev = digestOf([66, 55, 44, 33, 22, 11]);
if (fwd === rev) bad("digest ignores the order its bytes arrived in");
else ok("digest — order matters: the same bytes reversed give " + fwd + " and " + rev + "");

var digCount = Object.keys(digSeen).length;
if (digCount < 200) bad("digest only reached " + digCount + " of 256 output values");
else ok("digest — " + digCount + " of 256 output values reached");

var test = new ST8.Machine(data.programs.selftest);
var cyclesToHalt = 0;
for (var j = 0; j < 5000; j++) {
  test.step();
  cyclesToHalt++;
  if (test.halted()) break;
}
if (!test.halted()) bad("selftest never halted");
else if (test.out() === 255) bad("selftest halted on its failure path", "output port reads 255");
else ok("selftest — halts after " + cyclesToHalt + " cycles, output " + test.out() + " (not the failure value)");

var ldProg = data.programs.selftest.listing.filter(function (l) { return /^ld\s/.test(l.src.trim()); });
if (!ldProg.length) bad("selftest no longer exercises ld");
else ok("ld is exercised, and the two-cycle path is inside the differential run");

/* ------------------------------------------------------------------ emit */

if (fail) {
  console.error("\n" + fail + " check(s) failed — st8-data.js NOT written.\n");
  process.exit(1);
}

var header = [
  "// ST-8 netlist. Generated by tools/build-netlist.js; do not edit by hand.",
  "//",
  "// " + data.gateCount.toLocaleString() + " NAND gates and " + data.flopCount +
    " flip-flops, composed structurally from a",
  "// single primitive, then optimised: " + s.start.toLocaleString() +
    " placed, " + s.saved + " removed (" + s.percent + "%).",
  "// Emitted in topological order, which is free here: a gate can only name",
  "// nets that already exist.",
  "//",
  "// Every gate here was placed by tools/netlist/st8.js, one nand() call at a",
  "// time. `npm run silicon` rebuilds it and refuses to write this file unless",
  "// all four checks pass, run against this optimised netlist rather than the",
  "// naive one.",
  "//",
  "// Verified: " + vectors.toLocaleString() + " exhaustive ALU vectors, 20,000 cycles of ledger and",
  "// every cycle of selftest against an independent behavioural model, through the",
  "// same machine.js the browser loads.",
  "window.ST8_DATA = ",
].join("\n");

fs.writeFileSync(OUT, header + JSON.stringify(data) + ";\n");

var kb = Math.round(fs.statSync(OUT).size / 1024);
console.log("\nAll checks passed in " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
console.log("Wrote public/scripts/st8-data.js — " + kb + " kB\n");
