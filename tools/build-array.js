#!/usr/bin/env node
/**
 * build-array.js: emit a gate array contract for a generation.
 *
 *   npm run array              ST-8, the generation that ships at T-0
 *   npm run array -- --width 16   ST-16, the generation R2 ships
 *
 * The netlist is built here rather than read from a file, because the same
 * description produces every width and a file only exists for the one the site
 * currently draws. Building it means a generation is a flag, not a fork.
 *
 * The emitted contract implements IGateArray, so the Chip contract, the
 * launchpad and anything the court eventually needs can hold every generation
 * behind one type.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Builder = require("./netlist/builder.js").Builder;
const st8 = require("./netlist/st8.js");
const optimise = require("./netlist/optimise.js").optimise;
const { emitArray } = require("./emit-array.js");
const cli = require("./cli.js");

const ROOT = path.join(__dirname, "..");

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function parseArgs(argv) {
  const o = { width: 8, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--width" || a === "-w") o.width = +argv[++i];
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else die("unknown option '" + a + "'");
  }
  if (o.width !== 8 && o.width !== 16) die("--width takes 8 or 16");
  return o;
}

/** Build and optimise one generation, in the shape the emitter expects. */
function build(W) {
  const b = new Builder();
  const m = st8.buildST8(b, { width: W });
  const placed = b.gateCount();

  const opt = optimise({
    gates: b.gates, owner: b.owner, n: b.n, ZERO: b.ZERO, ONE: b.ONE,
    primaries: [b.ZERO, b.ONE].concat(m.instr, m.inPort, m.ramRdata, b.flopQ),
    roots: b.flopD.slice(),
  });

  const flops = [];
  for (let i = 0; i < b.flopQ.length; i++) {
    flops.push(opt.resolve(b.flopD[i]), opt.resolve(b.flopQ[i]));
  }

  return {
    placed,
    data: {
      nets: opt.nets,
      zero: opt.zero,
      one: opt.one,
      gateCount: opt.stats.end,
      flopCount: b.flopQ.length,
      gates: opt.gates,
      flops,
      instr: m.instr.map(opt.resolve),
      inPort: m.inPort.map(opt.resolve),
      ramRdata: m.ramRdata.map(opt.resolve),
      pc: m.pc,
      out: m.out,
      ramAddr: m.ramAddr,
      ramWdata: m.ramWdata,
      ramWe: m.ramWe,
      halt: m.halt,
      regs: m.regs,
      cf: m.cf,
      zf: m.zf,
    },
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write("\n  node tools/build-array.js [--width 8|16]\n\n");
    return;
  }

  const t0 = Date.now();
  const part = "ST-" + o.width;
  if (!o.quiet) cli.header("ARRAY", part + " as a contract implementing IGateArray");

  const { placed, data } = build(o.width);

  // The ST-8 emitted here must be the netlist the site already ships, or the
  // contract and the console are two different processors.
  if (o.width === 8) {
    const shipped = path.join(ROOT, "public", "scripts", "st8-data.js");
    if (fs.existsSync(shipped)) {
      const win = {};
      new Function("window", fs.readFileSync(shipped, "utf8"))(win);
      const D = win.ST8_DATA;
      if (D.gateCount !== data.gateCount || D.flopCount !== data.flopCount ||
          D.nets !== data.nets) {
        die("this build does not match public/scripts/st8-data.js. " +
          "Run `npm run silicon` first.");
      }
      let same = D.gates.length === data.gates.length;
      for (let i = 0; same && i < D.gates.length; i++) {
        if (D.gates[i] !== data.gates[i]) same = false;
      }
      if (!same) die("the gate table here differs from the one the site ships");
      if (!o.quiet) {
        console.log("  pass  identical to the netlist the site ships\n");
      }
    }
  }

  const { source, facts } = emitArray(data, {
    part,
    width: o.width,
    // The address space, not the program. A chip may carry fewer words.
    romWords: 1024,
  });

  const file = path.join(ROOT, "contracts", facts.name + ".sol");
  fs.writeFileSync(file, source);

  if (!o.quiet) {
    console.log(part + " as a contract");
    console.log("=".repeat(62));
    console.log("  placed                " + placed.toLocaleString().padStart(10));
    console.log("  shipped               " + facts.gates.toLocaleString().padStart(10) + " gates");
    console.log("  flip-flops            " + String(facts.flops).padStart(10));
    console.log("  nets                  " + facts.nets.toLocaleString().padStart(10));
    console.log("");
    console.log("  gate table            " + (facts.tableBytes / 1024).toFixed(1).padStart(10) + " kB");
    console.log("  flop and port maps    " + (facts.mapBytes / 1024).toFixed(1).padStart(10) + " kB");
    console.log("  total constant data   " +
      ((facts.tableBytes + facts.mapBytes) / 1024).toFixed(1).padStart(10) + " kB");
    console.log("");
    console.log("  state words           " + String(facts.stateWords).padStart(10) +
      "   (" + facts.flops + " flip-flops)");
    console.log("  input words           " + String(facts.inputWords).padStart(10) +
      "   (" + facts.instrBits + " instr + 2 x " + facts.width + ")");
    console.log("");
    console.log("  layout, read by any chip through spec()");
    console.log("    registers           " + String(facts.regsOffset).padStart(6) +
      "  x " + facts.regCount + " x " + facts.width + " bits");
    console.log("    pc                  " + String(facts.pc.offset).padStart(6) +
      "  " + facts.pc.width + " bits");
    console.log("    out                 " + String(facts.out.offset).padStart(6) +
      "  " + facts.out.width + " bits");
    console.log("    ram addr            " + String(facts.ramAddr.offset).padStart(6) +
      "  " + facts.ramAddr.width + " bits");
    console.log("    ram wdata           " + String(facts.ramWdata.offset).padStart(6) +
      "  " + facts.ramWdata.width + " bits");
    console.log("    halt / C / Z / we   " + facts.haltBit + " / " + facts.carryBit +
      " / " + facts.zeroBit + " / " + facts.ramWeBit);
    console.log("");
    console.log("  wrote contracts/" + facts.name + ".sol");
    cli.done(t0, "emitted");
  }
}

main();
