#!/usr/bin/env node
/**
 * rebate-test.js — CycleRebate, in an actual EVM.
 *
 *   npm run rebate
 *
 * The contract pays somebody for making one chip take a clock edge. The
 * things that have to hold are mostly about what it refuses:
 *
 *   1. it pays the caller, and only for work that actually happened
 *   2. it advances one chip and there is no way to point it at another
 *   3. a token that calls back cannot be paid twice for one edge
 *   4. the counters record what moved, not what was intended
 *   5. an empty reserve never stops a cycle -- it just stops paying
 *   6. there is no withdrawal path at all, so nobody can empty it, including
 *      whoever deployed it
 *
 * The last one is checked against the ABI rather than by trying the function
 * names we happen to remember writing. A withdrawal somebody adds later would
 * pass a test that only knows about today's names.
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
    ReentrantToken: pick("ReentrantToken"),
    FeeToken: pick("FeeToken"),
    SilentToken: pick("SilentToken"),
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
    console.log("  " + (ok ? "pass" : "FAIL") + "  " + name.padEnd(56) +
      (ok ? "" : "got " + JSON.stringify(String(got)).slice(0, 70)));
    if (!ok) bad++;
  }

  const abi = new ethers.Interface(rebateArt.abi);
  const tokenAbi = new ethers.Interface(mocks.MockToken.abi);
  const chipAbi = new ethers.Interface(mocks.MockChip.abi);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const RATE = 1000n;

  const num = (r) => BigInt(bytesToHex(r.ret || "0x0") || "0x0");

  /** A rebate over a fresh chip and whichever token is asked for. */
  async function build(tokenArt) {
    const token = await deploy(tokenArt.bytecode);
    const chip = await deploy(mocks.MockChip.bytecode);
    const rebate = await deploy(rebateArt.bytecode, coder.encode(
      ["address", "address", "uint256"],
      [token.toString(), chip.toString(), RATE.toString()]
    ));
    return { token, chip, rebate };
  }

  /* --------------------------------------- 1. it pays for work that happened */

  let { token, chip, rebate } = await build(mocks.MockToken);
  await send(token, tokenAbi.encodeFunctionData("mint", [rebate.toString(), 10n * RATE]));

  console.log("");
  console.log("  deployed: token, chip, rebate");
  console.log("");

  let got = await send(rebate, abi.encodeFunctionData("edgesRemaining"));
  check("the reserve says how many edges it can pay for", num(got), 10n);

  let r = await send(rebate, abi.encodeFunctionData("fuel", [42]), ANYONE);
  check("fuel() succeeds", r.error, "null");

  got = await send(chip, chipAbi.encodeFunctionData("cycle"));
  check("and the chip actually advanced", num(got), 1n);

  got = await send(chip, chipAbi.encodeFunctionData("lastIn"));
  check("carrying the byte it was given", num(got), 42n);

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [ANYONE.toString()]));
  check("the caller was paid the rate", num(got), RATE);

  got = await send(rebate, abi.encodeFunctionData("edges"));
  check("one edge is counted", num(got), 1n);
  got = await send(rebate, abi.encodeFunctionData("paid"));
  check("and the payment is counted", num(got), RATE);

  /* The property the contract's own comment admits to. */
  got = await send(chip, chipAbi.encodeFunctionData("lastSponsor"));
  check("the chip records the rebate as sponsor, not the caller",
    ("0x" + bytesToHex(got.ret).slice(-40)).toLowerCase(),
    rebate.toString().toLowerCase());

  /* ------------------------------------- 2. one chip, and no way to move it */

  console.log("");

  const fuelFn = rebateArt.abi.find((f) => f.type === "function" && f.name === "fuel");
  check("fuel() takes no address, so it cannot be aimed elsewhere",
    fuelFn.inputs.map((i) => i.type).join(","), "uint256");

  const chipIsFixed = rebateArt.abi.some((f) =>
    f.type === "function" && f.name === "CHIP" && f.stateMutability === "view");
  check("the chip it serves is public and immutable", chipIsFixed, "true");

  /* -------------------------------- 3. a token that calls back is not paid twice */

  const rt = await build(mocks.ReentrantToken);
  const rtAbi = new ethers.Interface(mocks.ReentrantToken.abi);
  await send(rt.token, rtAbi.encodeFunctionData("mint", [rt.rebate.toString(), 10n * RATE]));
  await send(rt.token, rtAbi.encodeFunctionData("point", [rt.rebate.toString()]));

  r = await send(rt.rebate, abi.encodeFunctionData("fuel", [1]), GREEDY);
  check("a re-entering token does not break the call", r.error, "null");

  got = await send(rt.token, rtAbi.encodeFunctionData("balanceOf", [GREEDY.toString()]));
  check("and is paid once, not twice", num(got), RATE);

  got = await send(rt.rebate, abi.encodeFunctionData("edges"));
  check("one edge counted, not two", num(got), 1n);

  got = await send(rt.chip, chipAbi.encodeFunctionData("cycle"));
  check("and the chip advanced once", num(got), 1n);

  /* -------------------------- 4. the counters follow the money, not the intent */

  const ft = await build(mocks.FeeToken);
  const ftAbi = new ethers.Interface(mocks.FeeToken.abi);
  await send(ft.token, ftAbi.encodeFunctionData("mint", [ft.rebate.toString(), 10n * RATE]));

  r = await send(ft.rebate, abi.encodeFunctionData("fuel", [5]), ANYONE);
  check("a token that takes a fee still pays out", r.error, "null");

  got = await send(ft.token, ftAbi.encodeFunctionData("balanceOf", [ft.rebate.toString()]));
  check("the reserve fell by exactly the rate", num(got), 9n * RATE);

  got = await send(ft.rebate, abi.encodeFunctionData("paid"));
  check("and `paid` records what left the reserve", num(got), RATE);

  /* --------------------------------- a token that returns nothing is tolerated */

  const st = await build(mocks.SilentToken);
  const stAbi = new ethers.Interface(mocks.SilentToken.abi);
  await send(st.token, stAbi.encodeFunctionData("mint", [st.rebate.toString(), 10n * RATE]));

  r = await send(st.rebate, abi.encodeFunctionData("fuel", [9]), ANYONE);
  check("a token whose transfer returns nothing is accepted", r.error, "null");

  got = await send(st.token, stAbi.encodeFunctionData("balanceOf", [ANYONE.toString()]));
  check("and the caller was paid", num(got), RATE);

  /* ------------------------------------- 5. an empty reserve still steps */

  console.log("");

  for (let i = 0; i < 9; i++) {
    await send(rebate, abi.encodeFunctionData("fuel", [1]), ANYONE);
  }
  got = await send(rebate, abi.encodeFunctionData("edgesRemaining"));
  check("the reserve runs out", num(got), 0n);

  const beforeCycle = num(await send(chip, chipAbi.encodeFunctionData("cycle")));
  r = await send(rebate, abi.encodeFunctionData("fuel", [7]), GREEDY);
  check("an empty reserve does not stop a cycle", r.error, "null");

  got = await send(chip, chipAbi.encodeFunctionData("cycle"));
  check("the chip advanced anyway", num(got), beforeCycle + 1n);

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [GREEDY.toString()]));
  check("and paid nothing for it", num(got), 0n);

  got = await send(rebate, abi.encodeFunctionData("paid"));
  check("the total paid stops at what the reserve held", num(got), 10n * RATE);

  /* ---------------------------------- refilling is a transfer, and only that */

  await send(token, tokenAbi.encodeFunctionData("mint", [rebate.toString(), 3n * RATE]));
  got = await send(rebate, abi.encodeFunctionData("edgesRemaining"));
  check("sending it tokens refills it, with no deposit function", num(got), 3n);

  /* ------------------------------------------- 6. there is no way out of it */

  console.log("");

  const MOVERS = /withdraw|sweep|rescue|drain|collect|claim|deposit|transfer|send|recover|skim|emergency/i;
  const suspects = rebateArt.abi.filter((f) =>
    f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure");

  check("exactly one function can change anything", suspects.length, 1);
  check("and it is fuel()", suspects.length === 1 ? suspects[0].name : "-", "fuel");

  const named = rebateArt.abi.filter((f) => f.type === "function" && MOVERS.test(f.name));
  check("no function in the ABI is named for moving money",
    named.map((f) => f.name).join(",") || "none", "none");

  const owners = rebateArt.abi.filter((f) =>
    f.type === "function" && /owner|admin|steward|pause|set[A-Z]/.test(f.name));
  check("and none for owning, pausing or setting anything",
    owners.map((f) => f.name).join(",") || "none", "none");

  const payable = rebateArt.abi.filter((f) =>
    (f.type === "function" || f.type === "receive" || f.type === "fallback") &&
    f.stateMutability === "payable");
  check("it cannot take ether either", payable.length, 0);

  /* The deployer has no more power than anybody else. Proven rather than
     asserted: the same calls, from the address that created the contract. */
  for (const f of ["withdraw()", "sweep()", "rescue()", "transferOwnership(address)"]) {
    const sel = ethers.id(f).slice(0, 10);
    r = await send(rebate, sel, DEPLOYER);
    check("the deployer calling " + f.padEnd(26) + "reverts", r.error !== null, "true");
  }

  got = await send(token, tokenAbi.encodeFunctionData("balanceOf", [rebate.toString()]));
  check("and the reserve is untouched", num(got), 3n * RATE);

  console.log("");
  if (bad) {
    console.log("  " + bad + " failing. Nothing about this is ready to deploy.");
    process.exit(1);
  }
  console.log("  the rebate pays for work, and nobody can take it back out.");
  console.log("");
})().catch((e) => die(e.stack || e.message));
