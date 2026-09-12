#!/usr/bin/env node
/**
 * deploy.js: T-0.
 *
 *   npm run deploy                            preflight. Sends nothing.
 *   npm run deploy -- --network testnet       preflight, on the testnet
 *   npm run deploy -- --go                    actually deploy
 *   npm run deploy -- --go --step             deploy, then take the first cycle
 *
 * REHEARSE ON THE TESTNET. The sequence is identical, chain 46630 quotes gas
 * at about a thirty-fifth of the price, and every mistake there costs a
 * minute rather than money. Addresses are written back into the network's own
 * block in config.js, so a rehearsal cannot leave one in the mainnet slot.
 *
 * A dry run is the default and there is no way to send a transaction by
 * accident: --go is required, and even then the script prints what it is about
 * to spend and refuses if the balance cannot cover it.
 *
 * The key comes from the environment, never from a file in the repository and
 * never from an argument, because arguments end up in shell history:
 *
 *   export STEPPER_KEY=0x...
 *
 * What goes out, in order:
 *
 *   1. ST8GateArray   pure, stateless, ownerless, and the only expensive
 *                     transaction. Every chip on this generation, now and
 *                     at R1, points at this one address.
 *   2. Chip           generation-agnostic: it reads every width and offset
 *                     from the array's spec(), writes its ROM as contract
 *                     code, and opens a step() with no owner check on it.
 *
 * Then the addresses are written into public/scripts/config.js, and the site
 * stops saying "not deployed" the next time it is published.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const cli = require("./cli.js");
const { client } = require("./rpc.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "contracts", "out");
const CONFIG = path.join(ROOT, "public", "scripts", "config.js");

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function loadConfig(which) {
  const win = {};
  new Function("window", fs.readFileSync(CONFIG, "utf8"))(win);
  const all = win.CONFIG;
  const name = which || all.network;
  const net = all.networks[name];
  if (!net) {
    die("config.js has no network called '" + name + "'. It has: " +
      Object.keys(all.networks).join(", "));
  }
  // Flat, the way the rest of this file already reads it, plus the name.
  return Object.assign({}, all, net, { network: name });
}

function artifact(name) {
  const p = path.join(OUT, name + ".json");
  if (!fs.existsSync(p)) die("contracts/out/" + name + ".json is missing. Run `npm run compile`.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const eth = (wei) => (Number(wei) / 1e18).toFixed(8);
const gwei = (wei) => (Number(wei) / 1e9).toFixed(6);

/** Thirty-two-byte words out of an eth_call return. */
function decodeWords(ret) {
  const body = String(ret || "").replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(BigInt("0x" + body.substr(i, 64)));
  }
  return out;
}

/**
 * The program chip #1 carries, taken from the netlist rather than retyped:
 * four bytes per twenty-five-bit word, trailing nops trimmed.
 */
function chipRom(which) {
  const win = {};
  const p = path.join(ROOT, "public", "scripts", "st8-data.js");
  if (!fs.existsSync(p)) die("public/scripts/st8-data.js is missing. Run `npm run silicon`.");
  new Function("window", fs.readFileSync(p, "utf8"))(win);
  const named = win.ST8_DATA.programs[which || "ledger"];
  if (!named) {
    die("no program called '" + which + "'. The netlist ships: " +
      Object.keys(win.ST8_DATA.programs).join(", "));
  }
  const words = named.rom;
  let n = 0;
  for (let i = 0; i < words.length; i++) if (words[i]) n = i + 1;
  let hex = "";
  for (let i = 0; i < n; i++) hex += (words[i] >>> 0).toString(16).padStart(8, "0");
  return { words: n, bytes: hex.length / 2, hex };
}

/** abi.encode(address, bytes) for the Chip constructor. */
function chipCtor(array, rom) {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const body = rom.hex.padEnd(Math.ceil(rom.bytes / 32) * 64, "0");
  return w(array) + w(64) + w(rom.bytes) + body;
}

