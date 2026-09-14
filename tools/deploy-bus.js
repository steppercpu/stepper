#!/usr/bin/env node
/**
 * deploy-bus.js — a port, and the bus that clocks a chip through it.
 *
 *   npm run deploy-bus -- --feed 0x... --lo 250000000000 --hi 320000000000
 *   npm run deploy-bus -- --feed 0x... --lo ... --hi ... --go
 *
 * Without `--go` it reads, prices and prints, and sends nothing.
 *
 * Every constructor argument is checked against the chain before it is used,
 * because two of them can never be changed afterwards. The window decides how
 * the eight bits are spent for the life of the port, and the device decides
 * what the processor senses for the life of the bus. A deployment that got
 * either wrong would not be repairable; it would be replaceable, which is a
 * different and more expensive thing.
 *
 * Needs STEPPER_KEY in the environment. It is never read from a file and never
 * passed on a command line.
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

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** An hour. Long enough for a feed that publishes on deviation to be quiet. */
const DEFAULT_MAX_AGE = 3600n;

(async function main() {
  const go = process.argv.includes("--go");
  cli.header("BUS", "a chip, wired to something it did not build");

  const C = config();
  const rpc = client(C.rpc);

  const feed = arg("feed", null);
  const chip = arg("chip", C.motherChip);
  const lo = arg("lo", null);
  const hi = arg("hi", null);
  const maxAge = BigInt(arg("max-age", DEFAULT_MAX_AGE.toString()));

  if (!feed) die("--feed is required. `npm run feeds` lists what this chain publishes.");
  if (lo === null || hi === null) die("--lo and --hi are required. `npm run feeds` proposes both.");
  if (!chip) die("config.js names no motherChip and --chip was not given");

  const LO = BigInt(lo);
  const HI = BigInt(hi);
  if (HI <= LO) die("the window is empty: --hi must be above --lo");

  const chainId = await rpc.chainId();
  const block = await rpc.blockNumber();

  /* Priced off the head rather than a quote, for the reason the other deploy
     scripts carry: this chain's base fee drifts between the quote and the
     submission, and a transaction priced from a stale quote is refused. */
  const head = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(head.baseFeePerGas || "0x0");
  const quoted = BigInt(await rpc.gasPrice());
  const gasPrice = ((quoted > baseFee ? quoted : baseFee) * 15n) / 10n;

  console.log("  chain           " + chainId + " at block " + block.toLocaleString("en-US"));
  console.log("  gas price       " + (Number(gasPrice) / 1e9).toFixed(6) + " gwei");
  console.log("");

  const iface = new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
    "function latestRoundData() view returns (uint80,int256,uint80,uint256,uint80)",
    "function snapshot() view returns (uint256,uint256,uint256,bool,bool,bool)",
    "function spec() view returns (tuple(uint16 gates,uint16 flops,uint16 nets,uint8 dataBits,uint8 stateWords,uint8 inputWords,uint16 instrBits,uint32 romWords,uint32 ramBytes,uint8 regCount,uint16 regsOffset,uint16 pcOffset,uint8 pcBits,uint16 outOffset,uint8 outBits,uint16 ramAddrOffset,uint8 ramAddrBits,uint16 ramWdataOffset,uint8 ramWdataBits,uint16 haltBit,uint16 carryBit,uint16 zeroBit,uint16 ramWeBit))",
  ]);

  async function read(to, fn, args) {
    const ret = await rpc.ethCall({ to, data: iface.encodeFunctionData(fn, args || []) });
    return iface.decodeFunctionResult(fn, ret);
  }

  /* ------------------------------------------------------------- the source */

  console.log("What it will sense");
  console.log("=".repeat(62));

  let decimals, description, round;
  try {
    decimals = Number((await read(feed, "decimals"))[0]);
    description = (await read(feed, "description"))[0];
    round = await read(feed, "latestRoundData");
  } catch (e) {
    die("the address at " + feed + " does not answer decimals(), description() " +
      "and latestRoundData(). A port wired to it could never read anything.");
  }

  const answer = BigInt(round[1]);
  const updatedAt = Number(round[3]);
  const now = Math.floor(Date.now() / 1000);
  const age = now - updatedAt;
  const unit = 10 ** decimals;

  console.log("  feed            " + feed);
  console.log("  prices          " + description + ", " + decimals + " decimals");
  console.log("  now             " + (Number(answer) / unit).toLocaleString("en-US",
    { maximumFractionDigits: 4 }) + "   (" + age + "s old)");

  if (answer <= 0n) die("that feed is answering zero or less. There is nothing to convert.");
  if (updatedAt === 0) die("that feed has never closed a round.");
  if (BigInt(age) > maxAge) {
    die("that reading is already older than the max age this port would enforce (" +
      maxAge + "s). The clock would be stopped from the moment it was deployed.");
  }

  /* -------------------------------------------------------------- the window */

  console.log("");
  console.log("How the eight bits are spent");
  console.log("=".repeat(62));

  const span = HI - LO;
  const step = Number(span) / 255 / unit;
  const byteNow = answer <= LO ? 0
    : answer >= HI ? 255
    : Number((answer - LO) * 255n / span);

  console.log("  window          " + (Number(LO) / unit).toLocaleString("en-US",
    { maximumFractionDigits: 4 }) + "  to  " + (Number(HI) / unit).toLocaleString("en-US",
    { maximumFractionDigits: 4 }));
  console.log("  one step        " + step.toLocaleString("en-US", { maximumFractionDigits: 6 }));
  console.log("  today arrives   as byte " + byteNow + " of 255");
  console.log("  stale after     " + maxAge + "s");

  /* A window the price already sits outside is a port that reports the same
     byte whatever happens, which is a converter that has stopped converting.
     It is legal and it is almost certainly a typo, so it is refused here
     rather than discovered later. */
  if (answer <= LO || answer >= HI) {
    die("the current reading is outside that window, so the port would be " +
      "pinned at " + byteNow + " from the start. Check --lo and --hi.");
  }
  if (byteNow < 16 || byteNow > 239) {
    console.log("");
    console.log("  Note: the price sits near the end of this window. There is room");
    console.log("  for it to move one way and very little the other.");
  }

  /* ---------------------------------------------------------------- the chip */

  console.log("");
  console.log("What it will clock");
  console.log("=".repeat(62));

  let snap, spec;
  try {
    snap = await read(chip, "snapshot");
    spec = (await read(chip, "spec"))[0];
  } catch (e) {
    die("the chip at " + chip + " does not answer snapshot() and spec()");
  }

  console.log("  chip            " + chip);
  console.log("  silicon         " + spec.gates + " gates, " + spec.flops + " flops, " +
    spec.ramBytes + " bytes of RAM");
  console.log("  ports           in " + spec.dataBits + " bits, out " + spec.outBits + " bits");
  console.log("  at              cycle " + snap[0] + ", pc 0x" +
    Number(snap[1]).toString(16).padStart(3, "0") + ", out " + snap[2] +
    (snap[5] ? ", HALTED" : ""));

  if (snap[5]) die("that chip has halted. A bus aimed at it could never take an edge.");
  if (Number(spec.outBits) > 8) {
    die("that chip's output port is " + spec.outBits + " bits. The bus carries a byte " +
      "and refuses to truncate, so it would not deploy against this chip.");
  }
  if (Number(spec.dataBits) < 8) {
    die("that chip's input port is narrower than a byte, so a sample would not fit.");
  }

  /* ------------------------------------------------------------- the account */

  console.log("");
  console.log("What it costs");
  console.log("=".repeat(62));

  const portArt = artifact("FeedPort");
  const busArt = artifact("Bus");
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const portData = portArt.bytecode + coder.encode(
    ["address", "int256", "int256", "uint256"], [feed, LO, HI, maxAge]).slice(2);

  const key = process.env.STEPPER_KEY;
  let wallet = null;
  if (key) {
    wallet = new ethers.Wallet(key);
    console.log("  account         " + wallet.address);
    console.log("  balance         " +
      ethers.formatEther(await rpc.balance(wallet.address)) + " " + C.nativeSymbol);
  } else {
    console.log("  STEPPER_KEY is not set, so there is no account to deploy from.");
  }

  const from = wallet ? wallet.address : "0x" + "11".repeat(20);
  const nonce = wallet ? Number(await rpc.nonce(wallet.address)) : 0;

  /* The bus takes the port as an argument, so the port's address has to be
     known before the bus is built. It is a CREATE address, which is a
     consequence of the sender and the nonce and nothing else. */
  const portAddr = ethers.getCreateAddress({ from, nonce });
  const busData = busArt.bytecode + coder.encode(
    ["address", "address"], [chip, portAddr]).slice(2);

  let portGas, busGas;
  try {
    portGas = BigInt(await rpc.estimateGas({ from, data: portData }));
  } catch (e) {
    die("the port would not deploy: " + String(e.message).slice(0, 120));
  }
  /* The bus cannot be estimated before the port exists, because its
     constructor reads the chip and would pass, but the port address is empty
     code until the first transaction lands. Estimated from the port's own
     figure plus the bus code, and sent with headroom. */
  busGas = BigInt(Math.ceil((busArt.bytecode.length / 2) * 220)) + 600000n;

  const portLimit = (portGas * 12n) / 10n;
  const busLimit = busGas;
  const total = (portLimit + busLimit) * gasPrice;

  console.log("  port            " + portAddr + "  (" + portGas.toLocaleString("en-US") + " gas)");
  console.log("  bus             deployed second, at nonce " + (nonce + 1));
  console.log("  total           ~" + ethers.formatEther(total) + " " + C.nativeSymbol);

  if (!go) {
    console.log("");
    console.log("  Nothing was sent. Add --go to deploy.");
    console.log("");
    return;
  }

  if (!wallet) die("STEPPER_KEY is not set, so there is nothing to deploy from");

  const have = BigInt(await rpc.balance(wallet.address));
  if (have < total) {
    die("balance is " + ethers.formatEther(have) + " and this needs about " +
      ethers.formatEther(total));
  }

  /* ------------------------------------------------------------------- send */

  console.log("");
  console.log("Sending");
  console.log("=".repeat(62));

  async function send(data, gasLimit, at) {
    const raw = await wallet.signTransaction({
      data, nonce: at, gasLimit, gasPrice, chainId: Number(chainId), type: 0,
    });
    const hash = await rpc.send(raw);
    console.log("  " + hash);
    for (let i = 0; i < 60; i++) {
      const r = await rpc.call("eth_getTransactionReceipt", [hash]);
      if (r) {
        if (BigInt(r.status) !== 1n) die("that transaction reverted: " + hash);
        return r.contractAddress;
      }
      await new Promise((s) => setTimeout(s, 1000));
    }
    die("no receipt after 60 seconds for " + hash);
  }

  const port = await send(portData, portLimit, nonce);
  console.log("  port            " + port);
  if (port.toLowerCase() !== portAddr.toLowerCase()) {
    die("the port landed at " + port + " but the bus was built for " + portAddr);
  }

  const bus = await send(busData, busLimit, nonce + 1);
  console.log("  bus             " + bus);

  console.log("");
  console.log("  Add both to public/scripts/config.js and docs/addresses.md.");
  console.log("  The clock is open: anyone may call tick(), and preview() says");
  console.log("  what the next edge will do before anybody pays for it.");
  console.log("");
})().catch((e) => {
  process.stderr.write("\n  " + e.message + "\n\n");
  process.exit(1);
});
