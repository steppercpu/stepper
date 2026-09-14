#!/usr/bin/env node
/**
 * bus-test.js — a chip wired to a device, and everything that can go wrong.
 *
 *   npm run bus
 *
 * A bus is the only part of this system that touches something it did not
 * build. The chip is gates, the verifier is arithmetic, and both are closed:
 * hand them the same inputs and they answer the same way forever. A bus calls
 * out to an address somebody else chose, twice per edge, and then reports what
 * came back as though it were a measurement.
 *
 * So the tests here are in two halves. The first half is the claim the bus
 * makes about itself: that `preview` tells you what `tick` is going to do. If
 * those two ever disagree the bus is worse than useless, because the whole
 * argument for a structural machine is that its next state is a consequence of
 * the gate table and can be computed before it is committed to.
 *
 * The second half is the device behaving badly. `sense` is a view in the
 * interface, so the compiler must reach it with STATICCALL and a device must
 * not be able to write state from inside it. `drive` is not a view, so a
 * device can call back, and the guard has to hold. Neither of those is worth
 * asserting from reading the source; both are worth watching fail.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");
const solc = require("solc");
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

/**
 * The fixtures live here rather than in contracts/ on purpose. A hostile
 * device is scaffolding for a proof, not part of the processor, and the
 * repository ships the processor.
 */
const FIXTURES = `
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface ITick { function tick() external returns (uint8, uint8); }

/// A source under the test's control.
contract StubFeed {
    int256 private _answer;
    uint256 private _updatedAt;
    uint8 private _decimals;
    constructor(uint8 d) { _decimals = d; }
    function decimals() external view returns (uint8) { return _decimals; }
    function set(int256 a, uint256 t) external { _answer = a; _updatedAt = t; }
    function latestRoundData()
        external view returns (uint80, int256, uint80, uint256, uint80)
    { return (1, _answer, 0, _updatedAt, 1); }
}

/// Writes state from sense(). Declared non-view here so it compiles; the bus
/// reaches it through an interface that says view, which is what decides the
/// opcode.
contract WriteInSense {
    uint256 public touched;
    function sense() external returns (uint8) { touched = 1; return 7; }
    function window() external pure returns (int256, int256, uint8) { return (0, 255, 0); }
    function drive(uint8) external {}
}

/// The same device without the write. The control: if this one ticks and
/// the one above does not, the write is what failed rather than the shape.
contract QuietSense {
    uint8 public last;
    function sense() external pure returns (uint8) { return 7; }
    function window() external pure returns (int256, int256, uint8) { return (0, 255, 0); }
    function drive(uint8 v) external { last = v; }
}

/// Calls back into the bus from drive().
contract DriveReenterer {
    address public bus;
    uint256 public drives;
    function aim(address b) external { bus = b; }
    function sense() external pure returns (uint8) { return 9; }
    function window() external pure returns (int256, int256, uint8) { return (0, 255, 0); }
    function drive(uint8) external { drives++; ITick(bus).tick(); }
}
`;

function compileFixtures() {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "Fixtures.sol": { content: FIXTURES } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("the fixtures did not compile:\n  " + errs[0].formattedMessage);
  return out.contracts["Fixtures.sol"];
}

