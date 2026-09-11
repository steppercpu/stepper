#!/usr/bin/env node
/**
 * deploy-launchpad.js: R1.
 *
 *   npm run deploy-launchpad                          preflight. Sends nothing.
 *   npm run deploy-launchpad -- --network testnet      preflight, on the testnet
 *   npm run deploy-launchpad -- --go                   actually deploy
 *
 * T-0 puts one processor on chain. This puts up the thing that lets anybody
 * else put one up, together with a token, in a single transaction.
 *
 * What goes out, in order:
 *
 *   1. ChipRenderer   pure, ownerless, storage-free. Draws a chip's card from
 *                     the chip's own address, so the picture cannot rot and
 *                     nobody can change it after a mint.
 *   2. ChipFactory    against the gate array T-0 already deployed, the venue
 *                     in config.js, and that renderer. It carries a whole
 *                     processor's creation code, which is why it is the larger
 *                     of the two.
 *
 * The gate array is NOT redeployed. It is pure and ownerless and every chip
 * this factory ever makes points at the one already on chain, which is the
 * whole reason it was deployed separately.
 *
 * Rehearse on the testnet. The sequence is identical and a mistake there costs
 * a minute rather than money.
 *
 * The key comes from the environment, never a file and never an argument:
 *
 *   export STEPPER_KEY=0x...
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
  return Object.assign({}, all, net, { network: name });
}

function artifact(name) {
  const p = path.join(OUT, name + ".json");
  if (!fs.existsSync(p)) die("contracts/out/" + name + ".json is missing. Run `npm run compile`.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeAddresses(network, factory, renderer) {
  let cfg = fs.readFileSync(CONFIG, "utf8");
  const open = cfg.indexOf("    " + network + ": {");
  if (open < 0) die("could not find the '" + network + "' block in config.js");
  const close = cfg.indexOf("\n    },", open);
  if (close < 0) die("the '" + network + "' block in config.js is not closed");

  let block = cfg.slice(open, close);
  const before = block;
  block = block.replace(/(\n\s*)factory:\s*[^,]*,/, '$1factory: "' + factory + '",');
  block = block.replace(/(\n\s*)renderer:\s*[^,]*,/, '$1renderer: "' + renderer + '",');
  if (block === before) die("nothing was written into the '" + network + "' block");

  cfg = cfg.slice(0, open) + block + cfg.slice(close);
  fs.writeFileSync(CONFIG, cfg);
}

function parseArgs(argv) {
  const o = { go: false, network: null, cardOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--go") o.go = true;
    else if (a === "--card-only") o.cardOnly = true;
    else if (a === "--network" || a === "-n") o.network = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
    else die("unknown option '" + a + "'. Try --help.");
  }
  return o;
}

const HELP = `
  node tools/deploy-launchpad.js [--network <name>] [--go]

    (no flags)      preflight: the chain, the key, the balance, the cost, and
                    whether the venue will accept a contract. Sends nothing.
    -n, --network   which network in config.js to use. Rehearse on 'testnet'.
    --go            deploy ChipRenderer, then ChipFactory against it.
    --card-only     deploy ChipRenderer alone and stop. The deployed
                    factory keeps the renderer it was built with, because
                    that reference is immutable; this is the one the page
                    calls directly. Recorded as cardRenderer in config.

  Needs STEPPER_KEY in the environment, and a gate array already deployed.
`;

function word(v) {
  return BigInt(v).toString(16).padStart(64, "0");
}

(async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + "\n"); return; }

  const C = loadConfig(o.network);
  cli.header("LAUNCHPAD",
    "chain " + C.chainId + (o.go ? " — deploying R1" : " — preflight, nothing is sent"));

  const rendererArt = artifact("ChipRenderer");
  const factoryArt = artifact("ChipFactory");

  if (!C.gateArray) {
    die("config.js has no gate array for '" + C.network + "'.\n" +
      "  R1 stands on T-0: deploy the processor first with `npm run deploy`.\n" +
      "  The array is pure and ownerless, so every chip this factory makes\n" +
      "  points at that one address and it is never deployed twice.");
  }
  if (!C.venue) die("config.js has no venue address for '" + C.network + "'.");

  const rpc = client(C.rpc);

  console.log("The chain");
  console.log("=".repeat(62));
  const chainId = await rpc.chainId();
  if (Number(chainId) !== C.chainId) {
    die("the endpoint answers chain " + Number(chainId) + ", config.js says " + C.chainId);
  }
  const quoted = BigInt(await rpc.gasPrice());
  const head = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  const baseFee = head && head.baseFeePerGas ? BigInt(head.baseFeePerGas) : 0n;
  const gasPrice = ((quoted > baseFee ? quoted : baseFee) * 15n) / 10n;
  console.log("  network         " + C.network);
  console.log("  chain id        " + Number(chainId) + "  (matches config.js)");
  console.log("  block           " + (await rpc.blockNumber()).toLocaleString("en-US"));
  console.log("  gas price       " + (Number(gasPrice) / 1e9).toFixed(6) + " gwei");
  console.log("");

  console.log("What it stands on");
  console.log("=".repeat(62));
  const arrayCode = await rpc.code(C.gateArray);
  if (!arrayCode || arrayCode === "0x") {
    die("no contract at the gate array address in config.js: " + C.gateArray);
  }
  console.log("  gate array      " + C.gateArray + "  " +
    ((arrayCode.length - 2) / 2).toLocaleString("en-US") + " B");

  const venueCode = await rpc.code(C.venue);
  if (!venueCode || venueCode === "0x") die("no contract at the venue address: " + C.venue);
  console.log("  venue           " + C.venue + "  " +
    ((venueCode.length - 2) / 2).toLocaleString("en-US") + " B");

  /* The venue may refuse contracts. Everything this factory does depends on it
     not refusing, so it is asked rather than assumed. The answer is read for
     an address that does not exist yet only in the sense that the factory is
     not deployed; canLaunch is not address-specific in any way we rely on, so
     the check is repeated against the real address after deployment. */
  const CAN = ethers.id("canLaunch(address)").slice(0, 10);
  const FEE = ethers.id("launchFee()").slice(0, 10);
  const canSelf = await rpc.ethCall({ to: C.venue, data: CAN + word(C.gateArray) });
  const fee = await rpc.ethCall({ to: C.venue, data: FEE });
  console.log("  contracts may launch  " + (BigInt(canSelf) === 1n ? "yes" : "NO"));
  console.log("  launch fee            " + ethers.formatEther(BigInt(fee)) + " " + C.nativeSymbol);
  if (BigInt(canSelf) !== 1n) {
    die("the venue will not accept a contract as a launcher.\n" +
      "  ChipFactory cannot create tokens on this venue, so R1 as designed\n" +
      "  does not work here. Nothing was sent.");
  }
  console.log("");

  if ((C.factory || C.renderer) && !o.cardOnly) {
    die("config.js already names a launchpad on '" + C.network + "'.\n" +
      "  factory:  " + C.factory + "\n  renderer: " + C.renderer + "\n" +
      "  Clear them by hand if you really mean to deploy a second one.");
  }

  console.log("The key");
  console.log("=".repeat(62));
  const key = process.env.STEPPER_KEY;
  let wallet = null;
  if (key) {
    wallet = new ethers.Wallet(key);
    const bal = await rpc.balance(wallet.address);
    console.log("  account         " + wallet.address);
    console.log("  balance         " + ethers.formatEther(bal) + " " + C.nativeSymbol);
  } else {
    console.log("  STEPPER_KEY is not set, so there is no account to deploy from.");
    console.log("  Everything below is priced from the chain anyway.");
  }
  console.log("");

  const from = wallet ? wallet.address : "0x" + "11".repeat(20);
  const rendererData = rendererArt.bytecode;
  const rendererGas = await rpc.estimateGas({ from, data: rendererData });

  /* The factory's constructor takes the renderer, so its cost cannot be quoted
     exactly until the renderer has an address. Estimating against the address
     the renderer will get is not worth the arithmetic: the constructor does
     three zero-checks and three SSTOREs whatever the value, so estimating
     against a placeholder is within a few hundred gas of the truth and the
     script says so rather than pretending otherwise. */
  const placeholder = C.gateArray;
  const factoryCtor = word(C.gateArray) + word(C.venue) + word(placeholder);
  const factoryData = factoryArt.bytecode + factoryCtor;
  const factoryGas = await rpc.estimateGas({ from, data: factoryData });

  const total = BigInt(rendererGas) + BigInt(factoryGas);
  const deployedR = (rendererArt.deployedBytecode.length - 2) / 2;
  const deployedF = (factoryArt.deployedBytecode.length - 2) / 2;

  console.log("What it costs");
  console.log("=".repeat(62));
  console.log("  ChipRenderer    " + Number(rendererGas).toLocaleString("en-US").padStart(11) +
    " gas   " + deployedR.toLocaleString("en-US") + " B deployed");
  console.log("  ChipFactory     " + Number(factoryGas).toLocaleString("en-US").padStart(11) +
    " gas   " + deployedF.toLocaleString("en-US") + " B deployed  (approx: see the note)");
  console.log("  " + "-".repeat(58));
  console.log("  total           " + Number(total).toLocaleString("en-US").padStart(11) +
    " gas   " + ethers.formatEther(total * BigInt(gasPrice)) + " " + C.nativeSymbol);
  console.log("");

  if (!o.go) {
    console.log("Nothing was sent");
    console.log("=".repeat(62));
    console.log("  This was a preflight. Add --go when the numbers above look right.");
    console.log("");
    return;
  }

  if (!wallet) die("STEPPER_KEY is not set, so there is nothing to deploy from");
  const balance = await rpc.balance(wallet.address);
  const needed = total * BigInt(gasPrice) * 12n / 10n;
  if (BigInt(balance) < needed) {
    die("balance is " + ethers.formatEther(balance) + " and this needs about " +
      ethers.formatEther(needed) + " with headroom. Nothing was sent.");
  }

  let nonce = await rpc.nonce(wallet.address);

  async function send(data, label) {
    const gasLimit = (await rpc.estimateGas({ from: wallet.address, data })) * 13n / 10n;
    const raw = await wallet.signTransaction({
      data, nonce: Number(nonce++), gasLimit, gasPrice,
      chainId: Number(chainId), type: 0, value: 0n,
    });
    const hash = await rpc.send(raw);
    const receipt = await rpc.wait(hash);
    if (!receipt || BigInt(receipt.status) !== 1n) die(label + " failed: " + hash);
    console.log("  " + label.padEnd(16) + receipt.contractAddress + "  " +
      Number(receipt.gasUsed).toLocaleString("en-US") + " gas");
    return receipt.contractAddress;
  }

  console.log("Sending");
  console.log("=".repeat(62));
  const renderer = await send(rendererData, "ChipRenderer");

  /* A renderer takes no constructor arguments, so unlike the factory below
     its deployed code should match the artifact byte for byte. */
  if (o.cardOnly) {
    const got = (await rpc.code(renderer)).replace(/^0x/, "").toLowerCase();
    const want = rendererArt.deployedBytecode.replace(/^0x/, "").toLowerCase();
    if (got !== want) die("the deployed renderer does not match the artifact");
    console.log("  code            matches the artifact, byte for byte");
    console.log("");
    console.log("  cardRenderer    " + renderer);
    console.log("");
    console.log("  The factory still calls " + C.renderer + ",");
    console.log("  because ChipFactory holds that address as an immutable.");
    console.log("  tokenURI on the deed is unchanged until a new factory.");
    console.log("");
    return;
  }
  const factory = await send(
    factoryArt.bytecode + word(C.gateArray) + word(C.venue) + word(renderer), "ChipFactory");
  console.log("");

  console.log("Read back");
  console.log("=".repeat(62));

  /* Deployed code against what the compiler produced.
   *
   * Not byte for byte, and the reason is worth writing down because the first
   * version of this check failed a deployment that was perfectly correct. An
   * `immutable` is not storage: solc leaves a hole in the runtime bytecode and
   * the constructor writes the value into the code itself. The artifact
   * therefore carries zeros where this contract carries three addresses, and
   * any contract with a constructor argument will fail a naive comparison
   * every single time.
   *
   * So the check is: the same length, and every byte that differs is part of a
   * twenty-byte run that spells one of the three addresses we deployed against.
   * That is a stronger statement than "the bytes match", because it also
   * proves the constructor received what we meant to give it. */
  const onChain = (await rpc.code(factory)).replace(/^0x/, "").toLowerCase();
  const compiled = factoryArt.deployedBytecode.replace(/^0x/, "").toLowerCase();
  if (onChain.length !== compiled.length) {
    die("the factory's code is " + onChain.length / 2 + " bytes and the artifact is " +
      compiled.length / 2);
  }

  const expected = [C.gateArray, C.venue, renderer]
    .map(function (a) { return a.replace(/^0x/, "").toLowerCase(); });

  var runs = [], i;
  for (i = 0; i < onChain.length; i += 2) {
    if (onChain.substr(i, 2) === compiled.substr(i, 2)) continue;
    var last = runs[runs.length - 1];
    if (last && i / 2 === last.end + 1) last.end = i / 2;
    else runs.push({ start: i / 2, end: i / 2 });
  }
  for (i = 0; i < runs.length; i++) {
    var r = runs[i], len = r.end - r.start + 1;
    var got = onChain.slice(r.start * 2, (r.end + 1) * 2);
    if (len !== 20 || expected.indexOf(got) < 0) {
      die("the factory's code differs from the artifact at byte " + r.start +
        " by " + len + " bytes that are not one of its immutables: 0x" + got);
    }
  }
  console.log("  bytecode        matches, apart from " + runs.length +
    " immutable slots holding the three addresses it was given");

  const RENDERER = ethers.id("RENDERER()").slice(0, 10);
  const ARRAY = ethers.id("ARRAY()").slice(0, 10);
  const VENUE = ethers.id("VENUE()").slice(0, 10);
  const gotR = await rpc.ethCall({ to: factory, data: RENDERER });
  const gotA = await rpc.ethCall({ to: factory, data: ARRAY });
  const gotV = await rpc.ethCall({ to: factory, data: VENUE });
  const same = (ret, want) => ("0x" + ret.slice(26)).toLowerCase() === want.toLowerCase();
  if (!same(gotR, renderer)) die("the factory does not point at the renderer we just deployed");
  if (!same(gotA, C.gateArray)) die("the factory does not point at the gate array");
  if (!same(gotV, C.venue)) die("the factory does not point at the venue");
  console.log("  wiring          renderer, gate array and venue all read back correctly");

  const canReal = await rpc.ethCall({ to: C.venue, data: CAN + word(factory) });
  console.log("  venue accepts it  " + (BigInt(canReal) === 1n ? "yes" : "NO — launches will revert"));

  const totalCall = await rpc.ethCall({ to: factory, data: ethers.id("total()").slice(0, 10) });
  console.log("  chips so far    " + BigInt(totalCall).toString());
  console.log("");

  writeAddresses(C.network, factory, renderer);
  console.log("Written");
  console.log("=".repeat(62));
  console.log("  public/scripts/config.js now names both. The launchpad's mint");
  console.log("  path stays dark until launchpadOpen is set true by hand.");
  console.log("");
})().catch((e) => {
  console.error("\n  deploy-launchpad: " + (e && e.message ? e.message : e) + "\n");
  process.exit(1);
});
