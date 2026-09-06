/**
 * model.js — the ST-8 written the ordinary way, in arithmetic.
 *
 * This exists to disagree with the netlist. It is the same instruction set
 * expressed with `+` and `&` instead of gates, so if the two ever produce a
 * different cycle, one of them is wrong and the build stops.
 *
 * It mirrors the netlist's timing exactly, and that matters more than the
 * arithmetic: everything is computed from the *current* state and only then
 * committed, because a flip-flop samples its D before any Q moves. The RAM
 * write happens after the commit, using the values that were just latched —
 * the same order machine.js uses.
 */

"use strict";

var OP = require("./st8.js").OP;

function Model(rom, width) {
  this.rom = rom;
  // The model widens with the netlist, so one reference serves every
  // generation instead of one reference per generation drifting apart.
  this.W = width || 8;
  this.MASK = this.W >= 32 ? 0xffffffff : (1 << this.W) - 1;
  this.reset();
}

Model.prototype.reset = function () {
  this.regs = new Uint32Array(16);
  this.ram = new Uint32Array(256);
  this.pc = 0;
  this.out = 0;
  this.c = 0;
  this.z = 0;
  this.halt = 0;
  this.ramAddr = 0;
  this.ramWdata = 0;
  this.ramWe = 0;
  this.ldPhase = 0;
  this.inPort = 0;
  this.cycle = 0;
};

/**
 * What the combinational cone computes from the state it is given.
 * Split out so the verifier can drive it with arbitrary state and compare
 * against the netlist's D nets directly, without needing a program that
 * happens to reach that state.
 */
Model.prototype.next = function (word, rdata) {
  var op = (word >>> 20) & 0x1f;
  var rd = (word >>> 16) & 0xf;
  var rs = (word >>> 12) & 0xf;
  var imm = word & 0xff;
  var addr = word & 0x3ff;

  var A = this.regs[rd];
  var B = this.regs[rs];
  var live = this.halt ? 0 : 1;
  var is = function (name) { return op === OP[name] ? 1 : 0; };

  var selSum = is("ADD") || is("ADC") || is("SUB") || is("SBB") ||
               is("INC") || is("DEC") || is("CMP");
  var selB = is("ADD") || is("ADC") || is("SUB") || is("SBB") || is("CMP");
  var invB = is("SUB") || is("SBB") || is("CMP") || is("DEC");

  var M = this.MASK;
  var bOperand = ((selB ? B : 0) ^ (invB ? M : 0)) & M;
  var cin = (is("ADC") && this.c) || is("SUB") || is("CMP") || is("INC") ||
            (is("SBB") && !this.c) ? 1 : 0;
  var raw = A + bOperand + cin;
  var sum = raw & M;
  var cout = raw > M ? 1 : 0;

  var selLd = is("LD") && this.ldPhase ? 1 : 0;

  var half = this.W >> 1;
  var loMask = (1 << half) - 1;

  var result =
    selSum ? sum :
    (is("AND") || is("TST")) ? (A & B) :
    is("SWAP") ? ((((A & loMask) << half) | (A >>> half)) & M) :
    is("OR") ? (A | B) :
    is("XOR") ? (A ^ B) :
    is("NAND") ? (~(A & B) & M) :
    is("NOT") ? (~A & M) :
    is("SHL") ? ((A << 1) & M) :
    is("SHR") ? (A >>> 1) :
    is("ROL") ? (((A << 1) | this.c) & M) :
    is("ROR") ? ((A >>> 1) | (this.c << (this.W - 1))) :
    is("MOV") ? B :
    is("LDI") ? imm :
    is("IN") ? this.inPort :
    selLd ? rdata :
    0;

  var cNew =
    selSum ? cout :
    (is("SHL") || is("ROL")) ? ((A >>> (this.W - 1)) & 1) :
    (is("SHR") || is("ROR")) ? (A & 1) :
    0;
  var zNew = result === 0 ? 1 : 0;

  var writes = is("LDI") || is("MOV") || is("ADD") || is("ADC") || is("SUB") ||
    is("SBB") || is("AND") || is("OR") || is("XOR") || is("NAND") || is("NOT") ||
    is("SHL") || is("SHR") || is("ROL") || is("ROR") || is("INC") || is("DEC") ||
    is("IN") || is("SWAP") || selLd;
  var setsFlags = is("ADD") || is("ADC") || is("SUB") || is("SBB") || is("AND") ||
    is("OR") || is("XOR") || is("NAND") || is("NOT") || is("SHL") || is("SHR") ||
    is("ROL") || is("ROR") || is("INC") || is("DEC") || is("CMP") ||
    is("TST") || is("SWAP");

  var taken = is("JMP") || is("JMPR") ||
    (is("JZ") && this.z) || (is("JNZ") && !this.z) ||
    (is("JC") && this.c) || (is("JNC") && !this.c) ? 1 : 0;
  // The netlist wires the low ten bits of the register into the branch
  // target, so at eight bits a jmpr reaches the first 256 words. The model
  // must not reach further.
  var branchTo = is("JMPR") ? (A & 0x3ff) : addr;
  var loadStall = is("LD") && !this.ldPhase ? 1 : 0;
  var advance = !this.halt && !loadStall ? 1 : 0;

  var doLoad = live && loadStall ? 1 : 0;
  var doStore = live && is("ST") ? 1 : 0;
  var writeEn = live && writes ? 1 : 0;
  var flagEn = live && setsFlags ? 1 : 0;
  var outEn = live && is("OUT") ? 1 : 0;

  var regs = Uint32Array.from(this.regs);
  if (writeEn) regs[rd] = result;

  return {
    regs: regs,
    pc: advance ? (taken ? branchTo : (this.pc + 1) & 0x3ff) : this.pc,
    out: outEn ? A : this.out,
    c: flagEn ? cNew : this.c,
    z: flagEn ? zNew : this.z,
    halt: this.halt || is("HLT") ? 1 : 0,
    // The address bus stays eight bits at every width: 256 locations. The
    // netlist only wires the low eight, so the model must not read more.
    ramAddr: (doStore ? A : (doLoad ? B : this.ramAddr)) & 0xff,
    ramWdata: doStore ? B : this.ramWdata,
    ramWe: doStore,
    ldPhase: doLoad,
  };
};

/** One clock edge: sample, commit, then let the memory write land. */
Model.prototype.step = function () {
  var word = this.rom[this.pc] || 0;
  var rdata = this.ram[this.ramAddr];
  var n = this.next(word, rdata);

  this.regs = n.regs;
  this.pc = n.pc;
  this.out = n.out;
  this.c = n.c;
  this.z = n.z;
  this.halt = n.halt;
  this.ramAddr = n.ramAddr;
  this.ramWdata = n.ramWdata;
  this.ramWe = n.ramWe;
  this.ldPhase = n.ldPhase;

  if (this.ramWe) this.ram[this.ramAddr] = this.ramWdata;
  this.cycle++;
  return word;
};

module.exports = { Model: Model };
