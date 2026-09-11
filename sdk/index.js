/**
 * stepper-sdk — the ST-8 processor, as a library.
 *
 *   const stepper = require("stepper-sdk");
 *
 * Four things, and they compose:
 *
 *   assemble()   ST-8 assembly to a ROM
 *   Machine      the 2,161-gate netlist, evaluated one clock edge at a time
 *   readChip()   what a chip on the chain currently says about itself
 *   verify()     replay its whole history and check the chain agrees
 *
 * The netlist in this package is the gate list a synthesis pass produced, not
 * a model of an instruction set. Every cycle is computed by evaluating those
 * gates in topological order and latching every flip-flop at once, which is
 * why the answer it gives is the same answer the contract gives.
 *
 * There is no launch function, no signer and no key handling anywhere in here.
 * This package reads and computes; it cannot spend. If you want to deploy a
 * chip, the launchpad does that and it does it from your own wallet.
 */

"use strict";

var machine = require("./lib/netlist/machine.js");
var asm = require("./lib/netlist/asm.js");
var chain = require("./lib/chain/chain.js");
var proof = require("./lib/chain/verify.js");

/**
 * Assemble ST-8 source into a ROM.
 * @returns {{rom: number[], labels: object, listing: string[]}}
 */
function assemble(source) {
  return asm.assemble(source);
}

/**
 * Run a ROM on the real netlist.
 *
 * @param {number[]} rom
 * @param {object} [opts]  { cycles = 40, inValue = 0, onCycle }
 * @returns {{cycles: number, halted: boolean, pc, out, carry, zero, registers, switched}}
 */
function run(rom, opts) {
  if (!Array.isArray(rom)) {
    throw new TypeError(
      rom && Array.isArray(rom.rom)
        ? "run() takes the rom, not the whole result: run(assemble(src).rom)"
        : "run() takes a rom, an array of words from assemble().rom"
    );
  }
  var o = opts || {};
  var D = machine.loadNetlist();
  var m = new machine.Machine(D, rom);
  var limit = o.cycles === undefined ? 40 : o.cycles;
  var halted = false;

  m.inPort = o.inValue || 0;
  for (var i = 0; i < limit; i++) {
    m.step();
    if (o.onCycle) {
      o.onCycle({
        cycle: m.cycle, pc: m.pc(), out: m.out(),
        carry: !!m.carry(), zero: !!m.zero(),
        switched: m.switched, halted: m.halted(),
      });
    }
    if (m.halted()) { halted = true; break; }
  }

  var regs = [];
  for (i = 0; i < D.regs.length; i++) regs.push(m.reg(i));

  return {
    cycles: m.cycle, halted: halted,
    pc: m.pc(), out: m.out(),
    carry: !!m.carry(), zero: !!m.zero(),
    registers: regs, switched: m.switched,
    gates: D.gateCount,
  };
}

/** The programs this processor ships with, as source. */
function programs() {
  return asm.sources;
}

module.exports = {
  assemble: assemble,
  run: run,
  programs: programs,

  Machine: machine.Machine,
  loadNetlist: machine.loadNetlist,

  readChip: chain.readChip,
  history: chain.history,
  decodeStepped: chain.decodeStepped,
  ABI: chain.ABI,

  verify: proof.verify,
};
