/**
 * asm.js: the ST-8 assembler, in the browser.
 *
 * The same instruction encoding as tools/netlist/asm.js, reading its opcode
 * numbers out of the netlist rather than keeping a second copy of them, so a
 * change to the ISA cannot leave the workbench assembling instructions the
 * processor no longer has.
 *
 * A word is 25 bits: [24:20] op · [19:16] rd · [15:12] rs · [11:0] imm/addr.
 *
 * Errors carry a line number and say what was expected. An assembler that
 * only says "syntax error" is a puzzle, not a tool.
 */
(function () {
  "use strict";

  var D = window.ST8_DATA;
  if (!D || !D.ops) return;
  var OP = D.ops;

  var FORMS = {
    nop: "none", hlt: "none",
    not: "rd", shl: "rd", shr: "rd", rol: "rd", ror: "rd",
    inc: "rd", dec: "rd", in: "rd", out: "rd",
    mov: "rr", add: "rr", adc: "rr", sub: "rr", sbb: "rr",
    and: "rr", or: "rr", xor: "rr", nand: "rr", cmp: "rr",
    ldi: "imm",
    ld: "load", st: "store",
    jmp: "addr", jz: "addr", jnz: "addr", jc: "addr", jnc: "addr",
    tst: "rr", swap: "rd", jmpr: "rd",
  };

  /** Every mnemonic, for the reference panel beside the editor. */
  var HELP = {
    none: "", rd: " rd", rr: " rd, rs", imm: " rd, #imm",
    load: " rd, [rs]", store: " [rd], rs", addr: " label",
  };

  function AsmError(line, message) {
    this.line = line;
    this.message = message;
  }

  function reg(tok, line) {
    var m = /^r(\d{1,2})$/i.exec(String(tok).trim());
    if (!m) throw new AsmError(line, "expected a register like r0, got '" + String(tok).trim() + "'");
    var n = +m[1];
    if (n > 15) throw new AsmError(line, "r" + n + " does not exist, the file has r0 to r15");
    return n;
  }

  function imm(tok, line, max) {
    var t = String(tok).trim().replace(/^#/, "");
    var n = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
    if (!isFinite(n)) throw new AsmError(line, "'" + t + "' is not a number");
    if (n < 0 || n > max) throw new AsmError(line, n + " is outside 0 to " + max);
    return n;
  }

  /**
   * Two passes: collect labels, then encode, so a jump may name a label that
   * has not been written yet.
   *
   * @returns {{rom:number[], listing:object[], labels:object, words:number}}
   * @throws  {AsmError}
   */
  function assemble(source) {
    var raw = String(source).split("\n");
    var labels = {};
    var stmts = [];

    raw.forEach(function (text, n) {
      var line = text.replace(/;.*$/, "").trim();
      while (line) {
        var lm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(line);
        if (!lm) break;
        if (Object.prototype.hasOwnProperty.call(labels, lm[1])) {
          throw new AsmError(n + 1, "label '" + lm[1] + "' is defined twice");
        }
        labels[lm[1]] = stmts.length;
        line = line.slice(lm[0].length).trim();
      }
      if (line) stmts.push({ text: line, line: n + 1 });
    });

    if (stmts.length > 1024) {
      throw new AsmError(stmts[1024].line, "the ROM holds 1,024 words and this is word " + (stmts.length));
    }

    var rom = new Array(1024).fill(0);
    var listing = [];

    stmts.forEach(function (st, pc) {
      var m = /^([A-Za-z]+)\s*(.*)$/.exec(st.text);
      if (!m) throw new AsmError(st.line, "cannot read '" + st.text + "' as an instruction");
      var mn = m[1].toLowerCase();
      var rest = m[2].trim();
      var form = FORMS[mn];
      if (!form) throw new AsmError(st.line, "there is no instruction called '" + mn + "'");

      var op = OP[mn.toUpperCase()];
      var rd = 0, rs = 0, field = 0, mm;

      if (form === "rd") {
        rd = reg(rest, st.line);
      } else if (form === "rr") {
        mm = rest.split(",");
        if (mm.length !== 2) throw new AsmError(st.line, mn + " takes 'rd, rs'");
        rd = reg(mm[0], st.line);
        rs = reg(mm[1], st.line);
      } else if (form === "imm") {
        mm = rest.split(",");
        if (mm.length !== 2) throw new AsmError(st.line, "ldi takes 'rd, #imm'");
        rd = reg(mm[0], st.line);
        field = imm(mm[1], st.line, 255);
      } else if (form === "load") {
        mm = /^(r\d{1,2})\s*,\s*\[\s*(r\d{1,2})\s*\]$/i.exec(rest);
        if (!mm) throw new AsmError(st.line, "ld takes 'rd, [rs]'");
        rd = reg(mm[1], st.line);
        rs = reg(mm[2], st.line);
      } else if (form === "store") {
        mm = /^\[\s*(r\d{1,2})\s*\]\s*,\s*(r\d{1,2})$/i.exec(rest);
        if (!mm) throw new AsmError(st.line, "st takes '[rd], rs'");
        rd = reg(mm[1], st.line);
        rs = reg(mm[2], st.line);
      } else if (form === "addr") {
        if (Object.prototype.hasOwnProperty.call(labels, rest)) field = labels[rest];
        else if (/^[A-Za-z_]/.test(rest)) {
          throw new AsmError(st.line, "no label called '" + rest + "' in this program");
        } else field = imm(rest, st.line, 1023);
      } else if (rest) {
        throw new AsmError(st.line, mn + " takes no operands");
      }

      var word = ((op & 0x1f) << 20) | ((rd & 0xf) << 16) | ((rs & 0xf) << 12) | (field & 0xfff);
      rom[pc] = word >>> 0;
      listing.push({
        pc: pc,
        hex: word.toString(16).padStart(7, "0"),
        src: st.text.replace(/\s+/g, " "),
      });
    });

    return { rom: rom, listing: listing, labels: labels, words: stmts.length };
  }

  /**
   * Run a program without a processor, to answer the two questions the
   * workbench needs before it will let you mint: does it halt, and does it
   * ever touch an instruction that does not exist.
   *
   * This is a reachability walk, not an execution: it follows both sides of
   * every branch rather than guessing which way the flags will fall.
   */
  function analyse(prog) {
    var seen = {};
    var stack = [0];
    var halts = false;
    var loops = false;
    var indirect = false;
    var maxPc = 0;

    while (stack.length) {
      var pc = stack.pop();
      if (pc < 0 || pc > 1023) continue;
      if (seen[pc]) { loops = true; continue; }
      seen[pc] = true;
      if (pc > maxPc) maxPc = pc;

      var w = prog.rom[pc] >>> 0;
      var op = (w >>> 20) & 0x1f;
      var addr = w & 0x3ff;

      if (op === OP.HLT) { halts = true; continue; }
      if (op === OP.JMP) { stack.push(addr); continue; }
      // jmpr goes wherever a register says, which is not knowable without
      // running the program. The walk stops rather than guessing, and the
      // caller is told the analysis is partial.
      if (op === OP.JMPR) { indirect = true; continue; }
      if (op === OP.JZ || op === OP.JNZ || op === OP.JC || op === OP.JNC) {
        stack.push(addr);
        stack.push(pc + 1);
        continue;
      }
      stack.push(pc + 1);
    }

    return {
      halts: halts,
      loops: loops,
      indirect: indirect,
      reached: Object.keys(seen).length,
      furthest: maxPc,
    };
  }

  window.ST8_ASM = { assemble: assemble, analyse: analyse, FORMS: FORMS, HELP: HELP };
})();
