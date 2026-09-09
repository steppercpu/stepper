#!/usr/bin/env node
/**
 * build-contract.js — emit the gate array as a contract, and check the packing.
 *
 *   npm run contract
 *
 * This is check five. The first four prove the gate table computes the
 * instruction set; this one proves the table survives being squeezed into a
 * form a contract can hold and walked back out of it unchanged.
 *
 * WHY THE TABLE IS ONLY TWO NUMBERS PER GATE. The optimiser renumbers nets so
 * that constants and primaries come first and every surviving gate output is
 * the next index after the previous one. That is not a trick, it falls out of
 * building in call order: a gate can only name nets that already exist. So the
 * output column is implicit, the table stores just the two inputs, and 2,096
 * gates fit in 8.2 kB instead of 12.3 kB. A synthesised netlist cannot do this
 * without sorting first, and after sorting it would have to store the mapping
 * it just created.
 *
 * WHAT THIS DOES NOT PROVE. It does not run the EVM. Closing that last gap
 * needed running inside a real EVM, which `npm run evm` now does. The
 * decoder below is written to be line-for-line what the Solidity does, so a
 * disagreement between them is the thing to look for when it can be run.
 */

"use strict";

var fs = require("node:fs");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");
var OUT_DIR = path.join(ROOT, "contracts");
var OUT = path.join(OUT_DIR, "ST8GateArray.sol");
var ABI = path.join(ROOT, "public", "scripts", "abi.js");
var keccak = require("./netlist/keccak.js");
var cli = require("./cli.js");

var t0start = Date.now();
cli.header("t0", "build the launch contracts and check every layer");

global.window = {};
require(path.join(ROOT, "public", "scripts", "st8-data.js"));
var D = global.window.ST8_DATA;

var fail = 0;
function bad(m) { fail++; console.error("  FAIL  " + m); }
function ok(m) { console.log("  pass  " + m); }

console.log("\nST-8 gate array, as a contract");
console.log("=".repeat(62));

/* ------------------------------------------------------- selectors, derived
 * A selector copied from somewhere else is a call to a function that may not
 * exist. This site shipped one: it was sending the selector for a function
 * called `tick` at a contract whose function is called `step`. So the hash is
 * computed here, checked against published vectors first, and written out for
 * the front end to read instead of being typed in twice. */

var VECTORS = [
  ["transfer(address,uint256)", "0xa9059cbb"],
  ["balanceOf(address)", "0x70a08231"],
  ["approve(address,uint256)", "0x095ea7b3"],
  ["totalSupply()", "0x18160ddd"],
];
var kbad = VECTORS.filter(function (v) { return keccak.selector(v[0]) !== v[1]; });
if (kbad.length) bad("keccak disagrees with a published vector: " + kbad[0][0]);
else ok("keccak verified against " + VECTORS.length + " published selectors");

var SIGS = {
  step: "step(uint256)",
  snapshot: "snapshot()",
  registers: "registers()",
  state: "state()",
  ram: "ram(uint256)",
  program: "program()",
  spec: "spec()",

  /* The launchpad. One call deploys a processor and launches its token,
     and the page has to encode it exactly: a selector typed by hand into a
     script is a selector that drifts the first time an argument changes. */
  launch: "launch(bytes,(string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)",
  tokenURI: "tokenURI(uint256)",
  records: "records(uint256)",
  idOfChip: "idOfChip(address)",
  totalChips: "total()",

  /* The venue is not ours. These are read off its own bytecode, not copied
     from a post about it, and tools/abi-test.js checks the page against the
     compiled factory rather than against this comment. */
  launchFee: "launchFee()",
  canLaunch: "canLaunch(address)",
  previewLaunchEconomics: "previewLaunchEconomics(uint256,address)",
  launchConfigCount: "launchConfigCount()",
};
var SEL = {};
Object.keys(SIGS).forEach(function (k) {
  SEL[k] = keccak.selector(SIGS[k]);
  console.log("  " + SEL[k] + "  " + SIGS[k]);
});

/* Event topics, derived the same way and for the same reason.
 *
 * A log topic is the whole digest rather than the first four bytes of it, so
 * it cannot come from selector(). The page needs this one to read a chip's
 * history back out of the chain: Stepped carries the input byte and the cycle
 * it went in on, which together with the ROM is the entire tape. */
