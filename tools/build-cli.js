#!/usr/bin/env node
/**
 * build-cli.js — assemble the publishable CLI package.
 *
 *   npm run cli
 *
 * Writes cli/, which is a complete npm package: the processor, the assembler
 * and the runner, with nothing else in it. Publishing is a separate act and
 * this script does not perform it.
 *
 * Why it is generated rather than written. The package needs the same runner,
 * the same assembler and the same netlist the repository uses, and the moment
 * those are copied by hand they start to drift: the published processor
 * quietly becomes a different processor from the one the site demonstrates
 * and the contract walks. Generating the package makes that impossible to do
 * by accident, and `npm run silicon` regenerating the netlist is enough to
 * make the next build ship it.
 *
 * What it deliberately does not contain: the site, the marketing, the brand
 * files, the deployment, and every tool that only makes sense inside this
 * repository. Somebody running one command wants a processor, not a project.
 */

"use strict";

var fs = require("node:fs");
var path = require("node:path");
var cli = require("./cli.js");

cli.header("cli", "assemble the publishable CLI package");

var ROOT = path.join(__dirname, "..");
var OUT = path.join(ROOT, "cli");

/* The package's own version, and not the repository's. The site and the
   package are released on different days for different reasons. */
var VERSION = "0.1.0";
var NAME = "stepper-cli";
var BIN = "stepper";

/* Source on the left, where it lands in the package on the right. The runner
   and the assembler keep their relative positions so both files work in the
   package exactly as they work here, unedited. */
var FILES = [
  ["tools/run.js", "lib/run.js"],
  ["tools/cli.js", "lib/cli.js"],
  ["tools/netlist/asm.js", "lib/netlist/asm.js"],
  ["tools/netlist/st8.js", "lib/netlist/st8.js"],
  ["public/scripts/st8-data.js", "lib/st8-data.js"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
];

var BIN_JS = [
  "#!/usr/bin/env node",
  "/**",
  " * The processor, in your terminal.",
  " *",
  " * The runner is lib/run.js and it is the same file the repository runs, so",
  " * this is a door rather than a second implementation.",
  " */",
  '"use strict";',
  '',
  'require("../lib/run.js");',
  '',
].join("\n");

var README = [
  "# stepper-cli",
  "",
  "An 8-bit processor, built from 2,161 NAND gates and 167 flip-flops, running",
  "in your terminal.",
  "",
  "```",
  "npx " + NAME,
  "```",
  "",
  "No wallet, no account, no network, no build step. It prints one line per",
  "clock edge: the instruction, the output port, the sixteen registers, the",
  "flags, and how many gates switched on that edge.",
  "",
  "## What it actually runs",
  "",
  "Not a simulator of an instruction set. The netlist shipped in this package",
  "is the gate list a synthesis pass produced, and every cycle is computed by",
  "evaluating each of those gates in topological order and then latching every",
  "flip-flop at once. The instruction set is what falls out of the gates, not",
  "the other way round.",
  "",
  "It is the same netlist the browser at https://steppercpu.tech loads and the",
  "same one a contract walks on chain, which is the point: the claim is",
  "checkable without taking anybody's word for it, including ours.",
  "",
  "## Usage",
  "",
  "```",
  BIN + "                            forty cycles of the default program",
  BIN + " --prog selftest             the self-test, to its halt",
  BIN + " my.asm --in 42              your own program, your own input byte",
  BIN + " my.asm --cycles 500 --quiet",
  "```",
  "",
  "| Flag | |",
  "|---|---|",
  "| `--prog <name>` | one of the programs built into the package |",
  "| `--in <byte>` | the value on the input port |",
  "| `--cycles <n>` | how many clock edges to take |",
  "| `--quiet` | the final state only |",
  "",
  "## Writing a program",
  "",
  "```asm",
  "        ldi  r2, #0",
  "loop:   in   r0",
  "        add  r2, r0",
  "        out  r2",
  "        jmp  loop",
  "```",
  "",
  "Assemble and run it with `" + BIN + " that.asm`. The assembler is the same one",
  "the browser uses.",
  "",
  "## Requirements",
  "",
  "Node 20 or newer. No dependencies, at all.",
  "",
  "## Licence",
  "",
  "Apache-2.0. See LICENSE, and NOTICE for what the licence does not grant.",
  "",
].join("\n");

function pkgJson() {
  return JSON.stringify({
    name: NAME,
    version: VERSION,
    description:
      "An 8-bit processor built from 2,161 NAND gates, run in your terminal. " +
      "No dependencies.",
    keywords: [
      "cpu", "processor", "nand", "netlist", "gates", "emulator",
      "assembler", "8-bit", "cli",
    ],
    homepage: "https://steppercpu.tech",
    repository: { type: "git", url: "git+https://github.com/steppercpu/stepper.git" },
    bugs: { url: "https://github.com/steppercpu/stepper/issues" },
    license: "Apache-2.0",
    author: "The STEPPER Authors",
    part: "ST-8",
    tagline: "the chain is the clock",
    type: "commonjs",
    bin: (function () { var b = {}; b[BIN] = "bin/" + BIN + ".js"; return b; })(),
    files: ["bin", "lib", "LICENSE", "NOTICE", "README.md"],
    engines: { node: ">=20" },
  }, null, 2) + "\n";
}

/* ------------------------------------------------------------------ build */

var missing = FILES.filter(function (f) {
  return !fs.existsSync(path.join(ROOT, f[0]));
});
if (missing.length) {
  console.error("build-cli: missing " + missing.map(function (f) { return f[0]; }).join(", "));
  console.error("build-cli: run `npm run silicon` first if it is the netlist.");
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "bin"), { recursive: true });
fs.mkdirSync(path.join(OUT, "lib", "netlist"), { recursive: true });

var bytes = 0;
FILES.forEach(function (f) {
  var dst = path.join(OUT, f[1]);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f[0]), dst);
  bytes += fs.statSync(dst).size;
  console.log("  " + f[1].padEnd(24) + Math.round(fs.statSync(dst).size / 1024) + " kB");
});

fs.writeFileSync(path.join(OUT, "bin", BIN + ".js"), BIN_JS);
fs.writeFileSync(path.join(OUT, "package.json"), pkgJson());
fs.writeFileSync(path.join(OUT, "README.md"), README);
bytes += BIN_JS.length + README.length;

console.log("");
console.log("build-cli: " + NAME + "@" + VERSION + " in cli/, " +
  Math.round(bytes / 1024) + " kB");
console.log("build-cli: try it with  node cli/bin/" + BIN + ".js");
console.log("build-cli: nothing has been published. That is `npm publish` from cli/,");
console.log("           and it is a decision, not a build step.");