/**
 * Put the two addresses into one network's block in config.js, and make that
 * network the live one.
 *
 * The file is edited as text rather than regenerated, so every comment in it
 * survives. The block is found by its key and the replacement is bounded to
 * it, so deploying to the testnet cannot write into the mainnet slot.
 */
function writeAddresses(network, gateArray, chip) {
  let cfg = fs.readFileSync(CONFIG, "utf8");

  const open = cfg.indexOf("    " + network + ": {");
  if (open < 0) die("could not find the '" + network + "' block in config.js");
  const close = cfg.indexOf("\n    },", open);
  if (close < 0) die("the '" + network + "' block in config.js is not closed");

  let block = cfg.slice(open, close);
  const before = block;
  block = block.replace(/(\n\s*)gateArray:\s*[^,]*,/, '$1gateArray: "' + gateArray + '",');
  if (chip) {
    block = block.replace(/(\n\s*)chip:\s*[^,]*,/, '$1chip: "' + chip + '",');
  }
  if (block === before) die("nothing was written into the '" + network + "' block");

  cfg = cfg.slice(0, open) + block + cfg.slice(close);
  cfg = cfg.replace(/var NETWORK = "[^"]*";/, 'var NETWORK = "' + network + '";');
  fs.writeFileSync(CONFIG, cfg);
}

function parseArgs(argv) {
  const o = { go: false, step: false, network: null, arrayOnly: false,
              chipOnly: false, prog: "ledger" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--go") o.go = true;
    else if (a === "--array-only") o.arrayOnly = true;
    else if (a === "--chip-only") o.chipOnly = true;
    else if (a === "--prog" || a === "-p") o.prog = argv[++i];
    else if (a === "--step") o.step = true;
    else if (a === "--network" || a === "-n") o.network = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
    else die("unknown option '" + a + "'. Try --help.");
  }
  return o;
}

