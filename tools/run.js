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

/* The processor itself lives in netlist/machine.js, because the published
   CLI and the SDK need the same one and a second copy would be a second
   processor. This file is what puts it on a terminal. */
var machine = require("./netlist/machine.js");
var Machine = machine.Machine;
var loadNetlist = machine.loadNetlist;

function assemble(source) {
  return require("./netlist/asm.js").assemble(source);
}

/* ---------------------------------------------------------------- the CLI */

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function parseArgs(argv) {
  const o = {
    file: null, prog: "ledger", input: 0, cycles: 40, quiet: false, listing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in" || a === "-i") o.input = +argv[++i];
    else if (a === "--cycles" || a === "-c") o.cycles = +argv[++i];
    else if (a === "--prog" || a === "-p") o.prog = argv[++i];
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "--listing" || a === "-l") o.listing = true;
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
    -l, --listing        the encoding instead of the run

  ${CALLED} verify <address> [--rpc <url>]

    Replay a chip's entire history and check the chain agrees with it.

  Every cycle printed is the shipped netlist evaluated gate by gate. The same
  table runs in the browser and the same table goes into the contract.
`;

/**
 * Replay a chip and say whether the chain agrees.
 *
 * The whole of the argument this project makes, in one command. A chip is
 * deterministic and its inputs are public, so anybody can recompute its
 * history from the ROM and the logs and compare the answer with what the
 * contract says about itself. This does that, on the reader's machine, using
 * the netlist in this package rather than anything we serve.
 */
async function verifyChip(address, rpcUrl) {
  const { verify } = require("./chain/verify.js");

  process.stdout.write("\n  replaying " + address + "\n");
  const r = await verify(address, rpcUrl ? { rpc: rpcUrl } : undefined);

  const n = r.cyclesReplayed.toLocaleString();
  if (r.ok) {
    process.stdout.write(
      "\n  " + n + " cycles replayed from " + r.events.toLocaleString() + " logs" +
      "\n  every logged output matched, cycle by cycle" +
      "\n  final state matches snapshot()" +
      "\n\n  this chip's entire history is reproducible on " +
      r.gates.toLocaleString() + " gates\n\n");
    return 0;
  }

  process.stdout.write("\n  it does not check out:\n");
  r.problems.forEach((p) => process.stdout.write("    " + p + "\n"));
  process.stdout.write("\n");
  return 1;
}

function main() {
  /* One subcommand, taken before the flags, because it is a different job:
     everything else here runs a program locally and this one reads a chain. */
  if (process.argv[2] === "verify") {
    const address = process.argv[3];
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      die("verify needs a chip address: " + CALLED + " verify 0x…");
    }
    const at = process.argv.indexOf("--rpc");
    verifyChip(address, at > 0 ? process.argv[at + 1] : null)
      .then((code) => { process.exitCode = code; })
      .catch((e) => {
        const msg = String((e && e.message) || e);
        process.stderr.write("\n  " + msg + "\n");
        /* A bare "fetch failed" means the request never reached a chain at
           all: some networks resolve the default RPC host to a block page.
           The replay is the same against any endpoint for this chain, so the
           useful answer is how to name another one. */
        if (/fetch failed/i.test(msg)) {
          process.stderr.write(
            "\n  the RPC endpoint could not be reached from this network." +
            "\n  any endpoint for the same chain gives the same answer:" +
            "\n\n    " + CALLED + " verify " + address + " --rpc https://steppercpu.tech/rpc\n");
        }
        process.stderr.write("\n");
        process.exitCode = 1;
      });
    return;
  }

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

  /* The encoding, rather than the run.
   *
   * A word is 25 bits and the fields never move: the same layout carries an
   * 8-bit program and a 16-bit one, which is why one assembler serves both
   * generations. That is easy to assert and better shown, so this prints the
   * hex beside the source and splits it into the four fields. */
  if (o.listing) {
    const FORM_OF = require("./netlist/asm.js").forms;
    console.log("  word = [24:20] op   [19:16] rd   [15:12] rs   [11:0] imm/addr");
    console.log("");
    console.log("   PC   WORD       SOURCE              op    rd    rs   imm");
    console.log("  " + "-".repeat(58));
    for (const line of listing) {
      const w = parseInt(line.hex, 16);
      const op = (w >>> 20) & 0x1f;
      const rd = (w >>> 16) & 0xf;
      const rs = (w >>> 12) & 0xf;
      const im = w & 0xfff;
      /* A dash where the field is not part of this form: printing a zero for
         a register an instruction never reads is how a reader learns the
         wrong thing from a correct number. */
      const f = FORM_OF[line.src.trim().split(/\s+/)[0]] || "";
      const col = (v, used, w2) =>
        (used ? v : "-").toString().padStart(w2);
      console.log(
        "  " + String(line.pc).padStart(3) +
        "   " + line.hex +
        "    " + line.src.padEnd(18) +
        col(op.toString(16).padStart(2, "0"), true, 4) +
        col(rd, f === "rd" || f === "rr" || f === "imm" || f === "load", 6) +
        col(rs, f === "rr" || f === "store", 6) +
        col(im.toString(16).padStart(3, "0"),
          f === "imm" || f === "addr" || f === "load" || f === "store", 6)
      );
    }
    return;
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
