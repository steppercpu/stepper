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
  return {
    MockVenue: pick("MockVenue"),
    MockToken: pick("MockToken"),
    MockSpecChip: pick("MockSpecChip"),
  };
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

  /* Can anybody actually call it?
   *
   * Every check in this file runs with GAS set to 200,000,000, which is about
   * seven times an Ethereum block and far more than any eth_call will allow.
   * That limit exists so a test never fails for an uninteresting reason, and
   * it had the effect of hiding the most interesting failure available: a card
   * that is correct and too expensive to read.
   *
   * A wallet, a marketplace and an explorer all reach tokenURI through
   * eth_call, and node operators cap that. 30,000,000 is a generous reading of
   * what is safe to assume. Past it the card is not slow, it is invisible. */
  const URI_GAS_CEILING = 30000000n;
  check("and cheap enough for an eth_call to return it",
    got.gas <= URI_GAS_CEILING,
    () => got.gas <= URI_GAS_CEILING);
  console.log("        tokenURI costs " + got.gas.toLocaleString() +
    " gas for " + uri.length.toLocaleString() + " characters");

  const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
  check("the card names the chip", json.name, "STEPPER Chip #1");
  check("and carries an SVG, not a link",
    (json.image || "").startsWith("data:image/svg+xml;base64,"), "true");

  const svg = Buffer.from(json.image.split(",")[1], "base64").toString("utf8");
  check("the SVG closes", svg.trim().endsWith("</svg>"), "true");
  check("it draws 160 gates", (svg.match(/rx="3"/g) || []).length, 160);
  check("the chip address is on the card",
    svg.indexOf(chip.slice(2, 6).toLowerCase()) > 0, "true");

  /* The card, for a generation that is not ST-8.
   *
   * Every check above passes against a renderer that carries the ST-8 figures
   * as literals, because for an ST-8 chip the two are indistinguishable. This
   * is the one that separates them: a chip that reports 3,787 gates over a
   * 16-bit datapath has to produce a card that says so. An earlier renderer
   * would have minted it as an 8-bit processor with 2,161 gates, and nothing
   * in the suite would have noticed. */
  const specChipCtor = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint16", "uint16", "uint8"], [3787, 311, 16]
  );
  const specChip = await deploy(mocks.MockSpecChip.bytecode, specChipCtor);
  got = await send(renderer, rAbi.encodeFunctionData("render", [
    7, specChip.toString(), token, CREATOR.toString(), 1757000000,
  ]), 0n);
  const uri16 = rAbi.decodeFunctionResult("render", got.ret)[0];
  const card16 = JSON.parse(Buffer.from(uri16.split(",")[1], "base64").toString("utf8"));
  const trait = (n) => (card16.attributes.find((a) => a.trait_type === n) || {}).value;

  check("a 16-bit chip is not called ST-8", trait("Generation"), "ST-16");
  check("its gate count is the chip's own", trait("NAND gates"), 3787);
  check("and its flip-flop count", trait("Flip-flops"), 311);
  check("the description says 16-bit",
    card16.description.indexOf("A real 16-bit processor") === 0, "true");
  const svg16 = Buffer.from(card16.image.split(",")[1], "base64").toString("utf8");
  check("the die is labelled for its generation",
    svg16.indexOf("ST-16 &#183; 3787 NAND") > 0, "true");

  /* ------------------------- the whole ST-16 path, end to end
   *
   * `npm run evm` proves ST-16 at the gate level and `npm run st16` proves it
   * against a model, but nothing has ever run the factory and ST-16 together.
   * That combination is what a second deployment would be, and it is worth
   * knowing it works before any of it is paid for on a chain.
   *
   * No contract changes for it: ChipFactory already takes its gate array in
   * the constructor, so a second generation is a second deployment and not a
   * second factory to write.
   *
   * The same ROM serves both. An instruction word is 25 bits regardless of
   * datapath width — [24:20] op, [19:16] rd, [15:12] rs, [11:0] imm — so the
   * ledger program assembled for ST-8 is a valid ST-16 program. */

  const array16 = await deploy(artifact("ST16GateArray").bytecode);
  const ctor16 = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [array16.toString(), venue.toString(), renderer.toString()]
  );
  const factory16 = await deploy(factoryArt.bytecode, ctor16);

  r = await send(factory16, abi.encodeFunctionData("launch",
    [rom, params(ethers.ZeroAddress, 200), 1, ethers.ZeroAddress]), FEE * 4n);
  check("a 16-bit chip launches through the same factory code", r.error, "null");

  const d16 = abi.decodeFunctionResult("launch", r.ret);
  const chip16 = Address.fromString(d16[1]);

  got = await send(chip16, chipAbi.encodeFunctionData("spec"), 0n);
  const s16 = chipAbi.decodeFunctionResult("spec", got.ret)[0];
  check("it reports a 16-bit datapath", s16.dataBits.toString(), "16");
  check("and 3,787 gates", s16.gates.toString(), "3787");

  got = await send(chip16, chipAbi.encodeFunctionData("step", [4242]), 0n);
  check("it takes a clock edge on a value no 8-bit chip could hold",
    got.error, "null");
  got = await send(chip16, chipAbi.encodeFunctionData("snapshot"), 0n);
  check("and its cycle counter moved",
    chipAbi.decodeFunctionResult("snapshot", got.ret)[0].toString(), "1");

  got = await send(factory16, abi.encodeFunctionData("tokenURI", [1]), 0n);
  const card = JSON.parse(Buffer.from(
    abi.decodeFunctionResult("tokenURI", got.ret)[0].split(",")[1], "base64"
  ).toString("utf8"));
  check("and its card describes the processor it actually is",
    (card.attributes.find((a) => a.trait_type === "Generation") || {}).value, "ST-16");

  /* ----------------------- the rebate, against a chip the factory made
   *
   * npm run rebate proves CycleRebate's behaviour against mocks, which is the
   * right place for the awkward cases: a token that calls back, a token that
   * takes a fee, a token that returns nothing.
   *
   * What a mock cannot prove is that a chip the real factory built answers
   * `step` and `snapshot` the way the rebate calls through them. Three
   * interfaces meet here and nowhere else. */

  const rebateArt = artifact("CycleRebate");
  const fuelToken = await deploy(mocks.MockToken.bytecode);
  const RATE = 1000n;
  const rebate = await deploy(rebateArt.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint256"],
    [fuelToken.toString(), chip, RATE.toString()]
  ));
  const rbAbi = new ethers.Interface(rebateArt.abi);

  await send(fuelToken, tAbi.encodeFunctionData("mint", [rebate.toString(), 5n * RATE]), 0n);

  got = await send(chipAddr, chipAbi.encodeFunctionData("snapshot"), 0n);
  const before = chipAbi.decodeFunctionResult("snapshot", got.ret)[0];

  r = await send(rebate, rbAbi.encodeFunctionData("fuel", [7]), 0n, OTHER);
  check("a real chip can be fuelled through the rebate", r.error, "null");

  got = await send(chipAddr, chipAbi.encodeFunctionData("snapshot"), 0n);
  check("and it advanced one cycle",
    chipAbi.decodeFunctionResult("snapshot", got.ret)[0].toString(),
    (before + 1n).toString());

  got = await send(fuelToken, tAbi.encodeFunctionData("balanceOf", [OTHER.toString()]), 0n);
  check("whoever asked for the edge was paid",
    BigInt(bytesToHex(got.ret)).toString(), RATE.toString());

  /* The chip is named at construction, so there is no argument to point
     anywhere else and nothing to check beyond that there is not one. */
  const fuelFn = rebateArt.abi.find((f) => f.type === "function" && f.name === "fuel");
  check("and the rebate has no way to be aimed at another chip",
    fuelFn.inputs.length, 1);

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
