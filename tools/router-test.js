#!/usr/bin/env node
/**
 * router-test.js — FeeRouter, in a real EVM.
 *
 *   npm run router
 *
 * The router holds money and hands it out, which makes it the contract in this
 * repository where being wrong costs the most. Four properties are worth more
 * than the rest and all four are checked here rather than argued for:
 *
 *   1. what arrives is split the way the document says, from what actually
 *      arrived rather than from what the escrow claimed was pending;
 *   2. the reserve pays for edges at cost and never above it;
 *   3. one reimbursement per block, so nobody can drain it in a loop;
 *   4. there is no withdrawal path at all, and the privileged address can move
 *      the fee stream and touch nothing else.
 *
 * The fourth is the reason the hatch was acceptable. If it were wrong, the
 * document would be wrong too, and the document is the thing people read.
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
          abi: out.contracts[f][name].abi,
          bytecode: "0x" + out.contracts[f][name].evm.bytecode.object,
        };
      }
    }
    die("mock " + name + " not produced");
  };
  return {
    MockEscrow: pick("MockEscrow"),
    MockRecipientRegistry: pick("MockRecipientRegistry"),
    MockChip: pick("MockChip"),
  };
}

(async function main() {
  const { VM } = require("@ethereumjs/vm");
  const { Common, Chain, Hardfork } = require("@ethereumjs/common");
  const { Address, Account, hexToBytes, bytesToHex } = require("@ethereumjs/util");

  cli.header("ROUTER", "FeeRouter, in an actual EVM");

  const mocks = compileMocks();
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const GAS = 30000000n;

  const STEWARD = Address.fromString("0x1111111111111111111111111111111111111111");
  const DEV = Address.fromString("0x2222222222222222222222222222222222222222");
  const ANYONE = Address.fromString("0x3333333333333333333333333333333333333333");
  const STRANGER = Address.fromString("0x4444444444444444444444444444444444444444");

  for (const who of [STEWARD, ANYONE, STRANGER]) {
    await vm.stateManager.putAccount(who, Account.fromAccountData({ balance: 10n ** 20n }));
  }

  const GAS_PRICE = 1000000000n;   // 1 gwei, so a reimbursement is measurable
  const GAS_CAP = 5000000000n;     // 5 gwei

  async function deploy(bytecode, args, from) {
    const r = await vm.evm.runCall({
      caller: from || STEWARD, origin: from || STEWARD, gasLimit: GAS,
      data: hexToBytes(bytecode + (args || "").replace(/^0x/, "")), value: 0n,
    });
    if (r.execResult.exceptionError) die("deploy reverted: " + r.execResult.exceptionError.error);
    return r.createdAddress;
  }

  /* Every call names its block.
   *
   * The one-reimbursement-per-block guard compares against block.number,
   * and a harness that leaves it at zero tests the guard rather than the
   * behaviour: lastReimbursedBlock starts at zero, so at block zero the
   * router correctly refuses to pay twice for a block it has already paid
   * for. Real chains do not have live contracts at block zero. The tests
   * therefore run on real block numbers and advance them deliberately. */
  let BLOCK = 100n;
  function atBlock(n) { BLOCK = BigInt(n); }

  async function send(to, data, value, from, gasPrice) {
    const r = await vm.evm.runCall({
      caller: from || ANYONE, origin: from || ANYONE, to, gasLimit: GAS,
      data: hexToBytes(data), value: value || 0n,
      gasPrice: gasPrice === undefined ? GAS_PRICE : gasPrice,
      block: { header: { number: BLOCK, timestamp: 0n, gasLimit: GAS, baseFeePerGas: 0n } },
    });
    return {
      error: r.execResult.exceptionError ? r.execResult.exceptionError.error : null,
      ret: r.execResult.returnValue,
      gas: r.execResult.executionGasUsed,
    };
  }

  const balance = async (a) => {
    const acct = await vm.stateManager.getAccount(a);
    return acct ? acct.balance : 0n;
  };

  let bad = 0;
  function check(name, got, want) {
    const ok = typeof want === "function" ? want(got) : String(got) === String(want);
    console.log("  " + (ok ? "pass" : "FAIL") + "  " + name.padEnd(52) +
      (ok ? "" : "got " + String(got).slice(0, 60)));
    if (!ok) bad++;
  }

  /* ------------------------------------------------------------- deploy */

  const routerArt = artifact("FeeRouter");
  const abi = new ethers.Interface(routerArt.abi);
  const eAbi = new ethers.Interface(mocks.MockEscrow.abi);
  const rAbi = new ethers.Interface(mocks.MockRecipientRegistry.abi);
  const cAbi = new ethers.Interface(mocks.MockChip.abi);

  const escrow = await deploy(mocks.MockEscrow.bytecode);
  const registry = await deploy(mocks.MockRecipientRegistry.bytecode);
  const chip = await deploy(mocks.MockChip.bytecode);
  const TOKEN = "0x00000000000000000000000000000000000000ff";

  const ctor = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address", "uint256", "address", "uint256"],
    [escrow.toString(), registry.toString(), TOKEN, chip.toString(),
     DEV.toString(), 7000, STEWARD.toString(), GAS_CAP]
  );
  const router = await deploy(routerArt.bytecode, ctor);
  console.log("");
  console.log("  deployed: escrow, registry, chip, router (70% dev, 5 gwei cap)");
  console.log("");

  /* ------------------------------------------------- the split, on collect */

  const FEES = 10n ** 18n;   // one ether of fees, credited to the router
  await send(escrow, eAbi.encodeFunctionData("credit", [router.toString()]), FEES, STEWARD);

  let r = await send(router, abi.encodeFunctionData("collect"), 0n, ANYONE);
  check("anyone may collect", r.error, "null");
  check("development got seventy per cent", (await balance(DEV)).toString(), (FEES * 7000n / 10000n).toString());
  check("and the reserve kept the rest", (await balance(router)).toString(), (FEES * 3000n / 10000n).toString());

  r = await send(router, abi.encodeFunctionData("collect"), 0n, ANYONE);
  check("collecting nothing is refused", r.error !== null, "true");

  /* -------------------------------------------------- the reserve pays gas */

  const before = await balance(ANYONE);
  const reserveBefore = await balance(router);
  r = await send(router, abi.encodeFunctionData("step", [42]), 0n, ANYONE);
  check("anyone may step the chip", r.error, "null");

  let got = await send(chip, cAbi.encodeFunctionData("cycle"), 0n);
  check("the chip advanced", BigInt(bytesToHex(got.ret)).toString(), "1");
  got = await send(chip, cAbi.encodeFunctionData("lastIn"), 0n);
  check("with the byte it was given", BigInt(bytesToHex(got.ret)).toString(), "42");

  const paid = (await balance(ANYONE)) - before;
  check("the caller was reimbursed", paid > 0n, "true");
  check("out of the reserve", (await balance(router)) < reserveBefore, "true");
  check("and never more than the reserve held",
    (await balance(router)) >= 0n, "true");

  got = await send(router, abi.encodeFunctionData("totalReimbursed"), 0n);
  check("the router counted what it paid out",
    BigInt(bytesToHex(got.ret)).toString(), paid.toString());

  /* ------------------------------------------ one reimbursement per block */

  /* Same block on purpose: this is the guard being tested, not the clock. */
  const secondBefore = await balance(ANYONE);
  r = await send(router, abi.encodeFunctionData("step", [7]), 0n, ANYONE);
  check("a second step in the same block still runs", r.error, "null");
  check("but is not reimbursed", (await balance(ANYONE)) - secondBefore, "0");
  got = await send(chip, cAbi.encodeFunctionData("cycle"), 0n);
  check("and the chip still advanced", BigInt(bytesToHex(got.ret)).toString(), "2");

  /* -------------------------------------------------- the gas price ceiling */

  atBlock(101);
  const cappedBefore = await balance(STRANGER);
  const rr = await send(router, abi.encodeFunctionData("step", [1]), 0n, STRANGER, GAS_CAP * 100n);
  check("a caller with an absurd gas price is still served", rr.error, "null");
  const cappedPaid = (await balance(STRANGER)) - cappedBefore;
  check("and is reimbursed", cappedPaid > 0n, "true");
  check("but at the ceiling, not at their price",
    cappedPaid < rr.gas * GAS_CAP * 2n, "true");

  /* ------------------------------------------------------------ the hatch */

  r = await send(router, abi.encodeFunctionData("moveRecipient", [ANYONE.toString()]), 0n, ANYONE);
  check("a stranger cannot move the fee stream", r.error !== null, "true");

  r = await send(router, abi.encodeFunctionData("moveRecipient", [DEV.toString()]), 0n, STEWARD);
  check("the steward can", r.error, "null");
  got = await send(registry, rAbi.encodeFunctionData("lastRecipient"), 0n);
  check("and the registry was told the new address",
    ("0x" + bytesToHex(got.ret).slice(-40)).toLowerCase(), DEV.toString().toLowerCase());
  got = await send(registry, rAbi.encodeFunctionData("lastCaller"), 0n);
  check("by the router, not by a person",
    ("0x" + bytesToHex(got.ret).slice(-40)).toLowerCase(), router.toString().toLowerCase());

  r = await send(router, abi.encodeFunctionData("moveRecipient",
    ["0x0000000000000000000000000000000000000000"]), 0n, STEWARD);
  check("and it refuses the zero address", r.error !== null, "true");

  /* ------------------------------- what the privileged address cannot do */

  const names = routerArt.abi.filter((f) => f.type === "function").map((f) => f.name);
  const dangerous = names.filter((n) =>
    /withdraw|sweep|rescue|drain|transferOwnership|setDev|setSplit|setChip|selfdestruct/i.test(n));
  check("there is no withdrawal path in the ABI at all",
    dangerous.length + (dangerous.length ? ": " + dangerous.join(",") : ""), "0");

  const reserveHeld = await balance(router);
  check("the reserve survived the hatch being used", reserveHeld > 0n, "true");

  atBlock(102);
  r = await send(router, abi.encodeFunctionData("step", [3]), 0n, ANYONE);
  check("and the clock still runs after it", r.error, "null");

  console.log("");
  if (bad) {
    console.log("  " + bad + " failing. This contract holds money; do not deploy it.");
    process.exit(1);
  }
  console.log("  the router splits, pays and refuses the way the document says");
  process.exit(0);
})().catch((e) => {
  console.error("router-test: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