(async function main() {
  const { VM } = require("@ethereumjs/vm");
  const { Common, Chain, Hardfork } = require("@ethereumjs/common");
  const { Address, Account, hexToBytes, bytesToHex } = require("@ethereumjs/util");

  cli.header("BUS", "a chip, a device, and a hostile one");

  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const GAS = 200000000n;

  const ANYONE = Address.fromString("0x1111111111111111111111111111111111111111");
  const STRANGER = Address.fromString("0x2222222222222222222222222222222222222222");
  for (const a of [ANYONE, STRANGER]) {
    await vm.stateManager.putAccount(a, Account.fromAccountData({ balance: 10n ** 20n }));
  }

  /* A block whose clock is not zero, so staleness is testable at all. Derived
     from the chain's own head rather than constructed, so no package beyond
     the ones the suite already uses is needed. */
  const head = await vm.blockchain.getCanonicalHeadBlock();
  const NOW = 1700000000n;
  const block = Object.create(Object.getPrototypeOf(head));
  Object.assign(block, head);
  block.header = Object.create(Object.getPrototypeOf(head.header));
  Object.assign(block.header, head.header, { timestamp: NOW });

  async function deploy(bytecode, args) {
    const r = await vm.evm.runCall({
      caller: ANYONE, origin: ANYONE, gasLimit: GAS, block,
      data: hexToBytes("0x" + bytecode.replace(/^0x/, "") + (args || "").replace(/^0x/, "")),
      value: 0n,
    });
    if (r.execResult.exceptionError) {
      return {
        address: null,
        error: r.execResult.exceptionError.error,
        ret: bytesToHex(r.execResult.returnValue),
        logs: [],
      };
    }
    return {
      address: r.execResult.createdAddress || r.createdAddress,
      error: null,
      ret: "0x",
      logs: r.execResult.logs || [],
    };
  }

  /**
   * Which error came back, by selector.
   *
   * A test that only asserts "this reverted" passes when the call reverts for
   * a reason nobody intended — a bad argument, a missing fixture, an out of
   * gas — and goes on claiming the guard works. So every refusal below is
   * checked by name.
   */
  const SEL = {
    "0xb5dfd9e5": "Reentered()",
    "0xada8060e": "UnsupportedPort()",
    "0x3fcbf498": "NotWired()",
    "0xd7815800": "Stale()",
    "0x2b0bb828": "NoAnswer()",
    "0x5419376a": "BadWindow()",
  };
  function why(r) {
    if (r.error === null) return "no revert";
    const sel = (r.ret || "0x").slice(0, 10);
    return SEL[sel] || (sel === "0x" ? r.error : sel);
  }

  async function call(to, data, opts) {
    const o = opts || {};
    const r = await vm.evm.runCall({
      caller: o.from || ANYONE, origin: o.from || ANYONE, to, gasLimit: GAS, block,
      data: hexToBytes(data), value: o.value || 0n,
    });
    return {
      error: r.execResult.exceptionError ? r.execResult.exceptionError.error : null,
      ret: bytesToHex(r.execResult.returnValue),
      gas: r.execResult.executionGasUsed,
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
  function section(t) { console.log(""); console.log("  " + t); console.log(""); }

  /* --------------------------------------------------------------- deploy */

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const fx = compileFixtures();

  const arrayArt = artifact("ST8GateArray");
  const chipArt = artifact("Chip");
  const busArt = artifact("Bus");
  const portArt = artifact("FeedPort");

  const array = (await deploy(arrayArt.bytecode)).address;

  /* The mother chip's program: in, rotate, fold, show, store, again. It reads
     the port every loop and writes to RAM, which is what a bus needs to be
     tested against: a program that never touched `in` would pass a test of a
     bus that never presented anything. */
  const win = {};
  new Function("window", fs.readFileSync(
    path.join(ROOT, "public/scripts/st8-data.js"), "utf8"))(win);
  const words = win.ST8_DATA.programs.digest.rom;
  let n = 0;
  for (let i = 0; i < words.length; i++) if (words[i]) n = i + 1;
  let romHex = "";
  for (let i = 0; i < n; i++) romHex += (words[i] >>> 0).toString(16).padStart(8, "0");

  const chip = (await deploy(chipArt.bytecode,
    coder.encode(["address", "bytes"], [array.toString(), "0x" + romHex]))).address;

  /* A window one dollar wide at eight decimals, so a byte is worth about four
     tenths of a cent and the arithmetic below is checkable by hand. */
  const DEC = 8;
  const LO = 0n;
  const HI = 100000000n;
  const MAX_AGE = 3600n;

  const feed = (await deploy(fx.StubFeed.evm.bytecode.object,
    coder.encode(["uint8"], [DEC]))).address;

  const port = (await deploy(portArt.bytecode,
    coder.encode(["address", "int256", "int256", "uint256"],
      [feed.toString(), LO, HI, MAX_AGE]))).address;

  const busDeploy = await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [chip.toString(), port.toString()]));
  const bus = busDeploy.address;

  const chipAbi = new ethers.Interface(chipArt.abi);
  const busAbi = new ethers.Interface(busArt.abi);
  const portAbi = new ethers.Interface(portArt.abi);
  const feedAbi = new ethers.Interface(fx.StubFeed.abi);

  const setFeed = (a, t) => call(feed, feedAbi.encodeFunctionData("set", [a, t]));
  await setFeed(50000000n, NOW);

  console.log("");
  console.log("  deployed: gate array, chip, source, port, bus");

  /* ---------------------------------------------------------- the wiring */

  section("the wiring");

  let r = await call(bus, busAbi.encodeFunctionData("chip"));
  check("the bus reports the chip it clocks",
    busAbi.decodeFunctionResult("chip", r.ret)[0].toLowerCase(), chip.toString().toLowerCase());

  r = await call(bus, busAbi.encodeFunctionData("device"));
  check("and the device on the far side of the port",
    busAbi.decodeFunctionResult("device", r.ret)[0].toLowerCase(), port.toString().toLowerCase());

  check("the wiring was recorded once, from the constructor", busDeploy.logs.length, 1);
  check("and there is no function that could record it again",
    busArt.abi.filter((f) => f.type === "function" && /device|wire/i.test(f.name || "")
      && f.stateMutability !== "view").length, 0);

  /* -------------------------------------------------------- the converter */

  section("the converter");

  async function sense() {
    const s = await call(port, portAbi.encodeFunctionData("sense"));
    return s.error ? "reverted" : Number(portAbi.decodeFunctionResult("sense", s.ret)[0]);
  }

  await setFeed(LO, NOW);
  check("a reading at the bottom of the window converts to 0", await sense(), 0);

  await setFeed(HI, NOW);
  check("a reading at the top converts to 255", await sense(), 255);

  await setFeed(HI / 2n, NOW);
  check("the midpoint converts to 127", await sense(), 127);

  await setFeed(-1n, NOW);
  check("a reading under the window is clamped, not wrapped", await sense(), 0);

  await setFeed(HI * 1000n, NOW);
  check("a reading over the window is clamped, not wrapped", await sense(), 255);

  r = await call(port, portAbi.encodeFunctionData("window"));
  const w = portAbi.decodeFunctionResult("window", r.ret);
  check("window() reports the scale the readings are quoted in",
    [w[0], w[1], w[2]].join(","), [LO, HI, DEC].join(","));

  /* --------------------------------- every edge, previewed and then taken */

  section("every edge, previewed and then taken");

  const CYCLES = 24;
  const READINGS = [7000000n, 0n, 99000000n, 41000000n, 100000000n, 250000n, 63000000n];

  let sampleAgreed = 0, valueAgreed = 0, sawWhatWasSent = 0, deviceGot = 0;
  let edgeGas = 0n;

  for (let i = 0; i < CYCLES; i++) {
    await setFeed(READINGS[i % READINGS.length], NOW);

    const p = await call(bus, busAbi.encodeFunctionData("preview"));
    if (p.error) { console.log("  FAIL  preview reverted at edge " + i); bad++; break; }
    const [pSample, pValue] = busAbi.decodeFunctionResult("preview", p.ret).map(Number);

    const t = await call(bus, busAbi.encodeFunctionData("tick"));
    if (t.error) { console.log("  FAIL  tick reverted at edge " + i); bad++; break; }
    const [tSample, tValue] = busAbi.decodeFunctionResult("tick", t.ret).map(Number);
    edgeGas = t.gas;

    if (pSample === tSample) sampleAgreed++;
    if (pValue === tValue) valueAgreed++;

    /* What the chip says it was handed, from the chip rather than the bus. */
    const ev = t.logs.find((l) =>
      bytesToHex(l[0]).toLowerCase() === chip.toString().toLowerCase());
    if (ev) {
      const dec = chipAbi.decodeEventLog("Stepped",
        bytesToHex(ev[2]), ev[1].map(bytesToHex));
      if (Number(dec.inValue) === tSample && Number(dec.outPort) === tValue) sawWhatWasSent++;
    }

    const lv = await call(port, portAbi.encodeFunctionData("lastValue", [bus.toString()]));
    if (Number(portAbi.decodeFunctionResult("lastValue", lv.ret)[0]) === tValue) deviceGot++;
  }

  check("preview predicted the sample on every edge", sampleAgreed, CYCLES);
  check("preview predicted the output byte on every edge", valueAgreed, CYCLES);
  check("the chip was handed exactly what the device converted", sawWhatWasSent, CYCLES);
  check("the device recorded exactly what the chip latched", deviceGot, CYCLES);

  r = await call(port, portAbi.encodeFunctionData("driven", [bus.toString()]));
  check("and it counted every one of them",
    Number(portAbi.decodeFunctionResult("driven", r.ret)[0]), CYCLES);

  let wrote = 0;
  for (let a = 0; a < 4; a++) {
    const c = await call(chip, chipAbi.encodeFunctionData("ram", [a]));
    if (BigInt(c.ret || "0x0") !== 0n) wrote++;
  }
  check("the program wrote to RAM, so memory moved under it", wrote > 0, true);

  /* The same edge taken directly, so the figure above has something to be
     compared against. Both are execution gas in this VM and neither carries
     the 21,000 a transaction pays before it starts. */
  const direct = await call(chip, chipAbi.encodeFunctionData("step", [42]));
  check("and a bare step still works alongside it", direct.error, null);
  console.log("        one edge: " + edgeGas.toLocaleString("en-US") +
    " gas through the bus, " + direct.gas.toLocaleString("en-US") + " straight at the chip");

  /* ------------------------------------- what a hostile device cannot do */

  section("what a hostile device cannot do");

  const liar = (await deploy(fx.WriteInSense.evm.bytecode.object)).address;
  const liarBus = (await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [chip.toString(), liar.toString()]))).address;

  r = await call(liarBus, busAbi.encodeFunctionData("tick"));
  check("a device that writes state in sense() cannot be sensed", r.error, "revert");

  r = await call(liar, new ethers.Interface(fx.WriteInSense.abi).encodeFunctionData("touched"));
  check("and it never got to write anything", BigInt(r.ret || "0x0"), 0n);

  /* The control. Same interface, same bus, one line less: no write. If this
     ticks, the only thing that stopped the one above was the write, and the
     only thing that stops a write in a called contract is a static context. */
  const quiet = (await deploy(fx.QuietSense.evm.bytecode.object)).address;
  const quietBus = (await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [chip.toString(), quiet.toString()]))).address;
  r = await call(quietBus, busAbi.encodeFunctionData("tick"));
  check("the same device without the write ticks perfectly well", r.error, null);

  const reent = (await deploy(fx.DriveReenterer.evm.bytecode.object)).address;
  const reentBus = (await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [chip.toString(), reent.toString()]))).address;
  const reentAbi = new ethers.Interface(fx.DriveReenterer.abi);
  await call(reent, reentAbi.encodeFunctionData("aim", [reentBus.toString()]));

  let before = await call(chip, chipAbi.encodeFunctionData("snapshot"));
  const cycleBefore = chipAbi.decodeFunctionResult("snapshot", before.ret)[0];

  r = await call(reentBus, busAbi.encodeFunctionData("tick"));
  check("a device that calls back from drive() is refused", why(r), "Reentered()");

  const after = await call(chip, chipAbi.encodeFunctionData("snapshot"));
  check("and the chip did not advance at all",
    chipAbi.decodeFunctionResult("snapshot", after.ret)[0], cycleBefore);

  /* ------------------------------------------------ what the bus refuses */

  section("what the bus refuses");

  const art16 = artifact("ST16GateArray");
  const array16 = (await deploy(art16.bytecode)).address;
  const chip16 = (await deploy(chipArt.bytecode,
    coder.encode(["address", "bytes"], [array16.toString(), "0x"]))).address;

  r = await call(chip16, chipAbi.encodeFunctionData("spec"));
  const spec16 = chipAbi.decodeFunctionResult("spec", r.ret)[0];
  check("the wider generation really does have a wider port",
    Number(spec16.outBits) > 8, true);

  let d = await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [chip16.toString(), port.toString()]));
  check("a chip whose port does not fit a byte is refused, not truncated",
    why(d), "UnsupportedPort()");

  d = await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [ethers.ZeroAddress, port.toString()]));
  check("a bus with no chip is refused", why(d), "NotWired()");

  d = await deploy(busArt.bytecode,
    coder.encode(["address", "address"], [chip.toString(), ethers.ZeroAddress]));
  check("a bus with no device is refused", why(d), "NotWired()");

  /* --------------------------------------------- what the source cannot do */

  section("what the source cannot do");

  await setFeed(50000000n, 0n);
  r = await call(bus, busAbi.encodeFunctionData("tick"));
  check("a source that never answered stops the clock", why(r), "NoAnswer()");

  await setFeed(50000000n, NOW - MAX_AGE - 1n);
  r = await call(bus, busAbi.encodeFunctionData("tick"));
  check("a stale source stops the clock rather than being believed",
    why(r), "Stale()");

  await setFeed(50000000n, NOW + 60n);
  r = await call(bus, busAbi.encodeFunctionData("tick"));
  check("a reading stamped ahead of the block is read, not panicked over",
    r.error, null);

  await setFeed(50000000n, NOW);
  r = await call(bus, busAbi.encodeFunctionData("tick"));
  check("and a fresh reading starts it again", r.error, null);

  /* ------------------------------------------------------- the surface */

  section("the surface");

  r = await call(port, portAbi.encodeFunctionData("drive", [200]), { from: STRANGER });
  check("anyone may drive this device", r.error, null);

  r = await call(port, portAbi.encodeFunctionData("lastValue", [bus.toString()]));
  const busSlot = Number(portAbi.decodeFunctionResult("lastValue", r.ret)[0]);
  r = await call(port, portAbi.encodeFunctionData("lastValue", [STRANGER.toString()]));
  const strangerSlot = Number(portAbi.decodeFunctionResult("lastValue", r.ret)[0]);
  check("but only into their own slot", strangerSlot === 200 && busSlot !== 200, true);

  check("nothing on the bus is payable",
    busArt.abi.filter((f) => f.stateMutability === "payable").length, 0);
  check("nothing on the device is payable",
    portArt.abi.filter((f) => f.stateMutability === "payable").length, 0);
  check("and neither carries an owner",
    [...busArt.abi, ...portArt.abi]
      .filter((f) => f.type === "function" && /owner|admin|pause|upgrade|setWindow|setFeed/i
        .test(f.name || "")).length, 0);

  console.log("");
  if (bad) die(bad + " check" + (bad === 1 ? "" : "s") + " failed.");
  console.log("  the bus does what it previews, and a hostile device gets nowhere.");
  console.log("");
})();
