#!/usr/bin/env node
/**
 * court-test.js — StepVerifier against a real chip, edge for edge.
 *
 *   npm run court
 *
 * A fraud proof settles a dispute by recomputing one clock edge on chain and
 * seeing who was right. That is worth exactly as much as the recomputation is
 * faithful, so this does not test the verifier against a model of a chip. It
 * tests it against a chip.
 *
 * For every cycle: read the machine state out of the chip, ask the verifier
 * what the next one would be, then step the chip for real and compare. If the
 * two ever disagree, a court built on this would settle disputes the wrong way
 * round, which is worse than having no court.
 *
 * The program is the ledger, chosen because it writes to RAM. A verifier that
 * ignored memory would pass a test run on a program that never stores, and
 * that is the failure worth designing the test to catch.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "contracts", "out");

function die(msg) {
  process.stderr.write("\n  " + msg + "\n\n");
  process.exit(1);
}

function artifact(name) {
  const p = path.join(OUT, name + ".json");
  if (!fs.existsSync(p)) die("contracts/out/" + name + ".json is missing. Run `npm run compile`.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

(async function main() {
  const { VM } = require("@ethereumjs/vm");
  const { Common, Chain, Hardfork } = require("@ethereumjs/common");
  const { Address, Account, hexToBytes, bytesToHex } = require("@ethereumjs/util");

  cli.header("COURT", "StepVerifier against a chip, edge for edge");

  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const GAS = 200000000n;

  const ANYONE = Address.fromString("0x1111111111111111111111111111111111111111");
  await vm.stateManager.putAccount(ANYONE, Account.fromAccountData({ balance: 10n ** 20n }));

  async function deploy(bytecode, args) {
    const r = await vm.evm.runCall({
      caller: ANYONE, origin: ANYONE, gasLimit: GAS,
      data: hexToBytes(bytecode + (args || "").replace(/^0x/, "")), value: 0n,
    });
    if (r.execResult.exceptionError) die("deploy reverted: " + r.execResult.exceptionError.error);
    return r.createdAddress;
  }

  async function call(to, data) {
    const r = await vm.evm.runCall({
      caller: ANYONE, origin: ANYONE, to, gasLimit: GAS, data: hexToBytes(data), value: 0n,
    });
    return {
      error: r.execResult.exceptionError ? r.execResult.exceptionError.error : null,
      ret: bytesToHex(r.execResult.returnValue),
      gas: r.execResult.executionGasUsed,
    };
  }

  let bad = 0;
  function check(name, got, want) {
    const ok = typeof want === "function" ? want(got) : String(got) === String(want);
    console.log("  " + (ok ? "pass" : "FAIL") + "  " + name.padEnd(54) +
      (ok ? "" : "got " + JSON.stringify(String(got)).slice(0, 80)));
    if (!ok) bad++;
  }

  /* --------------------------------------------------------------- deploy */

  const arrayArt = artifact("ST8GateArray");
  const chipArt = artifact("Chip");
  const vArt = artifact("StepVerifier");

  const array = await deploy(arrayArt.bytecode);
  const verifier = await deploy(vArt.bytecode);

  /* The ROM a chip carries, taken from the netlist rather than typed. */
  const win = {};
  new Function("window", fs.readFileSync(
    path.join(ROOT, "public/scripts/st8-data.js"), "utf8"))(win);
  const words = win.ST8_DATA.programs.ledger.rom;
  let n = 0;
  for (let i = 0; i < words.length; i++) if (words[i]) n = i + 1;
  let romHex = "";
  for (let i = 0; i < n; i++) romHex += (words[i] >>> 0).toString(16).padStart(8, "0");

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const chip = await deploy(chipArt.bytecode,
    coder.encode(["address", "bytes"], [array.toString(), "0x" + romHex]));

  const chipAbi = new ethers.Interface(chipArt.abi);
  const vAbi = new ethers.Interface(vArt.abi);

  console.log("");
  console.log("  deployed: gate array, chip, verifier");
  console.log("");

  /* ------------------------------------------------------------ the spec */

  let got = await call(chip, chipAbi.encodeFunctionData("spec"));
  const spec = chipAbi.decodeFunctionResult("spec", got.ret)[0];
  const stateWords = Number(spec.stateWords);
  const flops = Number(spec.flops);
  const cellBits = Number(spec.ramWdataBits);
  const cells = 1 << Number(spec.ramAddrBits);
  const perWord = 256 / cellBits;
  const ramWords = Math.ceil(cells / perWord);
  const cycleShift = BigInt(flops - (stateWords - 1) * 256);
  const archMask = (1n << cycleShift) - 1n;

  check("the chip reports the silicon it runs on", Number(spec.gates), 2161);
  check("and the verifier will be handed " + ramWords + " words of RAM",
    ramWords, cells / perWord);

  /** Every cell, packed the way the chip packs them. */
  async function readRam() {
    const out = new Array(ramWords).fill(0n);
    for (let a = 0; a < cells; a++) {
      const r = await call(chip, chipAbi.encodeFunctionData("ram", [a]));
      const v = BigInt(r.ret || "0x0");
      if (v !== 0n) {
        out[Math.floor(a / perWord)] |= v << BigInt((a % perWord) * cellBits);
      }
    }
    return out;
  }

  async function readState() {
    const r = await call(chip, chipAbi.encodeFunctionData("state"));
    return chipAbi.decodeFunctionResult("state", r.ret)[0].map(BigInt);
  }

  const arch = (v) => v.map((w, i) => (i === v.length - 1 ? w & archMask : w));
  const same = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

  /* ------------------------------ every edge, predicted then taken */

  const CYCLES = 24;
  const BYTES = [7, 0, 200, 13, 255, 1, 44, 99];

  let agreed = 0, stateMismatch = -1, ramMismatch = -1, wrote = 0;
  let settleGas = 0n;

  for (let i = 0; i < CYCLES; i++) {
    const inValue = BYTES[i % BYTES.length];
    const before = await readState();
    const ramBefore = await readRam();

    const pred = await call(verifier, vAbi.encodeFunctionData("transition",
      [chip.toString(), arch(before), ramBefore, inValue]));
    if (pred.error) { console.log("  FAIL  transition reverted at cycle " + i); bad++; break; }
    settleGas = pred.gas;
    const [nextState, nextRam] = vAbi.decodeFunctionResult("transition", pred.ret);

    const r = await call(chip, chipAbi.encodeFunctionData("step", [inValue]));
    if (r.error) { console.log("  FAIL  the chip refused cycle " + i); bad++; break; }

    const after = arch(await readState());
    const ramAfter = await readRam();
    if (!same(ramAfter, ramBefore)) wrote++;

    if (!same(arch(nextState.map(BigInt)), after) && stateMismatch < 0) stateMismatch = i;
    if (!same(nextRam.map(BigInt), ramAfter) && ramMismatch < 0) ramMismatch = i;
    if (stateMismatch < 0 && ramMismatch < 0) agreed++;
  }

  check("every predicted state matched the chip", stateMismatch, -1);
  check("every predicted RAM matched the chip", ramMismatch, -1);
  check(CYCLES + " edges agreed, one after another", agreed, CYCLES);
  check("and the program wrote to RAM, so memory was tested",
    wrote > 0, "true");
  console.log("        one settlement costs " + Number(settleGas).toLocaleString() + " gas");

  /* ------------------------------------------ a wrong claim is refused */

  console.log("");

  const state = arch(await readState());
  const ram = await readRam();
  const truth = await call(verifier, vAbi.encodeFunctionData("transition",
    [chip.toString(), state, ram, 42]));
  const [tState, tRam] = vAbi.decodeFunctionResult("transition", truth.ret);

  const honest = await call(verifier, vAbi.encodeFunctionData("commit",
    [tState.map(String), tRam.map(String)]));
  const honestCommit = vAbi.decodeFunctionResult("commit", honest.ret)[0];

  got = await call(verifier, vAbi.encodeFunctionData("agrees",
    [chip.toString(), state, ram, 42, honestCommit]));
  check("an honest claim is upheld",
    vAbi.decodeFunctionResult("agrees", got.ret)[0], "true");

  /* One bit, in the last place anybody would look. A court that only catches
     obvious lies catches the lies nobody tells. */
  const liarState = tState.map(BigInt);
  liarState[0] ^= 1n;
  const liar = await call(verifier, vAbi.encodeFunctionData("commit",
    [liarState.map(String), tRam.map(String)]));
  const liarCommit = vAbi.decodeFunctionResult("commit", liar.ret)[0];

  got = await call(verifier, vAbi.encodeFunctionData("agrees",
    [chip.toString(), state, ram, 42, liarCommit]));
  check("a claim off by one flip-flop is refused",
    vAbi.decodeFunctionResult("agrees", got.ret)[0], "false");

  /* The same state, a different input byte.
   *
   * Only on a cycle that reads the port. The ledger runs `in` once every
   * seven instructions and the byte changes nothing on the other six, so a
   * check pinned to an arbitrary cycle would be asserting something false
   * about the machine rather than something true about the verifier.
   *
   * So: step until the input demonstrably matters, and fail if it never
   * does -- that would mean the input port was not connected to anything. */
  let sensitiveAt = -1;
  for (let i = 0; i < 8 && sensitiveAt < 0; i++) {
    const st = arch(await readState());
    const rm = await readRam();
    const a = await call(verifier, vAbi.encodeFunctionData("transition",
      [chip.toString(), st, rm, 42]));
    const b = await call(verifier, vAbi.encodeFunctionData("transition",
      [chip.toString(), st, rm, 43]));
    if (!a.error && !b.error && a.ret !== b.ret) {
      sensitiveAt = i;
      const c = await call(verifier, vAbi.encodeFunctionData("commit",
        vAbi.decodeFunctionResult("transition", a.ret).map((x) => x.map(String))));
      const forty2 = vAbi.decodeFunctionResult("commit", c.ret)[0];
      got = await call(verifier, vAbi.encodeFunctionData("agrees",
        [chip.toString(), st, rm, 43, forty2]));
      check("a claim about a different input byte is refused",
        vAbi.decodeFunctionResult("agrees", got.ret)[0], "false");
      break;
    }
    await call(chip, chipAbi.encodeFunctionData("step", [0]));
  }
  check("and the input port reaches the gates at all", sensitiveAt >= 0, "true");

  /* ---------------------------------------------- it answers, never throws */

  /* A word too many. ST-8 keeps its 167 flip-flops in a single word, so
     taking one away leaves the state unchanged; adding one is malformed at
     every width. */
  const wrongShape = state.concat([0n]);
  got = await call(verifier, vAbi.encodeFunctionData("agrees",
    [chip.toString(), wrongShape, ram, 1, honestCommit]));
  check("a malformed claim is a wrong claim, not a failed call",
    got.error === null && vAbi.decodeFunctionResult("agrees", got.ret)[0] === false, "true");

  /* -------------------------------------------- nothing to own, nothing to take */

  console.log("");
  const movers = vArt.abi.filter((f) =>
    f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure");
  check("no function can change anything", movers.length, 0);

  const payable = vArt.abi.filter((f) =>
    (f.type === "function" || f.type === "receive" || f.type === "fallback") &&
    f.stateMutability === "payable");
  check("and none can take ether", payable.length, 0);

  console.log("");
  if (bad) {
    console.log("  " + bad + " failing. A court on this would settle the wrong way round.");
    process.exit(1);
  }
  console.log("  the verifier agrees with the chip, edge for edge.");
  console.log("");
})().catch((e) => die(e.stack || e.message));