const HELP = `
  node tools/deploy.js [--network <name>] [--go] [--step]

    (no flags)      preflight: check the chain, the key, the balance and the
                    cost. Sends nothing at all.
    -n, --network   which network in config.js to use. Defaults to whichever
                    one config.js says is live. Rehearse on 'testnet'.
    --go            deploy ST8GateArray, then Chip against it.
    --chip-only     deploy a chip against the gate array config.js already
                    names, and send nothing else. The array is deployed once
                    and shared by every chip after it.
    -p, --prog      which program from the netlist the chip carries.
                    Defaults to ledger.
    --array-only    deploy the gate array and stop. The launchpad needs the
                    array and does not need chip #1: the factory makes its own
                    chips against it, so chip #1 can be the first one launched
                    through the factory instead of a separate deployment.
    --step          after deploying, take the first cycle so the chip is live
                    rather than sitting at zero.

  Needs STEPPER_KEY in the environment. It is never read from a file and never
  taken as an argument.
`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + "\n"); return; }

  const t0 = Date.now();
  const C = loadConfig(o.network);
  cli.header("DEPLOY", (C.network === "mainnet" ? "chain " + C.chainId : "REHEARSAL on " + C.network) +
    (o.go ? " — sending" : " — preflight, nothing is sent"));
  const gaArt = artifact("ST8GateArray");
  const chipArt = artifact("Chip");
  const rom = chipRom(o.prog);
  const rpc = client(C.rpc);

  /* ------------------------------------------------------------- the chain */

  console.log("The chain");
  console.log("=".repeat(62));
  const chainId = await rpc.chainId();
  const block = await rpc.blockNumber();
  /* Priced off the head, not off a quote.
   *
   * eth_gasPrice is a snapshot taken before the preflight prints and the
   * operator reads it, and this chain drifts in that gap: a send was refused
   * today with maxFeePerGas 301,228,000 against a base fee of 302,428,000.
   * The sibling deploy script had this fixed and this one did not, which is
   * how the same failure arrives twice. Take whichever is higher and add half
   * again; a legacy transaction refunds nothing above the base fee, so the
   * headroom costs nothing except in the block where it is needed. */
  const quoted = BigInt(await rpc.gasPrice());
  const head = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  const baseFee = head && head.baseFeePerGas ? BigInt(head.baseFeePerGas) : 0n;
  const gasPrice = ((quoted > baseFee ? quoted : baseFee) * 15n) / 10n;
  console.log("  network         " + C.network +
    (C.network === "mainnet" ? "" : "   (a rehearsal: nothing here is the launch)"));
  console.log("  endpoint        " + C.rpc);
  console.log("  chain id        " + chainId + (Number(chainId) === C.chainId
    ? "  (matches config.js)" : "  MISMATCH: config.js says " + C.chainId));
  console.log("  block           " + block.toLocaleString());
  console.log("  gas price       " + gwei(gasPrice) + " gwei");
  if (Number(chainId) !== C.chainId) die("refusing to deploy to a chain config.js does not name");
  console.log("");

  /* ------------------------------------------------------------ already up? */

  /* A second chip is a normal thing to want; a second gate array is not.
     The array is deployed once and every chip after it shares the one that
     exists, so --chip-only is the only mode allowed past this guard. */
  if (o.chipOnly) {
    if (!C.gateArray) die("--chip-only needs a gateArray in config.js and there is none");
    console.log("  gate array   " + C.gateArray + "  (already deployed, reused)");
    console.log("  program      " + o.prog);
    console.log("");
  } else if (C.gateArray || C.chip) {
    console.log("  config.js already names an address:");
    if (C.gateArray) console.log("    gateArray  " + C.gateArray);
    if (C.chip) console.log("    chip       " + C.chip);
    console.log("  Clear them before redeploying, or you will orphan the old ones.\n");
    if (o.go) die("refusing to deploy over addresses that are already set");
  }

  /* -------------------------------------------------------------- the key */

  const key = process.env.STEPPER_KEY;
  if (!key) {
    console.log("The key");
    console.log("=".repeat(62));
    console.log("  STEPPER_KEY is not set, so there is no account to deploy from.");
    console.log("  Everything below is priced from the chain anyway.\n");
  }

  const wallet = key ? new ethers.Wallet(key) : null;
  let balance = 0n;
  if (wallet) {
    balance = await rpc.balance(wallet.address);
    console.log("The account");
    console.log("=".repeat(62));
    console.log("  address         " + wallet.address);
    console.log("  balance         " + eth(balance) + " " + C.nativeSymbol);
    console.log("");
  }

  /* ---------------------------------------------------------- what it costs */

  const gaGas = await rpc.estimateGas({ data: gaArt.bytecode });
  // Priced against a placeholder address, because the real one does not exist
  // until the first transaction is mined. The constructor reads spec() from
  // whatever address it is given, so the estimate is only a floor: the real
  // send below uses the estimate the chain gives for the real argument.
  const chipGas = BigInt(Math.round(Number(gaGas) * 0.6));
  const total = gaGas + chipGas;
  const cost = total * gasPrice;

  console.log("What it costs");
  console.log("=".repeat(62));
  if (o.chipOnly) {
    console.log("  ST8GateArray               not sent   --chip-only, reusing " +
      C.gateArray.slice(0, 10));
    console.log("  Chip            " + chipGas.toLocaleString().padStart(12) + " gas   " +
      chipArt.deployedSize.toLocaleString() + " B deployed, " +
      rom.words + "-word ROM");
    console.log("  " + "-".repeat(58));
    console.log("  total           " + chipGas.toLocaleString().padStart(12) + " gas   " +
      eth(chipGas * gasPrice) + " " + C.nativeSymbol);
  } else {
  console.log("  ST8GateArray    " + gaGas.toLocaleString().padStart(12) + " gas   " +
    gaArt.deployedSize.toLocaleString() + " B deployed");
  if (o.arrayOnly) {
    console.log("  Chip                       not sent   --array-only");
    console.log("  " + "-".repeat(58));
    console.log("  total           " + gaGas.toLocaleString().padStart(12) + " gas   " +
      eth(gaGas * gasPrice) + " " + C.nativeSymbol);
  } else {
    console.log("  Chip            " + chipGas.toLocaleString().padStart(12) + " gas   " +
      chipArt.deployedSize.toLocaleString() + " B deployed, " +
      rom.words + "-word ROM");
    console.log("  " + "-".repeat(58));
    console.log("  total           " + total.toLocaleString().padStart(12) + " gas   " +
      eth(cost) + " " + C.nativeSymbol);
  }
  }
  console.log("");

  const gasReport = path.join(OUT, "gas-report.json");
  if (fs.existsSync(gasReport)) {
    const r = JSON.parse(fs.readFileSync(gasReport, "utf8"));
    const g = r.generations && r.generations["ST-8"] && r.generations["ST-8"].gas;
    if (g) {
      const stepCost = BigInt(g.stepMedian + g.intrinsic) * gasPrice;
      console.log("  one step        " + (g.stepMedian + g.intrinsic).toLocaleString().padStart(12) +
        " gas   " + eth(stepCost) + " " + C.nativeSymbol + "   (measured, npm run evm)");
      console.log("");
    }
  }

  if (wallet && balance < cost * 12n / 10n) {
    console.log("  Balance is under the estimate plus twenty per cent of headroom.");
    console.log("  Top up " + wallet.address + " and run this again.\n");
    if (o.go) die("not enough " + C.nativeSymbol + " to deploy");
  }

  /* -------------------------------------------------------------- dry run? */

  if (!o.go) {
    console.log("Nothing was sent");
    console.log("=".repeat(62));
    console.log("  This was a preflight. Add --go when the numbers above look right.");
    console.log("");
    cli.done(t0, "preflight");
    return;
  }
  if (!wallet) die("STEPPER_KEY is not set, so there is nothing to deploy from");

  /* --------------------------------------------------------------- deploy */

  let nonce = await rpc.nonce(wallet.address);

  async function send(label, data, gasLimit) {
    const tx = {
      to: null,
      data,
      nonce: Number(nonce++),
      gasLimit,
      gasPrice,
      chainId: Number(chainId),
      type: 0,                      // legacy: every chain accepts it
      value: 0n,
    };
    const raw = await wallet.signTransaction(tx);
    const hash = await rpc.send(raw);
    console.log("  " + label.padEnd(16) + hash);
    const rcpt = await rpc.wait(hash);
    if (BigInt(rcpt.status) !== 1n) die(label + " reverted: " + hash);
    const addr = ethers.getAddress(rcpt.contractAddress);
    console.log("  " + "".padEnd(16) + addr + "   " +
      BigInt(rcpt.gasUsed).toLocaleString() + " gas used");
    return addr;
  }

  console.log("Deploying");
  console.log("=".repeat(62));

  // Twenty per cent over the estimate, so a busy block does not strand it.
  const gateArray = o.chipOnly
    ? C.gateArray
    : await send("ST8GateArray", gaArt.bytecode, gaGas * 12n / 10n);

  let chip = null;
  if (!o.arrayOnly) {
    // Now the array exists, the chip's real constructor argument can be priced
    // by the chain rather than guessed at.
    const chipData = chipArt.bytecode + chipCtor(gateArray, rom);
    const realChipGas = await rpc.estimateGas({ from: wallet.address, data: chipData });
    chip = await send("Chip", chipData, realChipGas * 12n / 10n);
  }
  console.log("");

  if (o.arrayOnly) {
    const gaCode = await rpc.code(gateArray);
    if (gaCode.toLowerCase() !== gaArt.deployedBytecode.toLowerCase()) {
      die("the deployed gate array is not the contract we compiled");
    }
    console.log("Verifying");
    console.log("=".repeat(62));
    console.log("  pass  ST8GateArray bytecode on chain is byte-for-byte what we compiled");
    console.log("");

    writeAddresses(C.network, gateArray, null);
    console.log("Written");
    console.log("=".repeat(62));
    console.log("  gateArray  " + gateArray);
    console.log("");
    console.log("  The silicon is on chain and nothing else is. Every chip that");
    console.log("  ever exists points at this one address and it is never");
    console.log("  deployed again.");
    console.log("");
    console.log("  Next: npm run deploy-launchpad");
    console.log("");
    return;
  }

  /* --------------------------------------------------------------- verify */

  console.log("Verifying");
  console.log("=".repeat(62));

  const gaCode = await rpc.code(gateArray);
  const chipCode = await rpc.code(chip);
  const gaOk = gaCode.toLowerCase() === gaArt.deployedBytecode.toLowerCase();
  console.log("  " + (gaOk ? "pass" : "FAIL") +
    "  ST8GateArray bytecode on chain is byte-for-byte what we compiled");
  if (!gaOk) die("the deployed gate array is not the contract we compiled");
  if (chipCode.length <= 4) die("the chip has no code at its address");
  console.log("  pass  Chip has code at its address");

  // The chip has to be pointing at the array we just deployed, and carrying
  // the program we handed it. Both are read back rather than assumed.
  const SPEC = ethers.id("spec()").slice(0, 10);
  const specRet = await rpc.ethCall({ to: chip, data: SPEC });
  const specWords = decodeWords(specRet);
  if (specWords.length < 23) die("spec() through the chip returned a short reply");
  console.log("  pass  spec() through the chip: " + specWords[0] + " gates, " +
    specWords[1] + " flops, " + specWords[4] + " state word(s), pc at bit " +
    specWords[11]);

  const PROGRAM = ethers.id("program()").slice(0, 10);
  const progRet = await rpc.ethCall({ to: chip, data: PROGRAM });
  if (!progRet.replace(/^0x/, "").slice(128).startsWith(rom.hex)) {
    die("program() is not the ROM the chip was deployed with");
  }
  console.log("  pass  program() is the ROM the chip was deployed with");

  // snapshot() through eth_call, exactly as the site will read it.
  const SNAPSHOT = ethers.id("snapshot()").slice(0, 10);
  const w = decodeWords(await rpc.ethCall({ to: chip, data: SNAPSHOT }));
  if (w.length < 6) die("snapshot() returned a short reply");
  console.log("  pass  snapshot() answers: cycle " + w[0] + ", pc 0x" +
    w[1].toString(16).padStart(3, "0") + ", out " + w[2] +
    ", halted " + (w[5] === 1n));
  console.log("");

  /* --------------------------------------------------- the first cycle */

  if (o.step) {
    console.log("The first cycle");
    console.log("=".repeat(62));
    const data = ethers.id("step(uint256)").slice(0, 10) +
      BigInt(42).toString(16).padStart(64, "0");
    const gasLimit = (await rpc.estimateGas({ from: wallet.address, to: chip, data })) * 13n / 10n;
    const raw = await wallet.signTransaction({
      to: chip, data, nonce: Number(nonce++), gasLimit, gasPrice,
      chainId: Number(chainId), type: 0, value: 0n,
    });
    const hash = await rpc.send(raw);
    console.log("  step(42)        " + hash);
    const rcpt = await rpc.wait(hash);
    if (BigInt(rcpt.status) !== 1n) die("the first step reverted");
    console.log("  " + "".padEnd(16) + BigInt(rcpt.gasUsed).toLocaleString() +
      " gas used   " + eth(BigInt(rcpt.gasUsed) * gasPrice) + " " + C.nativeSymbol);
    console.log("  cycle is now    " +
      decodeWords(await rpc.ethCall({ to: chip, data: SNAPSHOT }))[0]);
    console.log("");
  }

  /* --------------------------------------------------------- write config */

  writeAddresses(C.network, gateArray, chip);

  console.log("Written");
  console.log("=".repeat(62));
  console.log("  public/scripts/config.js now names both addresses.");
  console.log("");
  console.log("  gateArray  " + gateArray);
  console.log("  chip       " + chip);
  if (C.explorer) console.log("  explorer   " + C.explorer + "/address/" + chip);
  else console.log("  explorer   none published for this network");
  console.log("");
  if (C.network === "mainnet") {
    console.log("  Next: publish the site against these addresses.");
  } else {
    console.log("  This was the rehearsal. When it reads right, run it again");
    console.log("  with --network mainnet.");
  }
  console.log("");
  cli.done(t0, "T-0");
}

main().catch((e) => die(e.stack || e.message));
