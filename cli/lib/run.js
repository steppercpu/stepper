#!/usr/bin/env node
/**
 * run.js: the ST-8, in your terminal.
 *
 *   npm run step                          the program chip #1 runs, 40 cycles
 *   npm run step -- --prog selftest          the self-test, to its halt
 *   npm run step -- my.asm --in 42        your own file, your own input byte
 *   npm run step -- my.asm --cycles 500 --quiet
 *
 * This walks the same table the browser walks and the same table the contract
 * would walk: public/scripts/st8-data.js, exactly as `npm run silicon` emitted
 * it. Nothing here re-derives the netlist, because a runner that rebuilt the
 * processor before running it would prove nothing about the processor that
 * actually ships.
 *
 * The point of this file is that the claim on the site is checkable. You do
 * not need our page, our host or a wallet to watch the machine execute: you
 * need this file, the netlist beside it, and node. It ships in the published
 * package unedited for exactly that reason.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------- the netlist */

/**
 * st8-data.js is written for a browser, so it assigns to `window`. Handing it
 * an object called window is the whole of the port.
 *
 * Two places it can be, because this file runs in two: in the repository it
 * sits under public/, and in the published package it sits beside this file.
 * Looking in both is cheaper than keeping two runners that could disagree.
 */
function loadNetlist() {
  const places = [
    path.join(ROOT, "public/scripts/st8-data.js"),
    path.join(__dirname, "st8-data.js"),
  ];
  const file = places.find((p) => fs.existsSync(p));
  if (!file) {
    die("st8-data.js is missing. Run `npm run silicon` first.");
  }
  const win = {};
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

function assemble(source) {
  return require("./netlist/asm.js").assemble(source);
}

/* ---------------------------------------------------------------- the CLI */

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function parseArgs(argv) {
  const o = { file: null, prog: "ledger", input: 0, cycles: 40, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in" || a === "-i") o.input = +argv[++i];
    else if (a === "--cycles" || a === "-c") o.cycles = +argv[++i];
    else if (a === "--prog" || a === "-p") o.prog = argv[++i];
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a[0] !== "-") o.file = a;
    else die("unknown option '" + a + "'. Try --help.");
  }
  if (!isFinite(o.input) || o.input < 0 || o.input > 255) die("--in takes 0 to 255");
  if (!isFinite(o.cycles) || o.cycles < 1) die("--cycles takes a positive number");
  return o;
}

/* How this was invoked, so the help says what to type rather than what the
   file happens to be called here: node tools/run.js in the repository,
   stepper once the package is installed. */
const CALLED = path.basename(process.argv[1] || "run.js") === "run.js"
  ? "node tools/run.js" : "stepper";

const HELP = `
  ${CALLED} [file.asm] [options]

    -p, --prog <name>    a built-in program: ledger or selftest   (default ledger)
    -i, --in <0-255>     the byte the sponsor hands to step()  (default 0)
    -c, --cycles <n>     how many clock edges to take          (default 40)
    -q, --quiet          only the final state

  Every cycle printed is the shipped netlist evaluated gate by gate. The same
  table runs in the browser and the same table goes into the contract.
`;

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + "\n"); return; }

  const D = loadNetlist();
  let rom, listing, label;

  if (o.file) {
    if (!fs.existsSync(o.file)) die("no such file: " + o.file);
    const out = assemble(fs.readFileSync(o.file, "utf8"));
    rom = out.rom;
    listing = out.listing;
    label = path.basename(o.file);
  } else {
    const p = D.programs[o.prog];
    if (!p) {
      die("no built-in program called '" + o.prog + "'. There are: " +
        Object.keys(D.programs).join(", "));
    }
    rom = p.rom;
    listing = p.listing;
    label = o.prog;
  }

  if (!o.quiet) {
    cli.header("STEP", label + " on " + D.gateCount.toLocaleString() + " gates");
  }

  const m = new Machine(D, rom);
  m.inPort = o.input & 0xff;

  const src = {};
  (listing || []).forEach((r) => { src[r.pc] = r.src; });

  if (!o.quiet) {
    process.stdout.write(
      "  CYC   PC     INSTRUCTION            OUT   R0  R1  R2   C Z   SWITCHED\n" +
      "  " + "-".repeat(72) + "\n");
  }

  let halted = false;
  for (let i = 0; i < o.cycles; i++) {
    const pc = m.pc();
    m.step();
    if (!o.quiet) {
      process.stdout.write(
        "  " + String(m.cycle).padStart(3) +
        "   0x" + pc.toString(16).padStart(3, "0") +
        "  " + (src[pc] || "·").padEnd(22) +
        " " + String(m.out()).padStart(4) +
        "  " + String(m.reg(0)).padStart(3) +
        " " + String(m.reg(1)).padStart(3) +
        " " + String(m.reg(2)).padStart(3) +
        "   " + (m.carry() ? "C" : "·") + " " + (m.zero() ? "Z" : "·") +
        "   " + String(m.switched).padStart(6) + "\n");
    }
    if (m.halted()) { halted = true; break; }
  }

  process.stdout.write(
    "\n  " + (halted ? "halted" : "still running") +
    " after " + m.cycle + " cycle" + (m.cycle === 1 ? "" : "s") +
    "  ·  out = " + m.out() +
    "  ·  pc = 0x" + m.pc().toString(16).padStart(3, "0") + "\n\n");
}

main();
