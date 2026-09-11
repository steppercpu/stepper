#!/usr/bin/env node
/**
 * build-sdk.js — assemble the publishable SDK package.
 *
 *   npm run sdk
 *
 * Writes sdk/, which is a complete npm package: the processor as a library,
 * the chain reader, and the verifier. Publishing is a separate act and this
 * script does not perform it.
 *
 * Why it is generated, for the same reason build-cli.js is. The package needs
 * the netlist the repository verified, the assembler the site uses and the
 * selectors the contracts were compiled against. Copied by hand, all three
 * begin to drift, and the SDK quietly becomes a different processor from the
 * one it claims to be checking. Generating it makes that impossible by
 * accident: `npm run silicon` regenerates the netlist and `npm run abi`
 * regenerates the selectors, and the next build ships whatever they produced.
 *
 * What it deliberately does not contain: any way to launch a chip, sign a
 * transaction or hold a key. The package reads and computes. Somebody
 * installing it to check our arithmetic should not be installing something
 * that could move their money.
 */

"use strict";

var fs = require("node:fs");
var path = require("node:path");
var cli = require("./cli.js");

cli.header("sdk", "assemble the publishable SDK package");

var ROOT = path.join(__dirname, "..");
var OUT = path.join(ROOT, "sdk");

/* The package's own version, and not the repository's, for the same reason
   the CLI keeps its own: they are released on different days. */
var VERSION = "0.1.0";
var NAME = "stepper-sdk";

/* Source on the left, where it lands on the right. The relative positions are
   the ones the loaders in machine.js and chain.js already search, so every
   file works in the package exactly as it works here, unedited. */
var FILES = [
  ["tools/chain/index.js", "index.js"],
  ["tools/chain/chain.js", "lib/chain/chain.js"],
  ["tools/chain/verify.js", "lib/chain/verify.js"],
  ["tools/netlist/machine.js", "lib/netlist/machine.js"],
  ["tools/netlist/asm.js", "lib/netlist/asm.js"],
  ["tools/netlist/st8.js", "lib/netlist/st8.js"],
  ["public/scripts/st8-data.js", "lib/st8-data.js"],
  ["public/scripts/abi.js", "lib/abi.js"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
];

var README = [
  "# stepper-sdk",
  "",
  "The STEPPER ST-8 processor, as a library: 2,161 NAND gates and 167",
  "flip-flops, evaluated one clock edge at a time.",
  "",
  "```",
  "npm i stepper-sdk",
  "```",
  "",
  "## Run a program",
  "",
  "```js",
  'const stepper = require("stepper-sdk");',
  "",
  "const { rom } = stepper.assemble(`",
  "  loop:  in   r0",
  "         out  r0",
  "         jmp  loop",
  "`);",
  "",
  "const r = stepper.run(rom, { cycles: 12, inValue: 42 });",
  "console.log(r.out, r.cycles, r.gates);",
  "```",
  "",
  "`run()` evaluates the shipped gate list in topological order and latches",
  "every flip-flop at once. It is not a model of an instruction set: the",
  "instruction set is what falls out of the gates.",
  "",
  "## Verify a chip on chain",
  "",
  "```js",
  'const result = await stepper.verify("0x…");',
  "console.log(result.ok, result.cyclesReplayed);",
  "```",
  "",
  "A chip is deterministic and all of its inputs are public. `program()`",
  "returns its ROM; every `step()` emits `Stepped(sponsor, cycle, outPort,",
  "inValue)`. ROM plus those events is the complete tape the machine ran on,",
  "so `verify()` fetches both, replays the whole history on the netlist in",
  "this package, and checks two things:",
  "",
  "- the final cycle, program counter, output and flags match `snapshot()`",
  "- **every logged output matches**, cycle by cycle, not just the last one",
  "",
  "Nothing in that calculation trusts us. The netlist is here, the events come",
  "from whatever node you name, and the arithmetic happens on your machine.",
  "",
  "## What is not here",
  "",
  "No launch function, no signer, no key handling. This package reads and",
  "computes. It cannot spend.",
  "",
  "## API",
  "",
  "| | |",
  "| --- | --- |",
  "| `assemble(source)` | ST-8 assembly to a ROM |",
  "| `run(rom, opts)` | run it on the netlist |",
  "| `programs()` | the shipped programs, as source |",
  "| `readChip(addr, opts)` | cycle, pc, out, flags, registers, ROM |",
  "| `history(addr, opts)` | every `Stepped` event, in cycle order |",
  "| `decodeStepped(log)` | one raw log to its fields |",
  "| `verify(addr, opts)` | replay the history and check the chain agrees |",
  "| `Machine`, `loadNetlist` | the evaluator, for building your own loop |",
  "",
  "`opts.rpc` names the node. It defaults to Robinhood Chain mainnet.",
  "",
  "## Licence",
  "",
  "Apache-2.0. The name and marks are reserved under section 6; see NOTICE.",
  "",
].join("\n");

function copy(from, to) {
  var src = path.join(ROOT, from);
  if (!fs.existsSync(src)) {
    console.error("build-sdk: missing " + from);
    process.exit(1);
  }
  var dst = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return fs.statSync(dst).size;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

var total = 0;
FILES.forEach(function (pair) {
  var n = copy(pair[0], pair[1]);
  total += n;
  console.log("  " + pair[1].padEnd(22) + Math.max(1, Math.round(n / 1024)) + " kB");
});

var pkg = {
  name: NAME,
  version: VERSION,
  description:
    "The STEPPER ST-8 processor as a library: 2,161 NAND gates, an assembler, " +
    "and a verifier that replays a chip's whole on-chain history and checks it.",
  main: "index.js",
  files: ["index.js", "lib/", "README.md", "LICENSE", "NOTICE"],
  keywords: ["cpu", "processor", "netlist", "nand", "ethereum", "evm", "verify"],
  license: "Apache-2.0",
  homepage: "https://steppercpu.tech",
  repository: { type: "git", url: "git+https://github.com/steppercpu/stepper.git" },
  /* Node 18 is where fetch became global, and the chain reader uses it rather
     than pulling in a client. */
  engines: { node: ">=18" },
};

fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "README.md"), README);
total += fs.statSync(path.join(OUT, "README.md")).size;

console.log("");
console.log("build-sdk: " + NAME + "@" + VERSION + " in sdk/, " +
  Math.round(total / 1024) + " kB");
console.log("build-sdk: check it with  npm run sdk-test");
console.log("build-sdk: publishing is `npm publish` from sdk/, and it is a decision");
console.log("           rather than a build step, so this script never does it.");