var EVENTS = {
  stepped: "Stepped(address,uint40,uint256,uint256)",
};
var TOPIC = {};
Object.keys(EVENTS).forEach(function (k) {
  var sig = EVENTS[k];
  var bytes = new Uint8Array(sig.length);
  for (var i = 0; i < sig.length; i++) bytes[i] = sig.charCodeAt(i);
  TOPIC[k] = "0x" + keccak.keccak256(bytes);
  console.log("  " + TOPIC[k] + "  " + sig);
});

/* ------------------------------------------------- the implicit output column */

var gateCount = D.gateCount;
var firstOut = D.gates[2];
var sequential = true;
for (var i = 0; i < gateCount; i++) {
  if (D.gates[3 * i + 2] !== firstOut + i) { sequential = false; break; }
}
if (!sequential) bad("gate outputs are not sequential, so the output column cannot be dropped");
else ok("gate outputs are sequential from net " + firstOut + ", so only inputs are stored");

if (D.nets > 0xffff) bad("net indices exceed 16 bits");

/* --------------------------------------------------------------- packing */

function u16(n) { return n.toString(16).padStart(4, "0"); }

var table = "";
for (i = 0; i < gateCount; i++) table += u16(D.gates[3 * i]) + u16(D.gates[3 * i + 1]);

// Q and D nets, one uint16 each, in flip-flop order.
var qnet = "", dnet = "";
for (i = 0; i < D.flopCount; i++) {
  dnet += u16(D.flops[2 * i]);
  qnet += u16(D.flops[2 * i + 1]);
}
var innet = D.instr.concat(D.inPort, D.ramRdata).map(u16).join("");

var kb = function (hex) { return (hex.length / 2 / 1024).toFixed(1); };
console.log("  table       " + kb(table) + " kB   (" + gateCount + " gates x 4 bytes)");
console.log("  flop maps   " + kb(qnet + dnet) + " kB   (" + D.flopCount + " flops x 4 bytes)");
console.log("  input map   " + kb(innet) + " kB");
console.log("  total       " + kb(table + qnet + dnet + innet) + " kB of the 24 kB ceiling");

/* ------------------------------------------- check 5: decode and re-execute
 * The decoder below reads the packed hex the same way the Solidity does. If
 * the two ever disagree, the machine and the contract disagree, which is the
 * whole thing this project claims cannot happen. */

function unpack(hex) {
  var out = new Uint16Array(hex.length / 4);
  for (var k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 4, 4), 16);
  return out;
}

var T = unpack(table);
var Q = unpack(qnet);
var DD = unpack(dnet);
var IN = unpack(innet);

/** The processor, driven entirely from the packed constants. */
function PackedMachine(program) {
  this.program = program;
  this.v = new Uint8Array(D.nets);
  this.ram = new Uint8Array(256);
  this.inPort = 0;
  this.reset();
}
PackedMachine.prototype.reset = function () {
  this.v.fill(0);
  this.v[D.one] = 1;
  this.ram.fill(0);
  this.cycle = 0;
};
PackedMachine.prototype.flop = function (n) { return this.v[Q[n]]; };
PackedMachine.prototype.field = function (bits) {
  var n = 0;
  for (var k = 0; k < bits.length; k++) n |= this.flop(bits[k]) << k;
  return n;
};
PackedMachine.prototype.step = function () {
  var v = this.v, k;
  var word = this.program.rom[this.field(D.pc)] || 0;
  var rdata = this.ram[this.field(D.ramAddr)];

  for (k = 0; k < 25; k++) v[IN[k]] = (word >>> k) & 1;
  for (k = 0; k < 8; k++) v[IN[25 + k]] = (this.inPort >> k) & 1;
  for (k = 0; k < 8; k++) v[IN[33 + k]] = (rdata >> k) & 1;

  // The output column is implicit: gate k drives net firstOut + k.
  for (k = 0; k < gateCount; k++) {
    v[firstOut + k] = 1 - (v[T[2 * k]] & v[T[2 * k + 1]]);
  }

  var nx = new Uint8Array(D.flopCount);
  for (k = 0; k < D.flopCount; k++) nx[k] = v[DD[k]];
  for (k = 0; k < D.flopCount; k++) v[Q[k]] = nx[k];

  if (this.flop(D.ramWe)) this.ram[this.field(D.ramAddr)] = this.field(D.ramWdata);
  this.cycle++;
};

