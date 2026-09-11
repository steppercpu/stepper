/**
 * machine.js — the ST-8 netlist, evaluated.
 *
 * This is the processor as a library: load the gate table, drive the inputs,
 * evaluate every gate in topological order, latch every flip-flop at once.
 * Nothing here prints, exits, or reads an argument.
 *
 * It lives on its own rather than inside the runner because three things need
 * it now — the terminal runner, the published CLI and the SDK — and a
 * processor that exists in three copies is three processors. Only one of them
 * would be the one `npm run silicon` verified.
 */

"use strict";

var fs = require("node:fs");
var path = require("node:path");

/**
 * st8-data.js is written for a browser, so it assigns to `window`. Handing it
 * an object called window is the whole of the port.
 *
 * It is looked for in every place this file is ever installed: under public/
 * in the repository, and beside lib/ in a published package. Searching costs
 * one stat per candidate and saves keeping a second loader in step.
 */
function loadNetlist() {
  var places = [
    path.join(__dirname, "..", "..", "public", "scripts", "st8-data.js"),
    path.join(__dirname, "..", "st8-data.js"),
    path.join(__dirname, "st8-data.js"),
  ];
  var file = places.filter(function (p) { return fs.existsSync(p); })[0];
  if (!file) {
    throw new Error("st8-data.js is missing. Run `npm run silicon` first.");
  }
  var win = {};
  new Function("window", fs.readFileSync(file, "utf8"))(win);
  return win.ST8_DATA;
}
/* ------------------------------------------------------------- the machine
 *
 * Identical in behaviour to public/scripts/machine.js: drive the inputs,
 * evaluate every gate in the order the topological sort fixed, then latch
 * every flip-flop at once. Kept as a separate copy on purpose: if the two
 * ever disagree, one of them is wrong, and `npm run silicon` checks them
 * against a third independent model on every build.
 */

function Machine(D, rom) {
  this.D = D;
  this.rom = rom;
  this.v = new Uint8Array(D.nets);
  this.next = new Uint8Array(D.flopCount);
  this.ram = new Uint8Array(256);
  this.inPort = 0;
  this.cycle = 0;
  this.switched = 0;
  this.v[D.one] = 1;
}

Machine.prototype.flop = function (i) { return this.v[this.D.flops[2 * i + 1]]; };
Machine.prototype.field = function (bits) {
  let n = 0;
  for (let i = 0; i < bits.length; i++) n |= this.flop(bits[i]) << i;
  return n;
};
Machine.prototype.pc = function () { return this.field(this.D.pc); };
Machine.prototype.out = function () { return this.field(this.D.out); };
Machine.prototype.reg = function (r) { return this.field(this.D.regs[r]); };
Machine.prototype.carry = function () { return this.flop(this.D.cf); };
Machine.prototype.zero = function () { return this.flop(this.D.zf); };
Machine.prototype.halted = function () { return this.flop(this.D.halt) === 1; };

Machine.prototype.step = function () {
  const D = this.D, v = this.v;
  const word = this.rom[this.pc()] || 0;
  let i;

  for (i = 0; i < 25; i++) v[D.instr[i]] = (word >> i) & 1;
  for (i = 0; i < 8; i++) v[D.inPort[i]] = (this.inPort >> i) & 1;

  // The address is the one latched on the previous edge, which is exactly why
  // a load costs two honest cycles.
  const addr = this.field(D.ramAddr);
  const rdata = this.ram[addr];
  for (i = 0; i < 8; i++) v[D.ramRdata[i]] = (rdata >> i) & 1;

  const g = D.gates;
  let flipped = 0;
  for (let j = 0; j < g.length; j += 3) {
    const y = g[j + 2];
    const val = 1 - (v[g[j]] & v[g[j + 1]]);
    if (v[y] !== val) { v[y] = val; flipped++; }
  }
  this.switched = flipped;

  const f = D.flops, nx = this.next;
  for (i = 0; i < D.flopCount; i++) nx[i] = v[f[2 * i]];
  for (i = 0; i < D.flopCount; i++) v[f[2 * i + 1]] = nx[i];

  if (this.flop(D.ramWe) === 1) {
    this.ram[this.field(D.ramAddr)] = this.field(D.ramWdata);
  }

  this.cycle++;
  return word;
};

/* ----------------------------------------------------------- the assembler
 *
 * The node assembler already exists for the build. Reusing it here means the
 * terminal and the browser workbench cannot accept different source.
 */

module.exports = { Machine: Machine, loadNetlist: loadNetlist };
