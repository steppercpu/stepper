#!/usr/bin/env node
/**
 * launchpad-test.js — the R1 contracts, in a real EVM.
 *
 *   npm run launchpad
 *
 * ChipFactory does one thing that cannot be undone and three that cannot be
 * audited from the outside, so all four are checked here before anything is
 * sent anywhere.
 *
 * The one that matters most is the fee recipient. The venue reads a zero
 * recipient as "whoever called me", and whoever calls it is the factory. A
 * factory that passed a zero through would silently become the creator of
 * every token launched on it, collecting fees that belong to somebody else,
 * and nothing about the transaction would look wrong. That is checked first
 * and it is checked with the mock recording what the venue actually received
 * rather than what the factory says it sent.
 *
 * The mocks live in contracts/test/, which `npm run compile` does not read, so
 * they are compiled here and cannot reach a chain.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "contracts");
const OUT = path.join(SRC, "out");

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function artifact(name) {
  const p = path.join(OUT, name + ".json");
  if (!fs.existsSync(p)) die("contracts/out/" + name + ".json is missing. Run `npm run compile`.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The mocks, compiled here so they stay out of the deployed set. */
function compileMocks() {
  const solc = require("solc");
  const entry = "test/Mocks.sol";
  const input = {
    language: "Solidity",
    sources: { [entry]: { content: fs.readFileSync(path.join(SRC, entry), "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const found = (p) => {
    const file = path.join(SRC, "test", p);
    const alt = path.join(SRC, p.replace(/^\.\.\//, ""));
    const use = fs.existsSync(file) ? file : alt;
    if (!fs.existsSync(use)) return { error: "not found: " + p };
    return { contents: fs.readFileSync(use, "utf8") };
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: found }));
  const fatal = (out.errors || []).filter((e) => e.severity === "error");
  if (fatal.length) die("mocks did not compile:\n  " + fatal[0].formattedMessage);
  const pick = (name) => {
    for (const f of Object.keys(out.contracts)) {
      if (out.contracts[f][name]) {
        return {
          name,
          abi: out.contracts[f][name].abi,
          bytecode: "0x" + out.contracts[f][name].evm.bytecode.object,
        };
      }
    }
    die("mock " + name + " not produced");
  };
  return { MockVenue: pick("MockVenue"), MockToken: pick("MockToken") };
}

(async function main() {
  const { VM } = require("@ethereumjs/vm");
  const { Common, Chain, Hardfork } = require("@ethereumjs/common");
  const { Address, Account, hexToBytes, bytesToHex } = require("@ethereumjs/util");

  cli.header("LAUNCHPAD", "the R1 contracts, in an actual EVM");

  const mocks = compileMocks();
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const GAS = 200000000n;

  const CREATOR = Address.fromString("0x1111111111111111111111111111111111111111");
  const OTHER = Address.fromString("0x2222222222222222222222222222222222222222");

  /* Both accounts need a balance: the launch fee is real money in here too. */
  for (const who of [CREATOR, OTHER]) {
    await vm.stateManager.putAccount(who, Account.fromAccountData({ balance: 10n ** 20n }));
  }

  async function deploy(bytecode, ctorArgs, from) {
    const r = await vm.evm.runCall({
      caller: from || CREATOR, origin: from || CREATOR, gasLimit: GAS,
      data: hexToBytes(bytecode + (ctorArgs || "").replace(/^0x/, "")), value: 0n,
    });
    if (r.execResult.exceptionError) {
      die("deploy reverted: " + r.execResult.exceptionError.error);
    }
    return r.createdAddress;
  }

  async function send(to, data, value, from) {
    const r = await vm.evm.runCall({
      caller: from || CREATOR, origin: from || CREATOR, to, gasLimit: GAS,
      data: hexToBytes(data), value: value || 0n,
    });
    return {
      error: r.execResult.exceptionError ? r.execResult.exceptionError.error : null,
      ret: r.execResult.returnValue,
      logs: (r.execResult.logs || []),
      gas: r.execResult.executionGasUsed,
    };
  }

  let bad = 0;
  function check(name, got, want) {
    const ok = typeof want === "function" ? want(got) : String(got) === String(want);
    console.log("  " + (ok ? "pass" : "FAIL") + "  " + name.padEnd(52) +
      (ok ? "" : "got " + JSON.stringify(String(got)).slice(0, 90)));
    if (!ok) bad++;
  }

  /* ------------------------------------------------------------- deploy */

  const arrayArt = artifact("ST8GateArray");
  const factoryArt = artifact("ChipFactory");
  const rendererArt = artifact("ChipRenderer");

  const array = await deploy(arrayArt.bytecode);
  const renderer = await deploy(rendererArt.bytecode);
  const venue = await deploy(mocks.MockVenue.bytecode);

  const abi = new ethers.Interface(factoryArt.abi);
  const rAbi = new ethers.Interface(rendererArt.abi);
  const vAbi = new ethers.Interface(mocks.MockVenue.abi);
  const tAbi = new ethers.Interface(mocks.MockToken.abi);

  const ctor = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [array.toString(), venue.toString(), renderer.toString()]
  );
  const factory = await deploy(factoryArt.bytecode, ctor);

  console.log("");
  console.log("  deployed: gate array, renderer, mock venue, factory");
  console.log("");

  /* The program a launched chip carries: taken from the netlist, not typed. */
  const win = {};
  new Function("window", fs.readFileSync(
    path.join(ROOT, "public/scripts/st8-data.js"), "utf8"))(win);
  const words = win.ST8_DATA.programs.ledger.rom;
  let n = 0;
  for (let i = 0; i < words.length; i++) if (words[i]) n = i + 1;
  let romHex = "";
  for (let i = 0; i < n; i++) romHex += (words[i] >>> 0).toString(16).padStart(8, "0");
  const rom = "0x" + romHex;

  const FEE = 500000000000000n;

  function params(recipient, taxBps) {
    return [
      "Ledger Chip", "LEDG", "ipfs://logo", "a chip that adds what it is sent",
      ["x.com/one", "t.me/one", "discord.gg/one", "one.example", "fc/one"],
      recipient, taxBps, false,
      "0x" + "11".repeat(32), "0x" + "22".repeat(32),
    ];
  }

  /* ------------------------------- the trap: a zero recipient */

  let call = abi.encodeFunctionData("launch",
    [rom, params(ethers.ZeroAddress, 200), 1, ethers.ZeroAddress]);
  let r = await send(factory, call, FEE * 4n);
  check("a launch with a zero fee recipient succeeds", r.error, "null");

  let got = await send(venue, vAbi.encodeFunctionData("lastRecipient"), 0n);
  const recipient = "0x" + bytesToHex(got.ret).slice(-40);
  check("and the venue is told the CREATOR, never the factory",
    recipient.toLowerCase(), CREATOR.toString().toLowerCase());
  check("which is not the factory",
    recipient.toLowerCase() !== factory.toString().toLowerCase(), "true");

  /* ------------------------------- the record, and the deed */

  const decoded = abi.decodeFunctionResult("launch", r.ret);
  const id = decoded[0], chip = decoded[1], token = decoded[2];
  check("the chip is numbered one", id.toString(), "1");
  check("a chip was deployed", chip !== ethers.ZeroAddress, "true");

  got = await send(factory, abi.encodeFunctionData("ownerOf", [1]), 0n);
  check("the deed is minted to the creator",
    ("0x" + bytesToHex(got.ret).slice(-40)).toLowerCase(),
    CREATOR.toString().toLowerCase());

  got = await send(factory, abi.encodeFunctionData("idOfChip", [chip]), 0n);
  check("the chip address maps back to its id", BigInt(bytesToHex(got.ret)).toString(), "1");

  got = await send(factory, abi.encodeFunctionData("records", [1]), 0n);
  const rec = abi.decodeFunctionResult("records", got.ret);
  check("the record names the token", rec[1].toLowerCase(), token.toLowerCase());
  check("and the creator", rec[3].toLowerCase(), CREATOR.toString().toLowerCase());

  /* ------------------------------- the chip really is a processor */

  const chipAddr = Address.fromString(chip);
  const chipAbi = new ethers.Interface(artifact("Chip").abi);
  got = await send(chipAddr, chipAbi.encodeFunctionData("step", [42]), 0n);
  check("the launched chip takes a clock edge", got.error, "null");
  got = await send(chipAddr, chipAbi.encodeFunctionData("snapshot"), 0n);
  const snap = chipAbi.decodeFunctionResult("snapshot", got.ret);
  check("and its cycle counter moved", snap[0].toString(), "1");

  /* ------------------------------- the sweep */

  const tokenAddr = Address.fromString(token);
  got = await send(tokenAddr, tAbi.encodeFunctionData("balanceOf", [factory.toString()]), 0n);
  check("the factory keeps none of the opening buy",
    BigInt(bytesToHex(got.ret)).toString(), "0");

  got = await send(tokenAddr, tAbi.encodeFunctionData("balanceOf", [CREATOR.toString()]), 0n);
  check("the creator has all of it", BigInt(bytesToHex(got.ret)) > 0n, "true");

  const factoryAcct = await vm.stateManager.getAccount(factory);
  check("and the factory holds no ether at all",
    (factoryAcct ? factoryAcct.balance : 0n).toString(), "0");

  /* ------------------------------- what must fail */

  call = abi.encodeFunctionData("launch", [rom, params(ethers.ZeroAddress, 200), 1, ethers.ZeroAddress]);
  r = await send(factory, call, FEE - 1n);
  check("a launch under the fee is refused", r.error !== null, "true");

  r = await send(factory, abi.encodeFunctionData("launch",
    ["0x", params(ethers.ZeroAddress, 200), 1, ethers.ZeroAddress]), FEE);
  check("a launch with an empty ROM is refused", r.error !== null, "true");

  await send(venue, vAbi.encodeFunctionData("setAllow", [false]), 0n);
  r = await send(factory, call, FEE);
  check("a venue that says no is believed", r.error !== null, "true");
  await send(venue, vAbi.encodeFunctionData("setAllow", [true]), 0n);

  /* ------------------------------- a second launch, by somebody else */

  r = await send(factory, abi.encodeFunctionData("launch",
    [rom, params(OTHER.toString(), 500), 7, ethers.ZeroAddress]), FEE * 2n, OTHER);
  check("a second creator can launch", r.error, "null");

  got = await send(factory, abi.encodeFunctionData("total"), 0n);
  check("the count is two", BigInt(bytesToHex(got.ret)).toString(), "2");

  got = await send(venue, vAbi.encodeFunctionData("lastTax"), 0n);
  check("their own tax was passed through", BigInt(bytesToHex(got.ret)).toString(), "500");

  got = await send(venue, vAbi.encodeFunctionData("lastTelegram"), 0n);
  check("and their socials, in the venue's own order",
    ethers.AbiCoder.defaultAbiCoder().decode(["string"], bytesToHex(got.ret))[0], "t.me/one");

  got = await send(venue, vAbi.encodeFunctionData("lastConfigId"), 0n);
  check("with the launch config they chose", BigInt(bytesToHex(got.ret)).toString(), "7");

  /* ------------------------------- the card */

  got = await send(factory, abi.encodeFunctionData("tokenURI", [1]), 0n);
  const uri = abi.decodeFunctionResult("tokenURI", got.ret)[0];
  check("tokenURI is a data URI", uri.startsWith("data:application/json;base64,"), "true");

  const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
  check("the card names the chip", json.name, "STEPPER Chip #1");
  check("and carries an SVG, not a link",
    (json.image || "").startsWith("data:image/svg+xml;base64,"), "true");

  const svg = Buffer.from(json.image.split(",")[1], "base64").toString("utf8");
  check("the SVG closes", svg.trim().endsWith("</svg>"), "true");
  check("it draws 160 gates", (svg.match(/rx="3"/g) || []).length, 160);
  check("the chip address is on the card",
    svg.indexOf(chip.slice(2, 6).toLowerCase()) > 0, "true");

  const outDir = path.join(ROOT, "contracts", "out");
  fs.writeFileSync(path.join(outDir, "card-preview.svg"), svg);
  console.log("");
  console.log("  wrote contracts/out/card-preview.svg — open it to see the card");

  console.log("");
  if (bad) {
    console.log("  " + bad + " failing. Nothing about this is ready to deploy.");
    process.exit(1);
  }
  console.log("  the launchpad contracts do what they say");
  process.exit(0);
})().catch((e) => {
  console.error("launchpad-test: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