require(path.join(ROOT, "public", "scripts", "machine.js"));
var ST8 = global.window.ST8;

function stream(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >>> 7) & 0xff; };
}

function differential(key, cycles) {
  var prog = D.programs[key];
  var a = new ST8.Machine(prog);
  var b = new PackedMachine(prog);
  var next = stream(0x9a1e + key.length);
  for (var c = 0; c < cycles; c++) {
    var byte = next();
    a.inPort = byte; b.inPort = byte;
    a.step(); b.step();
    if (a.pc() !== b.field(D.pc)) return { cycle: c, what: "pc" };
    if (a.out() !== b.field(D.out)) return { cycle: c, what: "out" };
    if (a.carry() !== b.flop(D.cf)) return { cycle: c, what: "C" };
    if (a.zero() !== b.flop(D.zf)) return { cycle: c, what: "Z" };
    for (var r = 0; r < 16; r++) {
      if (a.reg(r) !== b.field(D.regs[r])) return { cycle: c, what: "r" + r };
    }
    for (var m = 0; m < 256; m++) {
      if (a.ram[m] !== b.ram[m]) return { cycle: c, what: "ram[" + m + "]" };
    }
    if (a.halted()) break;
  }
  return null;
}

console.log("\nCheck 5 — the packed table, decoded and re-executed");
console.log("=".repeat(62));
var e1 = differential("ledger", 20000);
if (e1) bad("ledger diverged: " + JSON.stringify(e1));
else ok("ledger — 20,000 cycles, packed table == machine.js, RAM included");
var e2 = differential("selftest", 2000);
if (e2) bad("selftest diverged: " + JSON.stringify(e2));
else ok("selftest — every cycle to halt, packed table == machine.js");
/* ------------------------------------------------ check 6: the chip logic
 *
 * The gate array is only half of T-0. Something has to hold the ROM, the RAM
 * and the state word, feed the array once per block and write back what comes
 * out. That is ST8Chip, and this mirrors its arithmetic exactly: the same ROM
 * encoding, the same byte packing of RAM, the same single state word.
 *
 * It catches the errors that actually happen at this layer: a ROM word packed
 * in the wrong byte order, a RAM byte written to the wrong nibble of the wrong
 * slot, a field extracted with the wrong shift. */

/** Every field is contiguous, so each is a shift and a mask rather than a loop. */
function span(bits) {
  for (var i = 1; i < bits.length; i++) {
    if (bits[i] !== bits[i - 1] + 1) return null;
  }
  return { shift: bits[0], width: bits.length };
}
var F = {
  pc: span(D.pc),
  out: span(D.out),
  ramAddr: span(D.ramAddr),
  ramWdata: span(D.ramWdata),
};
if (!F.pc || !F.out || !F.ramAddr || !F.ramWdata) {
  bad("a state field is not contiguous, so the chip cannot use shifts");
}
var HALT_BIT = D.halt, RAMWE_BIT = D.ramWe, CF_BIT = D.cf, ZF_BIT = D.zf;
var STATE_BITS = D.flopCount;

/** How many ROM words ledger actually uses. The rest of the address space is nop. */
var romWords = 0;
for (i = 0; i < D.programs.ledger.rom.length; i++) {
  if (D.programs.ledger.rom[i]) romWords = i + 1;
}
var romHex = "";
for (i = 0; i < romWords; i++) {
  romHex += (D.programs.ledger.rom[i] >>> 0).toString(16).padStart(8, "0");
}

/** The chip, in JS, doing exactly what the Solidity below does. */
function Chip() {
  this.state = 0n;
  this.cycles = 0n;
  this.ram = new Array(8).fill(0n);   // eight words of thirty-two bytes
}
Chip.prototype.rom = function (pc) {
  if (pc >= romWords) return 0;
  return parseInt(romHex.substr(pc * 8, 8), 16) >>> 0;
};
Chip.prototype.ramByte = function (a) {
  return Number((this.ram[a >> 5] >> BigInt((a & 31) * 8)) & 0xffn);
};
Chip.prototype.ramWrite = function (a, v) {
  var w = a >> 5, sh = BigInt((a & 31) * 8);
  this.ram[w] = (this.ram[w] & ~(0xffn << sh)) | (BigInt(v) << sh);
};
Chip.prototype.field = function (s, f) {
  return Number((s >> BigInt(f.shift)) & ((1n << BigInt(f.width)) - 1n));
};
Chip.prototype.bit = function (s, b) { return Number((s >> BigInt(b)) & 1n); };
/** One block. The gate array is called exactly once. */
Chip.prototype.step = function (inByte, array) {
  var s = this.state;
  if (this.bit(s, HALT_BIT)) return false;
  var pc = this.field(s, F.pc);
  var instr = this.rom(pc);
  var rdata = this.ramByte(this.field(s, F.ramAddr));
  var ns = array(s, instr, inByte, rdata);
  if (this.bit(ns, RAMWE_BIT)) {
    this.ramWrite(this.field(ns, F.ramAddr), this.field(ns, F.ramWdata));
  }
  this.state = ns;
  this.cycles += 1n;
  return true;
};

