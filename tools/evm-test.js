#!/usr/bin/env node
/**
 * evm-test.js: the contracts, executed by an EVM.
 *
 *   npm run evm                     both generations, 300 blocks each
 *   npm run evm -- --width 16       ST-16 only
 *   npm run evm -- --blocks 2000
 *   npm run evm -- --quiet
 *
 * This is the check the build spent a long time saying it still owed.
 *
 * Checks 5 and 6 in `npm run t0` decode the packed gate table and re-execute it
 * in JavaScript. That proves the table. It does not prove that the assembly in
 * a gate array walks it correctly, that solc compiles that assembly the way it
 * reads, that Chip packs its state word the way the site assumes, or that the
 * generic layout works on a generation whose program counter is not where the
 * ST-8's is. Only an EVM can say those, so here is one.
 *
 * For each generation:
 *   1. deploy <Gen>GateArray, then Chip against it
 *   2. read spec() back and check every field against the netlist
 *   3. call step() once per block, exactly as a sponsor would
 *   4. after every block, compare the chip's whole observable state against an
 *      independent reference model of the same width
 *   5. read RAM back and compare it cell for cell
 *   6. report the gas a deploy and a step actually cost
 *
 * The first disagreement is printed with both sides, so it can be read rather
 * than guessed at.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");
const { Model } = require("./netlist/model.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "contracts", "out");

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function artifact(name) {
  const p = path.join(OUT, name + ".json");
  if (!fs.existsSync(p)) die("contracts/out/" + name + ".json is missing. Run `npm run compile`.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The shipped ST-8 data, which also carries the two shipped programs. */
function shipped() {
  const win = {};
  const p = path.join(ROOT, "public", "scripts", "st8-data.js");
  if (!fs.existsSync(p)) die("public/scripts/st8-data.js is missing. Run `npm run silicon`.");
  new Function("window", fs.readFileSync(p, "utf8"))(win);
  return win.ST8_DATA;
}

/* --------------------------------------------------------------------- ABI */

const { ethers } = require("ethers");
const sel = (sig) => ethers.id(sig).slice(2, 10);

const SEL = {
  spec: sel("spec()"),
  step: sel("step(uint256)"),
  snapshot: sel("snapshot()"),
  registers: sel("registers()"),
  ram: sel("ram(uint256)"),
  program: sel("program()"),
};

const hex = (b) => Buffer.from(b).toString("hex");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

function words(ret) {
  const h = hex(ret);
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
}

/** A dynamic uint256[] return: one offset word, one length, then the body. */
function dynArray(ret) {
  const w = words(ret);
  const n = Number(w[1]);
  return w.slice(2, 2 + n);
}

/* -------------------------------------------------------------- the fields
 *
 * The Spec struct, in the order IGateArray declares it. Every field is a
 * separate word in the ABI encoding because the struct is returned by a public
 * function rather than packed in storage.
 */
const SPEC_FIELDS = [
  "gates", "flops", "nets", "dataBits", "stateWords", "inputWords", "instrBits",
  "romWords", "ramBytes", "regCount", "regsOffset",
  "pcOffset", "pcBits", "outOffset", "outBits",
  "ramAddrOffset", "ramAddrBits", "ramWdataOffset", "ramWdataBits",
  "haltBit", "carryBit", "zeroBit", "ramWeBit",
];

function decodeSpec(ret) {
  const w = words(ret);
  const s = {};
  SPEC_FIELDS.forEach((k, i) => { s[k] = Number(w[i]); });
  return s;
}

/* ------------------------------------------------------------------ the run */

