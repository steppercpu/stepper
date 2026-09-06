#!/usr/bin/env node
/**
 * compile.js: the contracts, compiled.
 *
 *   npm run compile
 *
 * Emits contracts/out/<Name>.json with the ABI, the creation bytecode and the
 * deployed bytecode, and prints the deployed size against the 24,576-byte
 * ceiling EIP-170 puts on a contract.
 *
 * That last number is the one worth watching. `npm run t0` already reports
 * that the gate TABLE is 8.9 kB, but a table is not a contract: the ceiling
 * applies to the compiled runtime bytecode, which is the table plus the
 * assembly that walks it plus everything solc puts around both. Until this
 * has run, "it fits" is an estimate.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const cli = require("./cli.js");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "contracts");
const OUT = path.join(SRC, "out");

/** EIP-170. A contract whose runtime bytecode is larger cannot be deployed. */
const CEILING = 24576;

/** Every .sol in contracts/, so a new generation needs no edit here. */
function sources() {
  return fs.readdirSync(SRC)
    .filter((f) => f.endsWith(".sol"))
    .sort();
}

function compile() {
  const input = {
    language: "Solidity",
    sources: {},
    settings: {
      // The gate walk runs 2,096 times per call and the deploy happens once,
      // so the optimiser is tuned for the call, not for the code size. 200 is
      // the default and it is the right default here: a higher number inlines
      // more and the table is already the bulk of the bytecode.
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
      },
    },
  };
  for (const f of sources()) {
    input.sources[f] = { content: fs.readFileSync(path.join(SRC, f), "utf8") };
  }

  const out = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (out.errors || []).filter((e) => e.severity === "error");
  const warnings = (out.errors || []).filter((e) => e.severity !== "error");

  return { out, errors, warnings };
}

function main() {
  const t0 = Date.now();
  cli.header("COMPILE", "solc " + solc.version().split("+")[0] + ", optimiser on");

  const { out, errors, warnings } = compile();

  if (errors.length) {
    console.log("  " + cli.colour.edge + "FAILED" + cli.colour.off + "\n");
    for (const e of errors) console.log(e.formattedMessage);
    process.exit(1);
  }

  if (warnings.length) {
    console.log("  " + warnings.length + " warning" +
      (warnings.length === 1 ? "" : "s") + ", none fatal:");
    for (const w of warnings) {
      console.log("    " + (w.formattedMessage || w.message).split("\n")[0]);
    }
    console.log("");
  }

  fs.mkdirSync(OUT, { recursive: true });

  console.log("  contract              deployed      of 24,576      creation");
  console.log("  " + "-".repeat(62));

  let worst = 0;
  const written = [];
  for (const file of sources()) {
    const name = path.basename(file, ".sol");
    const c = out.contracts[file] && out.contracts[file][name];
    // An interface file compiles to no deployable contract, which is correct.
    if (!c || !c.evm.bytecode.object) continue;
    const creation = c.evm.bytecode.object;
    const deployed = c.evm.deployedBytecode.object;
    const size = deployed.length / 2;
    const pct = size / CEILING;
    worst = Math.max(worst, pct);

    fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({
      name,
      abi: c.abi,
      bytecode: "0x" + creation,
      deployedBytecode: "0x" + deployed,
      deployedSize: size,
      compiler: solc.version(),
    }, null, 2) + "\n");
    written.push(name + ".json");

    console.log(
      "  " + name.padEnd(20) +
      (size.toLocaleString() + " B").padStart(10) +
      ("  " + (pct * 100).toFixed(1) + "%").padStart(14) +
      ((creation.length / 2).toLocaleString() + " B").padStart(14));
  }

  console.log("");
  if (worst >= 1) {
    console.log("  " + cli.colour.edge + "OVER THE CEILING" + cli.colour.off +
      "  EIP-170 rejects this at deploy time.\n");
    process.exit(1);
  }
  console.log("  pass  every contract is inside the 24,576-byte EIP-170 ceiling");
  console.log("  wrote contracts/out/" + written.join(", "));
  cli.done(t0, "compiled");
}

main();
