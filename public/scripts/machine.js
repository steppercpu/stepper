/**
 * machine.js: the ST-8, running in your browser.
 *
 * This is not an animation of a processor. It is the processor: the same
 * netlist a contract would interpret on-chain: 2,161 NAND gates walked in
 * topological order, then every flip-flop latching at once, plus its 256
 * bytes of RAM and its input port, handled the way a contract handles them.
 *
 * Exposes: window.ST8.Machine, window.ST8.disasm, window.ST8.MNEMONIC
 */
(function () {
  "use strict";

  var D = window.ST8_DATA;

  /* ---------------------------------------------------------------- machine */

  function Machine(program) {
    this.program = program;
    this.nets = new Uint8Array(D.nets);
    this.next = new Uint8Array(D.flopCount);
    /** Per-gate activity, 1 on the cycle a gate flipped, decaying after. */
    this.heat = new Float32Array(D.gateCount);
    this.ram = new Uint8Array(256);
    /** The byte a sponsor would hand to step(). */
    this.inPort = 0;
    this.reset();
  }

  Machine.prototype.reset = function () {
    this.nets.fill(0);
    this.nets[D.one] = 1;
    this.heat.fill(0);
    this.ram.fill(0);
    this.cycle = 0;
    this.switched = 0;
    this.lastInstr = this.program.rom[0] || 0;
  };

  Machine.prototype.load = function (program) {
    this.program = program;
    this.reset();
  };

  /** Q of flip-flop `i`. */
  Machine.prototype.flop = function (i) {
    return this.nets[D.flops[2 * i + 1]];
  };

  /** Assemble a little-endian field out of flip-flop indices. */
  Machine.prototype.field = function (bits) {
    var n = 0;
    for (var i = 0; i < bits.length; i++) n |= this.flop(bits[i]) << i;
    return n;
  };

  Machine.prototype.pc = function () { return this.field(D.pc); };
  Machine.prototype.out = function () { return this.field(D.out); };
  Machine.prototype.reg = function (r) { return this.field(D.regs[r]); };
  Machine.prototype.carry = function () { return this.flop(D.cf); };
  Machine.prototype.zero = function () { return this.flop(D.zf); };
  Machine.prototype.halted = function () { return this.flop(D.halt) === 1; };
  Machine.prototype.ramAddr = function () { return this.field(D.ramAddr); };
  Machine.prototype.ramWdata = function () { return this.field(D.ramWdata); };
  Machine.prototype.ramWe = function () { return this.flop(D.ramWe) === 1; };

  /**
   * One clock edge. On-chain this is one block, and one call to step().
   * Returns the instruction word that was executed.
   */
  Machine.prototype.step = function () {
    var v = this.nets;
    var word = this.program.rom[this.pc()] || 0;
    var i;

    // --- drive the inputs -------------------------------------------------
    for (i = 0; i < 25; i++) v[D.instr[i]] = (word >> i) & 1;
    for (i = 0; i < 8; i++) v[D.inPort[i]] = (this.inPort >> i) & 1;

    // The address is the one latched on the previous edge. That is exactly
    // why a load costs two honest cycles.
    var rdata = this.ram[this.ramAddr()];
    for (i = 0; i < 8; i++) v[D.ramRdata[i]] = (rdata >> i) & 1;

    // --- combinational cone, in the order the topological sort fixed ------
    var g = D.gates;
    var heat = this.heat;
    var flipped = 0;
    for (var j = 0, k = 0; j < g.length; j += 3, k++) {
      var y = g[j + 2];
      var val = 1 - (v[g[j]] & v[g[j + 1]]);
      if (v[y] !== val) {
        v[y] = val;
        heat[k] = 1;
        flipped++;
      }
    }
    // How much of the die actually did work on this edge. Real, and the one
    // number on the page that changes for a reason rather than on a timer.
    this.switched = flipped;

    // --- latch: sample every D before switching any Q ---------------------
    var f = D.flops;
    var nx = this.next;
    for (i = 0; i < D.flopCount; i++) nx[i] = v[f[2 * i]];
    for (i = 0; i < D.flopCount; i++) v[f[2 * i + 1]] = nx[i];

    if (this.ramWe()) this.ram[this.ramAddr()] = this.ramWdata();

    this.cycle++;
    this.lastInstr = word;
    return word;
  };

  /** Exponential decay of the die glow, called once per animation frame. */
  Machine.prototype.cool = function (factor) {
    var h = this.heat;
    for (var i = 0; i < h.length; i++) {
      if (h[i] > 0.002) h[i] *= factor;
      else if (h[i] !== 0) h[i] = 0;
    }
  };

  /* ------------------------------------------------------------ disassembly */

  var MNEMONIC = [
    "nop", "ldi", "mov", "add", "adc", "sub", "sbb", "and",
    "or", "xor", "nand", "not", "shl", "shr", "rol", "ror",
    "inc", "dec", "cmp", "ld", "st", "in", "out", "jmp",
    "jz", "jnz", "jc", "jnc", "hlt", "tst", "swap", "jmpr",
  ];

  var hex3 = function (n) { return "0x" + n.toString(16).padStart(3, "0"); };

  function disasm(word) {
    var op = (word >>> 20) & 0x1f;
    var rd = (word >>> 16) & 0xf;
    var rs = (word >>> 12) & 0xf;
    var m = MNEMONIC[op] || "?";
    if (op === 0 || op === 28) return m;                            // nop, hlt
    if (op === 1) return m + " r" + rd + ", #" + (word & 0xff);      // ldi
    if (op === 19) return m + " r" + rd + ", [r" + rs + "]";         // ld
    if (op === 20) return m + " [r" + rd + "], r" + rs;              // st
    if (op >= 23 && op <= 27) return m + " " + hex3(word & 0x3ff);   // jumps
    if ((op >= 2 && op <= 10) || op === 18 || op === 29) {
      return m + " r" + rd + ", r" + rs;                              // and tst
    }
    return m + " r" + rd;                                            // rd only
  }

  window.ST8 = { Machine: Machine, disasm: disasm, MNEMONIC: MNEMONIC, DATA: D };
})();