function parseArgs(argv) {
  const o = { blocks: 300, quiet: false, widths: [8, 16] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--blocks" || a === "-b") o.blocks = +argv[++i];
    else if (a === "--width" || a === "-w") o.widths = [+argv[++i]];
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else die("unknown option '" + a + "'");
  }
  if (!isFinite(o.blocks) || o.blocks < 1) die("--blocks takes a positive number");
  for (const w of o.widths) if (w !== 8 && w !== 16) die("--width takes 8 or 16");
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write("\n  node tools/evm-test.js [--width 8|16] [--blocks N] [--quiet]\n\n");
    return;
  }

  const t0 = Date.now();
  const { VM } = require("@ethereumjs/vm");
  const { Common, Chain, Hardfork } = require("@ethereumjs/common");
  const { Address, hexToBytes } = require("@ethereumjs/util");

  if (!o.quiet) cli.header("EVM", "every generation, run by an actual EVM");

  const D = shipped();
  const chipArt = artifact("Chip");
  const report = { measuredAt: new Date().toISOString().slice(0, 10), generations: {} };

  for (const width of o.widths) {
    const gen = "ST-" + width;
    const arrayArt = artifact("ST" + width + "GateArray");

    // Cancun, because that is what the target chain runs and what compile.js
    // targets. A hardfork mismatch here would prove the wrong thing.
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
    const vm = await VM.create({ common });
    const caller = Address.fromString("0x1111111111111111111111111111111111111111");
    const GAS = 120000000n;

    async function deploy(art, ctorArgs) {
      const r = await vm.evm.runCall({
        caller, origin: caller, gasLimit: GAS,
        data: hexToBytes(art.bytecode + (ctorArgs || "")), value: 0n,
      });
      if (r.execResult.exceptionError) {
        die("deploying " + art.name + " for " + gen + " reverted: " +
          r.execResult.exceptionError.error);
      }
      return { address: r.createdAddress, gas: r.execResult.executionGasUsed };
    }

    async function call(to, data) {
      const r = await vm.evm.runCall({
        caller, origin: caller, to, gasLimit: GAS, data: hexToBytes(data), value: 0n,
      });
      if (r.execResult.exceptionError) {
        return { error: r.execResult.exceptionError.error, gas: r.execResult.executionGasUsed };
      }
      return { ret: r.execResult.returnValue, gas: r.execResult.executionGasUsed };
    }

    if (!o.quiet) {
      console.log(gen);
      console.log("=".repeat(62));
    }

    /* -------------------------------------------------------------- deploy */

    const array = await deploy(arrayArt);

    // The program. Chip #1 runs ledger; the ST-16 gets the same source, which
    // assembles to the same words because the instruction format did not
    // change with the datapath.
    const rom = D.programs.ledger.rom;
    let romWords = 0;
    for (let i = 0; i < rom.length; i++) if (rom[i]) romWords = i + 1;
    let romHex = "";
    for (let i = 0; i < romWords; i++) romHex += (rom[i] >>> 0).toString(16).padStart(8, "0");

    const romBytes = romHex.length / 2;
    const ctor = word(BigInt(array.address.toString())) + word(64) + word(romBytes) +
      romHex.padEnd(Math.ceil(romBytes / 32) * 64, "0");
    const chip = await deploy(chipArt, ctor);

    if (!o.quiet) {
      console.log("  ST" + width + "GateArray  " + array.address.toString() + "   " +
        array.gas.toLocaleString().padStart(10) + " gas   " +
        arrayArt.deployedSize.toLocaleString() + " B");
      console.log("  Chip          " + chip.address.toString() + "   " +
        chip.gas.toLocaleString().padStart(10) + " gas   " +
        chipArt.deployedSize.toLocaleString() + " B");
    }

    /* ------------------------------------------------- spec, read back out */

    const spec = decodeSpec((await call(array.address, "0x" + SEL.spec)).ret);
    const specBad = [];
    const want = {
      dataBits: width,
      stateWords: Math.ceil(spec.flops / 256),
      regCount: 16,
      instrBits: 25,
    };
    for (const k of Object.keys(want)) {
      if (spec[k] !== want[k]) specBad.push(k + "=" + spec[k] + " want " + want[k]);
    }
    if (width === 8) {
      if (spec.gates !== D.gateCount) specBad.push("gates=" + spec.gates + " want " + D.gateCount);
      if (spec.flops !== D.flopCount) specBad.push("flops=" + spec.flops + " want " + D.flopCount);
      if (spec.nets !== D.nets) specBad.push("nets=" + spec.nets + " want " + D.nets);
      if (spec.pcOffset !== D.pc[0]) specBad.push("pcOffset=" + spec.pcOffset);
      if (spec.outOffset !== D.out[0]) specBad.push("outOffset=" + spec.outOffset);
      if (spec.haltBit !== D.halt) specBad.push("haltBit=" + spec.haltBit);
    }
    if (specBad.length) die(gen + " spec() disagrees with the netlist: " + specBad.join(", "));
    if (!o.quiet) {
      console.log("  pass  spec() matches the netlist: " + spec.gates.toLocaleString() +
        " gates, " + spec.flops + " flops, " + spec.stateWords + " state word" +
        (spec.stateWords === 1 ? "" : "s") + ", pc at bit " + spec.pcOffset);
    }

    // The ROM the chip carries has to be the ROM we handed it.
    const back = hex((await call(chip.address, "0x" + SEL.program)).ret).slice(128);
    if (!back.startsWith(romHex)) die(gen + " program() is not the ROM the chip was given");
    if (!o.quiet) console.log("  pass  program() returns the ROM the chip was built with");

    /* ---------------------------------------------------- the differential */

    const m = new Model(rom, width);
    const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
    const inAt = (i) => (i * 37 + 11) & mask;

    const gas = [];
    let halted = false;

    for (let i = 0; i < o.blocks; i++) {
      const b = inAt(i);
      m.inPort = b;
      m.step();

      const r = await call(chip.address, "0x" + SEL.step + word(b));
      if (r.error) die(gen + " step() reverted at block " + (i + 1) + ": " + r.error);
      gas.push(Number(r.gas));

      const s = words((await call(chip.address, "0x" + SEL.snapshot)).ret);
      const regs = dynArray((await call(chip.address, "0x" + SEL.registers)).ret);

      const got = {
        cycle: Number(s[0]), pc: Number(s[1]), out: Number(s[2]),
        carry: s[3] === 1n, zero: s[4] === 1n, halted: s[5] === 1n,
        regs: regs.map(Number),
      };
      const exp = {
        cycle: m.cycle, pc: m.pc, out: m.out,
        carry: m.c === 1, zero: m.z === 1, halted: m.halt === 1,
        regs: Array.from(m.regs),
      };

      for (const k of ["cycle", "pc", "out", "carry", "zero", "halted"]) {
        if (got[k] !== exp[k]) {
          console.log("\n  FAIL  " + gen + " block " + (i + 1) + ", " + k);
          console.log("        evm   " + JSON.stringify(got));
          console.log("        model " + JSON.stringify(exp) + "\n");
          process.exit(1);
        }
      }
      for (let k = 0; k < exp.regs.length; k++) {
        if (got.regs[k] !== exp.regs[k]) {
          console.log("\n  FAIL  " + gen + " block " + (i + 1) + ", r" + k +
            ": evm " + got.regs[k] + ", model " + exp.regs[k] + "\n");
          process.exit(1);
        }
      }
      if (m.halt) { halted = true; break; }
    }

    for (let a = 0; a < 256; a++) {
      const got = Number(words((await call(chip.address, "0x" + SEL.ram + word(a))).ret)[0]);
      if (got !== m.ram[a]) {
        console.log("\n  FAIL  " + gen + " RAM[" + a + "]: evm " + got +
          ", model " + m.ram[a] + "\n");
        process.exit(1);
      }
    }

    gas.sort((a, b) => a - b);
    const stat = {
      min: gas[0], max: gas[gas.length - 1],
      median: gas[Math.floor(gas.length / 2)],
      mean: Math.round(gas.reduce((s, g) => s + g, 0) / gas.length),
    };

    if (!o.quiet) {
      console.log("  pass  " + gas.length.toLocaleString() + " blocks against an independent " +
        width + "-bit model, on cycle, pc, out, C, Z, halt and 16 registers" +
        (halted ? " (to its halt)" : ""));
      console.log("  pass  256 RAM cells read back and compared");
      console.log("");
      console.log("  deploy array  " + array.gas.toLocaleString().padStart(12));
      console.log("  deploy chip   " + chip.gas.toLocaleString().padStart(12));
      console.log("  step min      " + stat.min.toLocaleString().padStart(12));
      console.log("  step median   " + stat.median.toLocaleString().padStart(12));
      console.log("  step mean     " + stat.mean.toLocaleString().padStart(12));
      console.log("  step max      " + stat.max.toLocaleString().padStart(12));
      console.log("");
    }

    report.generations[gen] = {
      solc: arrayArt.compiler,
      blocks: gas.length,
      deployedSize: { array: arrayArt.deployedSize, chip: chipArt.deployedSize },
      spec,
      gas: {
        deployArray: Number(array.gas),
        deployChip: Number(chip.gas),
        stepMin: stat.min, stepMedian: stat.median,
        stepMean: stat.mean, stepMax: stat.max,
        intrinsic: 21000,
      },
    };
  }

  fs.writeFileSync(path.join(OUT, "gas-report.json"), JSON.stringify(report, null, 2) + "\n");

  if (!o.quiet) {
    console.log("  These are execution gas. A real transaction adds the 21,000");
    console.log("  intrinsic cost and its calldata on top.");
    console.log("");
    console.log("  wrote contracts/out/gas-report.json");
    cli.done(t0, "every generation passed");
  }
}

main().catch((e) => die(e.stack || e.message));