/** The gate array, as a function from one state word to the next. */
function arrayStep(state, instr, inByte, rdata) {
  var v = new Uint8Array(D.nets);
  v[D.one] = 1;
  var k;
  for (k = 0; k < D.flopCount; k++) v[Q[k]] = Number((state >> BigInt(k)) & 1n);
  for (k = 0; k < 25; k++) v[IN[k]] = (instr >>> k) & 1;
  for (k = 0; k < 8; k++) v[IN[25 + k]] = (inByte >> k) & 1;
  for (k = 0; k < 8; k++) v[IN[33 + k]] = (rdata >> k) & 1;
  for (k = 0; k < gateCount; k++) {
    v[firstOut + k] = 1 - (v[T[2 * k]] & v[T[2 * k + 1]]);
  }
  var out = 0n;
  for (k = 0; k < D.flopCount; k++) if (v[DD[k]]) out |= (1n << BigInt(k));
  return out;
}

console.log("\nCheck 6 — the chip: ROM, RAM and the state word");
console.log("=".repeat(62));

(function () {
  var chip = new Chip();
  var ref = new ST8.Machine(D.programs.ledger);
  var next = stream(0x7e11);
  var problem = null;
  for (var c = 0; c < 4000 && !problem; c++) {
    var byte = next();
    ref.inPort = byte;
    ref.step();
    chip.step(byte, arrayStep);
    if (chip.field(chip.state, F.pc) !== ref.pc()) problem = { c: c, what: "pc" };
    else if (chip.field(chip.state, F.out) !== ref.out()) problem = { c: c, what: "out" };
    else if (chip.bit(chip.state, CF_BIT) !== ref.carry()) problem = { c: c, what: "C" };
    else if (chip.bit(chip.state, ZF_BIT) !== ref.zero()) problem = { c: c, what: "Z" };
    else for (var a = 0; a < 256; a++) {
      if (chip.ramByte(a) !== ref.ram[a]) { problem = { c: c, what: "ram[" + a + "]" }; break; }
    }
  }
  if (problem) bad("chip diverged from the machine", JSON.stringify(problem));
  else ok("ledger — 4,000 blocks, chip ROM/RAM/state == machine.js, byte for byte");
})();

var packWidth = STATE_BITS + 40;
if (packWidth > 256) bad("state plus cycle counter does not fit one slot");
else ok("state (" + STATE_BITS + " bits) + cycle counter (40 bits) = " +
  packWidth + " bits, one storage slot");
ok("ledger ROM is " + romWords + " words, " + (romHex.length / 2) +
  " bytes as a constant, not storage");

/* ------------------------------------------------------------------ emit */

if (fail) {
  console.error("\n" + fail + " check(s) failed. Nothing written.\n");
  process.exit(1);
}

var NETS_ALLOC = D.nets + 64;

