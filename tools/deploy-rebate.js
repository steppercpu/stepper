#!/usr/bin/env node
/**
 * deploy-rebate.js — put the cycle reserve on chain.
 *
 *   node tools/deploy-rebate.js               preflight, sends nothing
 *   node tools/deploy-rebate.js --go          deploy
 *
 * Three arguments go into the constructor and none of them can be changed
 * afterwards: the token it pays in, the one chip it will advance, and the rate.
 * So the preflight reads all three off the chain rather than off this file, and
 * refuses anything it cannot confirm.
 *
 * Needs STEPPER_KEY in the environment. It is never read from a file and never
 * taken as an argument.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");
const { ethers } = require("ethers");
const { client } = require("./rpc.js");

const ROOT = path.join(__dirname, "..");

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function config() {
  const win = {};
  new Function("window", fs.readFileSync(
    path.join(ROOT, "public", "scripts", "config.js"), "utf8"))(win);
  return win.CONFIG;
}

function artifact(name) {
  const p = path.join(ROOT, "contracts", "out", name + ".json");
  if (!fs.existsSync(p)) die("contracts/out/" + name + ".json is missing. Run `npm run compile`.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The rate, in whole tokens. Below the cost of the cycle it offsets. */
const RATE_TOKENS = 200n;

(async function main() {
  const go = process.argv.includes("--go");
  cli.header("REBATE", "the cycle reserve, on chain");

  const C = config();
  const rpc = client(C.rpc);
  const art = artifact("CycleRebate");

  const chainId = await rpc.chainId();
  const block = await rpc.blockNumber();

  /* Priced off the head rather than a quote, for the reason the other two
     deploy scripts now carry: this chain's base fee drifts between the
     preflight printing and the operator reading it. */
  const quoted = BigInt(await rpc.gasPrice());
  const head = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  const baseFee = head && head.baseFeePerGas ? BigInt(head.baseFeePerGas) : 0n;
  const gasPrice = ((quoted > baseFee ? quoted : baseFee) * 15n) / 10n;

  console.log("The chain");
  console.log("=".repeat(62));
  console.log("  chain id        " + chainId);
  console.log("  block           " + block.toLocaleString());
  console.log("  gas price       " + (Number(gasPrice) / 1e9).toFixed(6) + " gwei");
  console.log("");

  /* ------------------------------------------------- what it will be built on */

  const token = C.token;
  const chip = C.motherChip;
  if (!token) die("config.js names no token");
  if (!chip) die("config.js names no motherChip");

  const iface = new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function snapshot() view returns (uint256,uint256,uint256,bool,bool,bool)",
    "function spec() view returns (tuple(uint16 gates,uint16 flops,uint16 nets,uint8 dataBits,uint8 stateWords,uint8 inputWords,uint16 instrBits,uint32 romWords,uint32 ramBytes,uint8 regCount,uint16 regsOffset,uint16 pcOffset,uint8 pcBits,uint16 outOffset,uint8 outBits,uint16 ramAddrOffset,uint8 ramAddrBits,uint16 ramWdataOffset,uint8 ramWdataBits,uint16 haltBit,uint16 carryBit,uint16 zeroBit,uint16 ramWeBit))",
  ]);

  async function read(to, fn, args) {
    const ret = await rpc.ethCall({ to, data: iface.encodeFunctionData(fn, args || []) });
    return iface.decodeFunctionResult(fn, ret);
  }

  console.log("What it stands on");
  console.log("=".repeat(62));

  let decimals, symbol;
  try {
    decimals = Number((await read(token, "decimals"))[0]);
    symbol = (await read(token, "symbol"))[0];
  } catch (e) {
    die("the token at " + token + " does not answer decimals() and symbol()");
  }
  console.log("  token           " + token + "  " + symbol + ", " + decimals + " decimals");

  let snap, spec;
  try {
    snap = await read(chip, "snapshot");
    spec = (await read(chip, "spec"))[0];
  } catch (e) {
    die("the chip at " + chip + " does not answer snapshot() and spec()");
  }
  console.log("  chip            " + chip);
  console.log("  silicon         " + spec.gates + " gates, " + spec.flops +
    " flops, " + spec.ramBytes + " bytes of RAM");
  console.log("  at              cycle " + snap[0] + ", pc 0x" +
    Number(snap[1]).toString(16).padStart(3, "0") + ", out " + snap[2] +
    (snap[5] ? ", HALTED" : ""));

  /* A halted chip can never take another edge, so a reserve pointed at one
     would be tokens nobody can ever reach. */
  if (snap[5]) die("that chip has halted. A reserve aimed at it could never pay out.");

  const RATE = RATE_TOKENS * 10n ** BigInt(decimals);
  console.log("");
  console.log("  rate            " + RATE_TOKENS.toLocaleString() + " " + symbol + " per edge");
  console.log("  which is        " + RATE.toString() + " base units");
  console.log("");

  /* ------------------------------------------------------------ the account */

  const key = process.env.STEPPER_KEY;
  let wallet = null;
  console.log("The key");
  console.log("=".repeat(62));
  if (key) {
    wallet = new ethers.Wallet(key);
    console.log("  account         " + wallet.address);
    console.log("  balance         " +
      ethers.formatEther(await rpc.balance(wallet.address)) + " " + C.nativeSymbol);
    const held = (await read(token, "balanceOf", [wallet.address]))[0];
    console.log("  holds           " + ethers.formatUnits(held, decimals) + " " + symbol);
  } else {
    console.log("  STEPPER_KEY is not set, so there is no account to deploy from.");
  }
  console.log("");

  const from = wallet ? wallet.address : "0x" + "11".repeat(20);
  const ctor = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint256"], [token, chip, RATE.toString()]
  );
  const data = art.bytecode + ctor.replace(/^0x/, "");
  const gas = await rpc.estimateGas({ from, data });

  console.log("What it costs");
  console.log("=".repeat(62));
  console.log("  CycleRebate     " + Number(gas).toLocaleString().padStart(12) + " gas   " +
    ((art.deployedBytecode.length - 2) / 2).toLocaleString() + " B deployed");
  console.log("  " + "-".repeat(58));
  console.log("  total           " + Number(gas).toLocaleString().padStart(12) + " gas   " +
    ethers.formatEther(BigInt(gas) * gasPrice) + " " + C.nativeSymbol);
  console.log("");

  if (!go) {
    console.log("Nothing was sent");
    console.log("=".repeat(62));
    console.log("  This was a preflight. Add --go when the numbers above look right.");
    console.log("");
    console.log("  Afterwards, fill it by sending " + symbol + " to the address it reports.");
    console.log("  There is no deposit function because the reserve is the balance.");
    console.log("");
    return;
  }

  if (!wallet) die("STEPPER_KEY is not set, so there is nothing to deploy from");

  const gasLimit = (BigInt(gas) * 13n) / 10n;
  const need = gasLimit * gasPrice;
  const have = BigInt(await rpc.balance(wallet.address));
  if (have < need) {
    die("balance is " + ethers.formatEther(have) + " and this needs about " +
      ethers.formatEther(need) + " with headroom. Nothing was sent.");
  }

  console.log("Sending");
  console.log("=".repeat(62));
  const raw = await wallet.signTransaction({
    data, nonce: Number(await rpc.nonce(wallet.address)), gasLimit, gasPrice,
    chainId: Number(chainId), type: 0, value: 0n,
  });
  const hash = await rpc.send(raw);
  const receipt = await rpc.wait(hash);
  if (!receipt || BigInt(receipt.status) !== 1n) die("the deployment failed: " + hash);

  const at = receipt.contractAddress;
  console.log("  CycleRebate     " + at + "  " +
    Number(receipt.gasUsed).toLocaleString() + " gas");

  /* No constructor holes to allow for: the arguments are immutables, which
     solc writes into the runtime, so the deployed code differs from the
     artifact exactly where those three values sit. Read them back instead. */
  console.log("");
  console.log("Read back");
  console.log("=".repeat(62));
  const back = new ethers.Interface([
    "function TOKEN() view returns (address)",
    "function CHIP() view returns (address)",
    "function RATE() view returns (uint256)",
    "function edgesRemaining() view returns (uint256)",
  ]);
  for (const [fn, want] of [["TOKEN", token], ["CHIP", chip]]) {
    const got = back.decodeFunctionResult(fn,
      await rpc.ethCall({ to: at, data: back.encodeFunctionData(fn) }))[0];
    if (got.toLowerCase() !== want.toLowerCase()) {
      die(fn + "() reads " + got + " and should read " + want);
    }
    console.log("  pass  " + fn + "() is the address it was given");
  }
  const rate = back.decodeFunctionResult("RATE",
    await rpc.ethCall({ to: at, data: back.encodeFunctionData("RATE") }))[0];
  if (rate !== RATE) die("RATE() reads " + rate + " and should read " + RATE);
  console.log("  pass  RATE() is " + ethers.formatUnits(rate, decimals) + " " + symbol);

  const left = back.decodeFunctionResult("edgesRemaining",
    await rpc.ethCall({ to: at, data: back.encodeFunctionData("edgesRemaining") }))[0];
  console.log("  pass  edgesRemaining() is " + left + ", because nothing has been sent to it yet");

  console.log("");
  console.log("  rebate          " + at);
  console.log("  explorer        " + C.explorer + "/address/" + at);
  console.log("");
  console.log("  To fill it, send " + symbol + " to that address. Nothing else works,");
  console.log("  and nothing takes it back out.");
  console.log("");
})().catch((e) => die(e.stack || e.message));
