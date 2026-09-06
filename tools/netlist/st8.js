/**
 * st8.js — the ST-8, described structurally in NAND gates.
 *
 * This is the silicon. Not a description of it, not a model of it: running
 * this function emits the exact gate table the browser walks and a contract
 * would interpret. Every gate below is one we placed.
 *
 * ARCHITECTURE
 *   25-bit instruction word   [24:20] op · [19:16] rd · [15:12] rs · [11:0] imm/addr
 *   thirty-two opcodes, which is every code the five-bit field can hold
 *   16 registers of 8 bits    read through two ports, written through one
 *   10-bit program counter    1,024 words of ROM
 *   256 bytes of RAM          outside the netlist — the processor asks, the
 *                             contract answers, which is why `ld` costs two cycles
 *   flags                     C and Z
 *   ports                     one byte in per step, one byte out
 *
 * WHY `ld` TAKES TWO CYCLES. The contract must know which address is being
 * read *before* it runs the gates, but the address lives in a register only
 * the gates can read. So cycle one latches the address and holds the PC;
 * cycle two receives the data and advances. That is not a limitation worked
 * around, it is what a real memory interface costs, and it is why the ISA
 * documents `ld` as two honest cycles.
 */

"use strict";

var OP = {
  NOP: 0, LDI: 1, MOV: 2, ADD: 3, ADC: 4, SUB: 5, SBB: 6, AND: 7,
  OR: 8, XOR: 9, NAND: 10, NOT: 11, SHL: 12, SHR: 13, ROL: 14, ROR: 15,
  INC: 16, DEC: 17, CMP: 18, LD: 19, ST: 20, IN: 21, OUT: 22, JMP: 23,
  JZ: 24, JNZ: 25, JC: 26, JNC: 27, HLT: 28, TST: 29, SWAP: 30, JMPR: 31,
};

