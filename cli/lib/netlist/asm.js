/**
 * asm.js — the ST-8 assembler, and the two programs the site ships.
 *
 * A word is 25 bits: [24:20] op · [19:16] rd · [15:12] rs · [11:0] imm/addr.
 * Nothing clever happens here — one line becomes one word — but the listing
 * it produces is what the ROM panel on the site renders, so the assembler is
 * also the thing that keeps the listing honest about what is executing.
 */

"use strict";

var OP = require("./st8.js").OP;

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

function reg(tok, line) {
  var m = /^r(\d{1,2})$/i.exec(String(tok).trim());
  if (!m) throw new Error("line " + line + ": expected a register, got '" + tok + "'");
  var n = +m[1];
  if (n > 15) throw new Error("line " + line + ": r" + n + " does not exist");
  return n;
}

function imm(tok, line, max) {
  var t = String(tok).trim().replace(/^#/, "");
  var n = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
  if (!Number.isFinite(n)) throw new Error("line " + line + ": bad number '" + tok + "'");
  if (n < 0 || n > max) throw new Error("line " + line + ": " + n + " out of range 0.." + max);
  return n;
}

/**
 * Two passes: collect labels, then encode. A label may be used before it is
 * defined, which is the only reason a forward jump is writable at all.
 */
function assemble(source) {
  var raw = source.split("\n");
  var labels = {};
  var stmts = [];

  raw.forEach(function (text, n) {
    var line = text.replace(/;.*$/, "").trim();
    while (line) {
      var lm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(line);
      if (!lm) break;
      labels[lm[1]] = stmts.length;
      line = line.slice(lm[0].length).trim();
    }
    if (line) stmts.push({ text: line, line: n + 1 });
  });

  if (stmts.length > 1024) throw new Error("program exceeds 1,024 words of ROM");

  var rom = new Array(1024).fill(0);
  var listing = [];

  stmts.forEach(function (st, pc) {
    var m = /^([A-Za-z]+)\s*(.*)$/.exec(st.text);
    if (!m) throw new Error("line " + st.line + ": cannot parse '" + st.text + "'");
    var mn = m[1].toLowerCase();
    var rest = m[2].trim();
    var form = FORMS[mn];
    if (!form) throw new Error("line " + st.line + ": unknown instruction '" + mn + "'");

    var op = OP[mn.toUpperCase()];
    var rd = 0, rs = 0, field = 0, mm;

    if (form === "rd") {
      rd = reg(rest, st.line);
    } else if (form === "rr") {
      mm = rest.split(",");
      if (mm.length !== 2) throw new Error("line " + st.line + ": expected 'rd, rs'");
      rd = reg(mm[0], st.line);
      rs = reg(mm[1], st.line);
    } else if (form === "imm") {
      mm = rest.split(",");
      if (mm.length !== 2) throw new Error("line " + st.line + ": expected 'rd, #imm'");
      rd = reg(mm[0], st.line);
      field = imm(mm[1], st.line, 255);
    } else if (form === "load") {
      mm = /^(r\d{1,2})\s*,\s*\[\s*(r\d{1,2})\s*\]$/i.exec(rest);
      if (!mm) throw new Error("line " + st.line + ": expected 'ld rd, [rs]'");
      rd = reg(mm[1], st.line);
      rs = reg(mm[2], st.line);
    } else if (form === "store") {
      mm = /^\[\s*(r\d{1,2})\s*\]\s*,\s*(r\d{1,2})$/i.exec(rest);
      if (!mm) throw new Error("line " + st.line + ": expected 'st [rd], rs'");
      rd = reg(mm[1], st.line);
      rs = reg(mm[2], st.line);
    } else if (form === "addr") {
      if (Object.prototype.hasOwnProperty.call(labels, rest)) field = labels[rest];
      else field = imm(rest, st.line, 1023);
    }

    var word = ((op & 0x1f) << 20) | ((rd & 0xf) << 16) | ((rs & 0xf) << 12) | (field & 0xfff);
    rom[pc] = word >>> 0;
    listing.push({
      pc: pc,
      hex: word.toString(16).padStart(7, "0"),
      src: st.text.replace(/\s+/g, " "),
    });
  });

  return { rom: rom, labels: labels, listing: listing };
}

/* --------------------------------------------------------------- programs */

/**
 * ledger — what chip #1 carries, and it runs forever.
 *
 * The output port shows whatever byte the sponsor of this cycle sent, r2 holds
 * the sum of every byte the chip was ever given, and RAM keeps the trace. So
 * what the machine accumulates is a record of who has been paying to run it,
 * which is the reason it is called a ledger rather than an echo.
 *
 * It must never halt, so there is no `hlt` in it and every path returns to
 * the loop. The build refuses to ship if it ever stops.
 */
var LEDGER = [
  "        ldi r2, #0        ; running sum of every byte ever sent",
  "        ldi r3, #0        ; where in RAM the next sample lands",
  "loop:   in  r0            ; the byte whoever paid for this step sent",
  "        out r0            ; echo it straight back to the output port",
  "        add r2, r0        ; fold it into the sum",
  "        mov r1, r2",
  "        st  [r3], r1      ; keep a trace of it in RAM",
  "        inc r3            ; wrap at 256 and start overwriting",
  "        jmp loop",
].join("\n");

/**
 * selftest — exercises the ALU, both flags, the shifter and a RAM round trip,
 * then halts on purpose. Any failure jumps to `fail`, which puts 255 on the
 * output port, so a wrong answer is visible on the LEDs rather than silent.
 */
var SELFTEST = [
  "        ldi r0, #200",
  "        ldi r1, #100",
  "        add r0, r1        ; 300 wraps to 44 and sets carry",
  "        jnc fail",
  "        out r0",
  "        ldi r2, #44",
  "        cmp r0, r2        ; equal, so Z",
  "        jnz fail",
  "        ldi r3, #0xf0",
  "        ldi r4, #0x0f",
  "        or  r3, r4        ; 0xff",
  "        out r3",
  "        not r3            ; 0x00, so Z",
  "        jnz fail",
  "        ldi r5, #1",
  "        shl r5",
  "        shl r5            ; 4",
  "        ldi r6, #4",
  "        cmp r5, r6",
  "        jnz fail",
  "        ldi r7, #16",
  "        ldi r8, #123",
  "        st  [r7], r8      ; write it",
  "        ld  r9, [r7]      ; read it back — two honest cycles",
  "        cmp r9, r8",
  "        jnz fail",
  "        out r9",
  "        hlt",
  "fail:   ldi r0, #255",
  "        out r0",
  "        hlt",
].join("\n");

module.exports = {
  assemble: assemble,
  sources: { ledger: LEDGER, selftest: SELFTEST },
};