var gateArray = `// SPDX-License-Identifier: UNLICENSED
// Generated by tools/build-contract.js. Do not edit by hand.
//
// ${gateCount} NAND gates and ${D.flopCount} flip-flops.
//
// PURE, STATELESS, OWNERLESS. It holds nothing and answers to nobody. Every
// chip ever minted can point at this one deployment, so the cost of putting
// the silicon on chain is paid once, by whoever deploys it first.
//
// WHY THE TABLE IS TWO NUMBERS PER GATE. The netlist is built in call order and
// renumbered in that same order, so gate k always drives net ${firstOut} + k and the
// output column never has to be stored. ${kb(table)} kB instead of ${(gateCount * 6 / 1024).toFixed(1)} kB.
//
// WHY IT IS ALL ASSEMBLY. A uint8[] in memory spends thirty-two bytes on every
// net and bounds-checks every access: ${D.nets} nets would be ${Math.round(D.nets * 32 / 1024)} kB of memory and a
// quadratic expansion charge on top. One byte per net is ${Math.round(D.nets / 1024)} kB, and the walk
// becomes two MLOADs and one MSTORE8 per gate with nothing else in the way.
pragma solidity ^0.8.24;

contract ST8GateArray {
    uint256 private constant NETS  = ${D.nets};
    uint256 private constant GATES = ${gateCount};
    uint256 private constant FLOPS = ${D.flopCount};
    /// Gate k drives net FIRST + k. The output column is implicit.
    uint256 private constant FIRST = ${firstOut};
    /// The net wired permanently high.
    uint256 private constant ONE   = ${D.one};

    /// Two uint16 per gate: the A input then the B input.
    bytes private constant TABLE = hex"${table}";
    /// One uint16 per flip-flop: the net its Q drives.
    bytes private constant QNET  = hex"${qnet}";
    /// One uint16 per flip-flop: the net its D reads.
    bytes private constant DNET  = hex"${dnet}";
    /// instr[25], then inPort[8], then ramRdata[8].
    bytes private constant INNET = hex"${innet}";

    /**
     * One clock edge.
     *
     * @param state    the ${D.flopCount} flip-flop values, one per bit, low bit is flop 0
     * @param instr    the 25-bit instruction word at ROM[pc]
     * @param inByte   the byte whoever paid for this step is sending
     * @param ramRdata RAM at the address latched on the previous edge
     * @return next    the flip-flop values after the edge
     *
     * ROM and RAM live in the chip, not here. This is the combinational cone
     * and the latch, and nothing else, which is what makes it reusable.
     */
    function step(uint256 state, uint256 instr, uint256 inByte, uint256 ramRdata)
        external
        pure
        returns (uint256 next)
    {
        // Copied to memory once each, rather than a CODECOPY per lookup.
        bytes memory tbl = TABLE;
        bytes memory qn = QNET;
        bytes memory dn = DNET;
        bytes memory inn = INNET;

        assembly {
            // One byte per net. Memory arrives zeroed, so only the constant
            // high net has to be written. The extra 64 bytes are slack: MLOAD
            // reads 32 bytes at a time and the last net must not run past the
            // end of what we allocated.
            let v := mload(0x40)
            mstore(0x40, add(v, ${NETS_ALLOC}))
            mstore8(add(v, ONE), 1)

            let t := add(tbl, 32)
            let q := add(qn, 32)
            let d := add(dn, 32)
            let n := add(inn, 32)

            // Restore Q from the packed state word.
            for { let i := 0 } lt(i, FLOPS) { i := add(i, 1) } {
                mstore8(add(v, shr(240, mload(add(q, mul(i, 2))))), and(shr(i, state), 1))
            }
            // Drive the instruction word.
            for { let i := 0 } lt(i, 25) { i := add(i, 1) } {
                mstore8(add(v, shr(240, mload(add(n, mul(i, 2))))), and(shr(i, instr), 1))
            }
            // The sponsor's byte, then whatever RAM answered with.
            for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                mstore8(add(v, shr(240, mload(add(n, mul(add(i, 25), 2))))), and(shr(i, inByte), 1))
                mstore8(add(v, shr(240, mload(add(n, mul(add(i, 33), 2))))), and(shr(i, ramRdata), 1))
            }

            // The cone. Already in topological order, so one pass is enough.
            let out := add(v, FIRST)
            for { let k := 0 } lt(k, GATES) { k := add(k, 1) } {
                let e := mload(add(t, mul(k, 4)))
                let a := byte(0, mload(add(v, shr(240, e))))
                let b := byte(0, mload(add(v, and(shr(224, e), 0xffff))))
                mstore8(add(out, k), iszero(and(a, b)))
            }

            // Sample every D. No Q has moved, which is the whole point of a
            // flip-flop and the reason this is one pass and not two.
            for { let i := 0 } lt(i, FLOPS) { i := add(i, 1) } {
                if byte(0, mload(add(v, shr(240, mload(add(d, mul(i, 2))))))) {
                    next := or(next, shl(i, 1))
                }
            }
        }
    }
}
`;

