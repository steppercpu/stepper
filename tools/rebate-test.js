#!/usr/bin/env node
/**
 * rebate-test.js — CycleRebate, in an actual EVM.
 *
 *   npm run rebate
 *
 * The contract pays somebody for making a chip take a clock edge. Four things
 * have to hold, and each of them is the kind of claim that is cheap to write
 * in a comment and expensive to be wrong about:
 *
 *   1. it pays the caller, and only for work that actually happened
 *   2. a thing that is not a chip cannot be used to drain it
 *   3. an empty reserve never stops a cycle -- it just stops paying
 *   4. there is no withdrawal path at all, so nobody can empty it, including
 *      whoever deployed it
 *
 * The fourth is checked against the ABI rather than by trying the functions we
 * happen to remember writing. A withdrawal somebody adds later would pass a
 * test that only knows about today's function names.
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
    MockToken: pick("MockToken"),
    MockChip: pick("MockChip"),
    FreeStep: pick("FreeStep"),
    MockChipRegistry: pick("MockChipRegistry"),
  };
}

(async function main() {
  const { VM } = require("@ethereumjs/vm");
  const { Common, Chain, Hardfork } = require("@ethereumjs/common");
  const { Address, Account, hexToBytes, bytesToHex } = require("@ethereumjs/util");

  cli.header("REBATE", "CycleRebate, in an actual EVM");

  const mocks = compileMocks();
  const rebateArt = artifact("CycleRebate");
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const GAS = 30000000n;

  const DEPLOYER = Address.fromString("0x1111111111111111111111111111111111111111");
  const ANYONE = Address.fromString("0x2222222222222222222222222222222222222222");
  const GREEDY = Address.fromString("0x3333333333333333333333333333333333333333");

  for (const who of [DEPLOYER, ANYONE, GREEDY]) {
    await vm.stateManager.putAccount(who, Account.fromAccountData({ balance: 10n ** 20n }));
  }

  async function deploy(bytecode, args, from) {
    const r = await vm.evm.runCall({
      caller: from || DEPLOYER, origin: from || DEPLOYER, gasLimit: GAS,
      data: hexToBytes(bytecode + (args || "").replace(/^0x/, "")), value: 0n,
    });
    if (r.execResult.exceptionError) die("deploy reverted: " + r.execResult.exceptionError.error);
    return r.createdAddress;
  }

  async function send(to, data, from) {
    const r = await vm.evm.runCall({
      caller: from || ANYONE, origin: from || ANYONE, to, gasLimit: GAS,
      data: hexToBytes(data), value: 0n,
    });
    return {
      error: r.execResult.exceptionError ? r.execResult.exceptionError.error : null,
      ret: r.execResult.returnValue,
      logs: r.execResult.logs || [],
    };
  }

  let bad = 0;
  function check(name, got, want) {
    const ok = typeof want === "function" ? want(got) : String(got) === String(want);
    console.log("  " + (ok ? "pass" : "FAIL") + "  " + name.padEnd(54) +
      (ok ? "" : "got " + JSON.stringify(String(got)).slice(0, 80)));
    if (!ok) bad++;
  }

  /* ------------------------------------------------------------- the set */

  const tokenAbi = new ethers.Interface(mocks.MockToken.abi);
  const chipAbi = new ethers.Interface(mocks.MockChip.abi);
  const regAbi = new ethers.Interface(mocks.MockChipRegistry.abi);
  const abi = new ethers.Interface(rebateArt.abi);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const token = await deploy(mocks.MockToken.bytecode);
  const registry = await deploy(mocks.MockChipRegistry.bytecode);
  const chip = await deploy(mocks.MockChip.bytecode);
  const impostor = await deploy(mocks.FreeStep.bytecode);

  await send(registry, regAbi.encodeFunctionData("add", [chip.toString()]));

  const RATE = 1000n;
  const rebate = await deploy(rebateArt.bytecode, coder.encode(
    ["address", "address", "uint256"],
    [token.toString(), registry.toString(), RATE.toString()]
  ));

  console.log("");
  console.log("  deployed: token, registry, chip, impostor, rebate");
  console.log("");

  /* -------------------------------------- 1. it pays for work that happened */

  await send(token, tokenAbi.encodeFunctionData("mint", [rebate.toString(), 10n * RATE]));

  let got = await send(rebate, abi.encodeFunctionData("edgesRemaining"), 0n);
  check("the reserve says how many edges it can pay for",
    BigInt(bytesToHex(got.ret)).toString(), "10");

  let r = await send(rebate, abi.encodeFunctionData("fuel", [chip.toString(), 42]), ANYONE);
  check("fuel() succeeds against a registered chip", r.error, "null");

  got = await send(chip, chipAbi.encodeFunctionData("cycle"), 0n);
  check("and the chip actually advanced", BigInt(bytesToHex(got.ret)).toString(), "1");

  got = await send(chip, chipAbi.encodeFunctionData("lastIn"), 0n);
  check("carrying the byte it was given", BigInt(bytesToHex(got.ret)).toString(), "42");

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [ANYONE.toString()]), 0n);
  check("the caller was paid the rate", BigInt(bytesToHex(got.ret)).toString(), RATE.toString());

  got = await send(rebate, abi.encodeFunctionData("edges"), 0n);
  check("one edge is counted", BigInt(bytesToHex(got.ret)).toString(), "1");
  got = await send(rebate, abi.encodeFunctionData("paid"), 0n);
  check("and the payment is counted", BigInt(bytesToHex(got.ret)).toString(), RATE.toString());

  /* The property the contract's own comment admits to: the chip records the
     rebate as its sponsor, because a chip records msg.sender and that is what
     msg.sender is. Somebody who wants their own address in the chip's log has
     to call the chip directly. Checked here so the documentation cannot drift
     away from the behaviour. */
  got = await send(chip, chipAbi.encodeFunctionData("lastSponsor"), 0n);
  check("the chip records the rebate as sponsor, not the caller",
    ("0x" + bytesToHex(got.ret).slice(-40)).toLowerCase(),
    rebate.toString().toLowerCase());

  check("and the rebate's own log names the caller instead",
    r.logs.length > 0 && bytesToHex(r.logs[0][1][1]).slice(-40).toLowerCase() ===
      ANYONE.toString().slice(2).toLowerCase(),
    "true");

  /* ------------------------------------------ 2. a non-chip cannot drain it */

  r = await send(rebate, abi.encodeFunctionData("fuel", [impostor.toString(), 1]), GREEDY);
  check("a thing the registry never made is refused", r.error !== null, "true");

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [GREEDY.toString()]), 0n);
  check("and it was paid nothing", BigInt(bytesToHex(got.ret)).toString(), "0");

  /* ------------------------------------- 3. an empty reserve still steps */

  for (let i = 0; i < 9; i++) {
    await send(rebate, abi.encodeFunctionData("fuel", [chip.toString(), 1]), ANYONE);
  }
  got = await send(rebate, abi.encodeFunctionData("edgesRemaining"), 0n);
  check("the reserve runs out", BigInt(bytesToHex(got.ret)).toString(), "0");

  const beforeCycle = BigInt(bytesToHex(
    (await send(chip, chipAbi.encodeFunctionData("cycle"), 0n)).ret));

  r = await send(rebate, abi.encodeFunctionData("fuel", [chip.toString(), 7]), GREEDY);
  check("an empty reserve does not stop a cycle", r.error, "null");

  got = await send(chip, chipAbi.encodeFunctionData("cycle"), 0n);
  check("the chip advanced anyway",
    BigInt(bytesToHex(got.ret)).toString(), (beforeCycle + 1n).toString());

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [GREEDY.toString()]), 0n);
  check("and paid nothing for it", BigInt(bytesToHex(got.ret)).toString(), "0");

  got = await send(rebate, abi.encodeFunctionData("paid"), 0n);
  check("the total paid stops at what the reserve held",
    BigInt(bytesToHex(got.ret)).toString(), (10n * RATE).toString());

  /* ------------------------------------------- 4. there is no way out of it */

  console.log("");

  const MOVERS = /withdraw|sweep|rescue|drain|collect|claim|transfer|send|recover|skim|emergency/i;
  const suspects = rebateArt.abi.filter((f) =>
    f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure");

  check("exactly one function can change anything",
    suspects.length, 1);
  check("and it is fuel()", suspects.length === 1 ? suspects[0].name : "-", "fuel");

  const named = rebateArt.abi.filter((f) => f.type === "function" && MOVERS.test(f.name));
  check("no function in the ABI is named for moving money",
    named.map((f) => f.name).join(",") || "none", "none");

  const owners = rebateArt.abi.filter((f) =>
    f.type === "function" && /owner|admin|steward|pause|setRate|setToken|setRegistry/i.test(f.name));
  check("and none for owning or pausing it",
    owners.map((f) => f.name).join(",") || "none", "none");

  const payable = rebateArt.abi.filter((f) =>
    (f.type === "function" || f.type === "receive" || f.type === "fallback") &&
    f.stateMutability === "payable");
  check("it cannot take ether either", payable.length, 0);

  /* The deployer has no more power than anybody else. Proven rather than
     asserted: the same call, from the address that created the contract. */
  await send(token, tokenAbi.encodeFunctionData("mint", [rebate.toString(), RATE]));
  for (const f of ["withdraw()", "sweep()", "rescue()", "transferOwnership(address)"]) {
    const sel = ethers.id(f).slice(0, 10);
    r = await send(rebate, sel, DEPLOYER);
    check("the deployer calling " + f.padEnd(26) + "reverts", r.error !== null, "true");
  }

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [rebate.toString()]), 0n);
  check("and the reserve is untouched", BigInt(bytesToHex(got.ret)).toString(), RATE.toString());

  console.log("");
  if (bad) {
    console.log("  " + bad + " failing. Nothing about this is ready to deploy.");
    process.exit(1);
  }
  console.log("  the rebate pays for work, and nobody can take it back out.");
  console.log("");
})().catch((e) => die(e.stack || e.message));