function buildST8(b, opts) {
  var i, r;
  // The data width. Everything below is written in terms of W, so ST-16 is
  // this same description with one number changed rather than a second file
  // to keep in step with the first.
  var W = (opts && opts.width) || 8;
  var mark = {};
  var at = function (name) { mark[name] = b.gateCount(); b.block = name; };
  var cost = {};
  var spent = function (name, from) { cost[name] = b.gateCount() - mark[from]; };

  /* ---------------------------------------------------------- the inputs
   * Driven from outside every cycle: the instruction word at ROM[pc], the
   * byte whoever paid for this step sent, and whatever RAM had at the
   * address latched on the previous edge. */
  var instr = b.bus(25);
  var inPort = b.bus(W);
  var ramRdata = b.bus(W);

  /* ----------------------------------------------------------- the state
   * Declared before any logic, because the logic reads Q. */
  var regs = [];
  for (r = 0; r < 16; r++) regs.push(b.flops(W));
  var pc = b.flops(10);
  var outp = b.flops(W);
  var cf = b.flops(1);
  var zf = b.flops(1);
  var halt = b.flops(1);
  var ramAddr = b.flops(8);
  var ramWdata = b.flops(W);
  var ramWe = b.flops(1);
  /** High during the second cycle of a load, and only then. */
  var ldPhase = b.flops(1);

  var cfQ = cf.q[0], zfQ = zf.q[0], haltQ = halt.q[0], ldQ = ldPhase.q[0];

  /* --------------------------------------------------------------- decode */
  at("decode");
  var opBits = instr.slice(20, 25);
  var rdBits = instr.slice(16, 20);
  var rsBits = instr.slice(12, 16);
  // The instruction word keeps its 25 bits at every width, so an immediate
  // is eight bits and arrives zero-extended. A wider core loads a constant
  // into the low half and shifts, exactly like the silicon it imitates.
  var imm8 = instr.slice(0, 8);
  while (imm8.length < W) imm8 = imm8.concat([b.ZERO]);
  imm8 = imm8.slice(0, W);
  var addr10 = instr.slice(0, 10);

  // Thirty-two one-hot lines and thirty-two instructions: the five-bit field
  // is full, and a thirty-third would cost a sixth bit taken from the
  // immediate. That is a decision for a wider generation, not this one.
  var opIs = b.decode(opBits);
  // rd needs a one-hot vector anyway, because writeback selects on it. rs does
  // not: nothing but its own read port ever asks which register it names, so
  // it is muxed straight off the select bits with no decoder at all.
  var rdOne = b.decode(rdBits);
  var o = function (name) { return opIs[OP[name]]; };
  spent("decode", "decode");

  var notHalt = b.not(haltQ);
  /** A halted processor still fetches, but nothing it fetches has any effect. */
  var live = function (sig) { return b.and(sig, notHalt); };

  /* ------------------------------------------------- register read ports */
  at("regread");
  var qOf = function (bit) { return regs.map(function (rg) { return rg.q[bit]; }); };
  var A = [], B = [];
  for (i = 0; i < W; i++) {
    A.push(b.mux1hot(qOf(i), rdOne));   // the destination register, read back
    B.push(b.muxTree(qOf(i), rsBits));  // the source register
  }
  spent("regread", "regread");

  /* ------------------------------------------------------------------ ALU */
  at("alu");

  // One adder serves add, adc, sub, sbb, cmp, inc and dec. Subtraction is
  // two's complement: A + ~B + 1. inc and dec force B to 0 and pick the
  // carry-in, so `dec` is A + 0xff + 0 and costs no extra hardware.
  var selB = b.orAll([o("ADD"), o("ADC"), o("SUB"), o("SBB"), o("CMP")]);
  var invB = b.orAll([o("SUB"), o("SBB"), o("CMP"), o("DEC")]);
  var addB = [];
  for (i = 0; i < W; i++) addB.push(b.xor(b.and(B[i], selB), invB));

  var notC = b.not(cfQ);
  var cin = b.orAll([
    b.and(o("ADC"), cfQ),
    o("SUB"), o("CMP"), o("INC"),
    b.and(o("SBB"), notC),
  ]);
  var sum = b.adder(A, addB, cin);

  var andR = [], orR = [], xorR = [], nandR = [], notR = [];
  for (i = 0; i < W; i++) {
    andR.push(b.and(A[i], B[i]));
    orR.push(b.or(A[i], B[i]));
    xorR.push(b.xor(A[i], B[i]));
    nandR.push(b.nand(A[i], B[i]));
    notR.push(b.not(A[i]));
  }

  // Shifts and rotates are wiring, not logic: no gate is spent on moving the
  // bits. And a rotate differs from a shift in exactly one bit, the one that
  // wraps, so the four operations collapse into two sources for the result
  // mux. Two gates buys back four mux inputs across all eight bits.
  var isRol = b.or(o("SHL"), o("ROL"));
  var isRor = b.or(o("SHR"), o("ROR"));
  var shiftL = [b.and(cfQ, o("ROL"))].concat(A.slice(0, W - 1));
  var shiftR = A.slice(1).concat([b.and(cfQ, o("ROR"))]);

  // swap is the same idea taken further: the halves of A exchanged, which is
  // a permutation of the wires and costs nothing but a source on the mux.
  var half = W >> 1;
  var swapR = A.slice(half).concat(A.slice(0, half));

  // cmp rides the adder so the flags are right, then declines to write.
  var selSum = b.orAll([
    o("ADD"), o("ADC"), o("SUB"), o("SBB"), o("INC"), o("DEC"), o("CMP"),
  ]);
  var selLd = b.and(o("LD"), ldQ);

  // tst rides the AND the way cmp rides the adder: the result is computed so
  // the flags are right, and then thrown away.
  var selAnd = b.or(o("AND"), o("TST"));

  var result = b.mux1hotBus(
    [sum.sum, andR, orR, xorR, nandR, notR, shiftL, shiftR, swapR,
     B, imm8, inPort, ramRdata],
    [selSum, selAnd, o("OR"), o("XOR"), o("NAND"), o("NOT"),
     isRol, isRor, o("SWAP"),
     o("MOV"), o("LDI"), o("IN"), selLd],
    W
  );
  spent("alu", "alu");

  /* ---------------------------------------------------- register writeback */
  at("regwrite");
  // tst is absent on purpose: it is the only new instruction that computes a
  // result and refuses to keep it.
  var writes = b.orAll([
    o("LDI"), o("MOV"), o("ADD"), o("ADC"), o("SUB"), o("SBB"), o("AND"),
    o("OR"), o("XOR"), o("NAND"), o("NOT"), o("SHL"), o("SHR"), o("ROL"),
    o("ROR"), o("INC"), o("DEC"), o("IN"), o("SWAP"), selLd,
  ]);
  var writeEn = live(writes);
  for (r = 0; r < 16; r++) {
    var hit = b.and(rdOne[r], writeEn);
    var nhit = b.not(hit);
    var d = [];
    for (i = 0; i < W; i++) d.push(b.mux(regs[r].q[i], result[i], hit, nhit));
    regs[r].drive(d);
  }
  spent("regwrite", "regwrite");

  /* ---------------------------------------------------------------- flags */
  at("flags");
  // swap and tst set Z from their result and clear C, which is what every
  // logic operation here already does: no carry select is asserted, so the
  // one-hot mux yields zero.
  var setsFlags = b.orAll([
    o("ADD"), o("ADC"), o("SUB"), o("SBB"), o("AND"), o("OR"), o("XOR"),
    o("NAND"), o("NOT"), o("SHL"), o("SHR"), o("ROL"), o("ROR"),
    o("INC"), o("DEC"), o("CMP"), o("TST"), o("SWAP"),
  ]);
  var flagEn = live(setsFlags);

  var zNew = b.not(b.orAll(result));
  // Carry means different things per op, and nothing at all for the logic
  // ops — where no select is asserted and the one-hot mux yields 0.
  var cNew = b.mux1hot([sum.cout, A[W - 1], A[0]], [selSum, isRol, isRor]);
  cf.drive([b.mux(cfQ, cNew, flagEn)]);
  zf.drive([b.mux(zfQ, zNew, flagEn)]);
  spent("flags", "flags");

  /* ------------------------------------------------------ program counter */
  at("pc");
  var taken = b.orAll([
    o("JMP"), o("JMPR"),
    b.and(o("JZ"), zfQ),
    b.and(o("JNZ"), b.not(zfQ)),
    b.and(o("JC"), cfQ),
    b.and(o("JNC"), notC),
  ]);
  // Where a taken branch goes: the address in the word, or the one in a
  // register. At eight bits a register holds eight of the ten address bits,
  // so jmpr reaches the first 256 words; at sixteen it reaches all 1,024.
  var regAddr = A.slice(0, 10);
  while (regAddr.length < 10) regAddr = regAddr.concat([b.ZERO]);
  var branchTo = b.muxBus(addr10, regAddr, o("JMPR"));

  var pcNext = b.increment(pc.q);
  var pcTarget = b.muxBus(pcNext, branchTo, taken);
  // The PC stands still while a load is fetching its operand, and forever
  // once the machine has halted.
  var loadStall = b.and(o("LD"), b.not(ldQ));
  var advance = b.not(b.or(haltQ, loadStall));
  pc.drive(b.muxBus(pc.q, pcTarget, advance));
  spent("pc", "pc");

  /* ------------------------------------------------------ memory and ports */
  at("mem");
  var doLoad = live(loadStall);          // cycle one of a load: latch the address
  var doStore = live(o("ST"));
  var addrD = [];
  var nLoad = b.not(doLoad);
  var nStore = b.not(doStore);
  // The address is always eight bits: 256 locations, whatever the word size.
  for (i = 0; i < 8; i++) {
    var held = b.mux(ramAddr.q[i], B[i], doLoad, nLoad);
    addrD.push(b.mux(held, A[i], doStore, nStore));
  }
  ramAddr.drive(addrD);

  var wD = [];
  for (i = 0; i < W; i++) wD.push(b.mux(ramWdata.q[i], B[i], doStore, nStore));
  ramWdata.drive(wD);
  ramWe.drive([doStore]);

  var outEn = live(o("OUT"));
  var nOut = b.not(outEn);
  var outD = [];
  for (i = 0; i < W; i++) outD.push(b.mux(outp.q[i], A[i], outEn, nOut));
  outp.drive(outD);

  // Two cycles per load, and exactly two: the phase bit cannot stay high.
  ldPhase.drive([live(loadStall)]);
  // Halt is a one-way door. Nothing in the netlist can clear it.
  halt.drive([b.or(haltQ, o("HLT"))]);
  spent("mem", "mem");

  b.sealFlops();

  return {
    instr: instr,
    inPort: inPort,
    ramRdata: ramRdata,
    regs: regs.map(function (rg) { return rg.idx; }),
    pc: pc.idx,
    out: outp.idx,
    ramAddr: ramAddr.idx,
    ramWdata: ramWdata.idx,
    ramWe: ramWe.idx[0],
    halt: halt.idx[0],
    cf: cf.idx[0],
    zf: zf.idx[0],
    // Not read by machine.js, but it is real architectural state and the
    // verifier drives it directly, so it is exported rather than hidden.
    ldPhase: ldPhase.idx[0],
    width: W,
    cost: cost,
  };
}

module.exports = { buildST8: buildST8, OP: OP };