var chipSol = `// SPDX-License-Identifier: UNLICENSED
// Generated by tools/build-contract.js. Do not edit by hand.
//
// Chip #1. The smallest thing that makes the claim true: a real processor,
// stepping on chain, that anyone can advance.
//
// There is no NFT here, no token and no factory. Those are the launchpad, and
// the launchpad is R1. T-0 is this: the silicon runs, and the clock belongs to
// whoever pays for the next edge.
//
// WHAT IT COSTS TO HOLD. The ${D.flopCount} flip-flops and a 40-bit cycle counter are
// ${packWidth} bits, so the entire architectural state is ONE storage slot and one
// SSTORE per block. Every field inside it is contiguous, so reading the program
// counter is a shift and a mask rather than a loop over ${D.flopCount} bits.
//
// The ROM is ${romWords} words and lives in code, not storage: the program never
// changes, so paying to store it would be paying for nothing.
pragma solidity ^0.8.24;

interface IST8GateArray {
    function step(uint256 state, uint256 instr, uint256 inByte, uint256 ramRdata)
        external pure returns (uint256);
}

contract ST8Chip {
    uint256 private constant STATE_BITS = ${STATE_BITS};
    uint256 private constant STATE_MASK = (uint256(1) << ${STATE_BITS}) - 1;

    uint256 private constant PC_SHIFT      = ${F.pc.shift};
    uint256 private constant PC_MASK       = ${(Math.pow(2, F.pc.width) - 1)};
    uint256 private constant OUT_SHIFT     = ${F.out.shift};
    uint256 private constant RAMADDR_SHIFT = ${F.ramAddr.shift};
    uint256 private constant RAMW_SHIFT    = ${F.ramWdata.shift};
    uint256 private constant HALT_BIT      = ${HALT_BIT};
    uint256 private constant RAMWE_BIT     = ${RAMWE_BIT};
    uint256 private constant CF_BIT        = ${CF_BIT};
    uint256 private constant ZF_BIT        = ${ZF_BIT};

    /// ledger, four bytes per 25-bit word. Anything past the end reads as nop.
    bytes private constant ROM = hex"${romHex}";
    uint256 private constant ROM_WORDS = ${romWords};

    IST8GateArray public immutable ARRAY;

    /// [${STATE_BITS - 1}:0] the flip-flops, [${packWidth - 1}:${STATE_BITS}] blocks executed.
    uint256 public packed;
    /// 256 bytes, thirty-two to a word. Only touched when the program stores.
    uint256[8] private _ram;

    /// Emitted once per block. The sponsor is whoever paid for the edge.
    event Stepped(address indexed sponsor, uint40 indexed cycle, uint8 outPort, uint8 inByte);

    error Halted();

    constructor(IST8GateArray array) {
        ARRAY = array;
    }

    /**
     * Advance the processor by one clock edge.
     *
     * Open to anyone. There is no owner check, no keeper and no schedule: the
     * only thing standing between this chip and its next cycle is somebody
     * deciding it is worth the gas.
     *
     * @param inByte the byte the program reads with \`in\`
     */
    function step(uint8 inByte) external {
        uint256 p = packed;
        uint256 s = p & STATE_MASK;
        if ((s >> HALT_BIT) & 1 == 1) revert Halted();

        uint256 pc = (s >> PC_SHIFT) & PC_MASK;
        uint256 addr = (s >> RAMADDR_SHIFT) & 0xff;

        uint256 ns = ARRAY.step(s, _rom(pc), inByte, _ramByte(addr)) & STATE_MASK;

        // The write lands after the latch, using the address and data the edge
        // just produced. That ordering is what makes \`st\` a single cycle.
        if ((ns >> RAMWE_BIT) & 1 == 1) {
            _ramWrite((ns >> RAMADDR_SHIFT) & 0xff, uint8((ns >> RAMW_SHIFT) & 0xff));
        }

        uint256 cycle = (p >> STATE_BITS) + 1;
        packed = ns | (cycle << STATE_BITS);

        emit Stepped(msg.sender, uint40(cycle), uint8((ns >> OUT_SHIFT) & 0xff), inByte);
    }

    /**
     * Everything a reader needs, in one call.
     *
     * The site fetches this with a single eth_call rather than four, because
     * four round trips to show one machine is three too many.
     */
    function snapshot()
        external
        view
        returns (uint256 cycle, uint16 pc, uint8 outPort, bool carry, bool zero, bool halted)
    {
        uint256 p = packed;
        uint256 s = p & STATE_MASK;
        cycle = p >> STATE_BITS;
        pc = uint16((s >> PC_SHIFT) & PC_MASK);
        outPort = uint8((s >> OUT_SHIFT) & 0xff);
        carry = (s >> CF_BIT) & 1 == 1;
        zero = (s >> ZF_BIT) & 1 == 1;
        halted = (s >> HALT_BIT) & 1 == 1;
    }

    /// The sixteen registers, for anyone who wants to watch the arithmetic.
    function registers() external view returns (uint8[16] memory r) {
        uint256 s = packed & STATE_MASK;
        for (uint256 i = 0; i < 16; ++i) r[i] = uint8((s >> (i * 8)) & 0xff);
    }

    /// One byte of RAM.
    function ram(uint256 a) external view returns (uint8) {
        return uint8(_ramByte(a & 0xff));
    }

    // The parameter is not called pc. Inside assembly that name is the Yul
    // builtin for the program-counter opcode, and solc refuses to compile a
    // block where a variable shadows it.
    function _rom(uint256 at) private pure returns (uint256 w) {
        if (at >= ROM_WORDS) return 0;
        bytes memory r = ROM;
        assembly { w := shr(224, mload(add(add(r, 32), mul(at, 4)))) }
    }

    function _ramByte(uint256 a) private view returns (uint256) {
        return (_ram[a >> 5] >> ((a & 31) * 8)) & 0xff;
    }

    function _ramWrite(uint256 a, uint8 val) private {
        uint256 i = a >> 5;
        uint256 sh = (a & 31) * 8;
        _ram[i] = (_ram[i] & ~(uint256(0xff) << sh)) | (uint256(val) << sh);
    }
}
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
// The Solidity is no longer written here. tools/build-array.js emits a gate
// array for any width against IGateArray, and contracts/Chip.sol is
// hand-written and generation-agnostic, so a second emitter in this file would
// only be a copy that drifts. What stays here is the verification: the packed
// table decoded and re-executed, and the chip's arithmetic checked against
// machine.js before any of it reaches a compiler.
void gateArray;
void chipSol;

var abiLines = [
  "// Generated by tools/build-contract.js. Do not edit by hand.",
  "//",
  "// Every selector here is keccak256 of the signature beside it, computed at",
  "// build time and checked against published vectors first. None of it is",
  "// copied from another project, which is why this file exists: the page used",
  "// to send tick(uint256,uint8) at a contract whose function is step().",
  "//",
  "// The layout below is the ST-8's. A chip built on a later generation",
  "// reports its own through spec(), which is why the contracts stopped",
  "// hardcoding these and the page reads them from here only as a default.",
  "window.ST8_ABI = {",
];
Object.keys(SEL).forEach(function (k) {
  abiLines.push("  " + k + ": \"" + SEL[k] + "\",   // " + SIGS[k]);
});
abiLines.push("");
Object.keys(TOPIC).forEach(function (k) {
  abiLines.push("  " + k + "Topic: \"" + TOPIC[k] + "\",");
  abiLines.push("  // keccak256 of " + EVENTS[k]);
});
abiLines.push(
  "",
  "  // Where each field sits inside the packed state word. Contiguous, so the",
  "  // page reads them the same way the contract does: a shift and a mask.",
  "  stateBits: " + STATE_BITS + ",",
  "  pc: { shift: " + F.pc.shift + ", width: " + F.pc.width + " },",
  "  out: { shift: " + F.out.shift + ", width: " + F.out.width + " },",
  "  cf: " + CF_BIT + ", zf: " + ZF_BIT + ", halt: " + HALT_BIT + ",",
  "};",
  ""
);
fs.writeFileSync(ABI, abiLines.join("\n"));

console.log("\nWrote public/scripts/abi.js");
console.log("");
console.log("  The Solidity is emitted elsewhere, on purpose:");
console.log("    npm run array              contracts/ST8GateArray.sol");
console.log("    npm run array -- -w 16     contracts/ST16GateArray.sol");
console.log("    contracts/Chip.sol         hand-written, every generation");
cli.done(t0start, "checks passed");

console.log("  Next: npm run compile, then npm run evm.\n");
