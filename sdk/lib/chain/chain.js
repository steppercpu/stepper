/**
 * chain.js — reading a chip off the chain.
 *
 * Read-only by construction. There is no signing here, no key handling and no
 * transaction builder, so there is no code path in this package that can spend
 * anything. That is a deliberate property rather than an omission: a library
 * people are asked to install in order to check our claims should not also be
 * a library that could move their money.
 *
 * Everything is decoded by hand from `eth_call` and `eth_getLogs`. The
 * selectors are not written down here — they come from abi.js, which is
 * generated from the contract signatures by the same keccak the contracts use,
 * and checked against published vectors before it is written. A hand-copied
 * selector is how a page ends up calling a function that does not exist.
 */

"use strict";

var fs = require("node:fs");
var path = require("node:path");

/** abi.js is written for a browser. Handing it an object called window is the
    whole of the port, exactly as machine.js does for the netlist. */
function loadAbi() {
  var places = [
    path.join(__dirname, "..", "..", "public", "scripts", "abi.js"),
    path.join(__dirname, "..", "abi.js"),
    path.join(__dirname, "abi.js"),
  ];
  var file = places.filter(function (p) { return fs.existsSync(p); })[0];
  if (!file) throw new Error("abi.js is missing. Run `npm run abi` first.");
  var win = {};
  new Function("window", fs.readFileSync(file, "utf8"))(win);
  return win.ST8_ABI;
}

var ABI = loadAbi();

var DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

/* ------------------------------------------------------------- the wire */

var nextId = 0;

async function rpc(url, method, params) {
  var res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: method, params: params || [] }),
  });
  if (!res.ok) throw new Error(method + ": HTTP " + res.status);
  var body = await res.json();
  if (body.error) {
    var e = new Error(body.error.message || "rpc error");
    e.code = body.error.code;
    throw e;
  }
  return body.result;
}

function ethCall(url, to, data) {
  return rpc(url, "eth_call", [{ to: to, data: data }, "latest"]);
}

/* ------------------------------------------------------------ decoding */

function word(hex, i) {
  return hex.slice(2 + i * 64, 2 + (i + 1) * 64);
}
function toBig(w) { return BigInt("0x" + w); }
function toNum(w) { return Number(BigInt("0x" + w)); }

/** A dynamic `bytes` return: an offset, a length, then the bytes. */
function decodeBytes(hex) {
  var at = Number(toBig(word(hex, 0))) / 32;
  var len = Number(toBig(word(hex, at)));
  var start = 2 + (at + 1) * 64;
  return hex.slice(start, start + len * 2);
}

/** A dynamic `uint256[]` return. */
function decodeUintArray(hex) {
  var at = Number(toBig(word(hex, 0))) / 32;
  var len = Number(toBig(word(hex, at)));
  var out = [];
  for (var i = 0; i < len; i++) out.push(toBig(word(hex, at + 1 + i)));
  return out;
}

/**
 * The ROM, as the machine wants it.
 *
 * `program()` hands back the ROM as bytes, four to a word, big-endian. The
 * evaluator indexes words, so this is the one place the two representations
 * are reconciled.
 */
function romFromBytes(hexNoPrefix) {
  var rom = [];
  for (var i = 0; i + 8 <= hexNoPrefix.length; i += 8) {
    rom.push(parseInt(hexNoPrefix.slice(i, i + 8), 16));
  }
  return rom;
}

function pad32(address) {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/* -------------------------------------------------------------- reading */

/**
 * Everything a chip will tell you about itself in one round of calls.
 *
 * `snapshot()` is used rather than unpacking `state()` by hand, because the
 * contract already knows where its own fields sit and a second opinion about
 * that is a second thing that can be wrong.
 */
async function readChip(address, opts) {
  var url = (opts && opts.rpc) || DEFAULT_RPC;

  var snap = await ethCall(url, address, ABI.snapshot);
  var regs = await ethCall(url, address, ABI.registers);
  var prog = await ethCall(url, address, ABI.program);

  return {
    address: address,
    cycle: toNum(word(snap, 0)),
    pc: toNum(word(snap, 1)),
    out: toNum(word(snap, 2)),
    carry: toNum(word(snap, 3)) === 1,
    zero: toNum(word(snap, 4)) === 1,
    halted: toNum(word(snap, 5)) === 1,
    registers: decodeUintArray(regs).map(Number),
    rom: romFromBytes(decodeBytes(prog)),
  };
}

/** One `Stepped` log, as the fields the event declares. */
function decodeStepped(log) {
  return {
    sponsor: "0x" + log.topics[1].slice(26),
    cycle: Number(BigInt(log.topics[2])),
    outPort: Number(BigInt("0x" + word(log.data, 0))),
    inValue: Number(BigInt("0x" + word(log.data, 1))),
    block: Number(BigInt(log.blockNumber)),
    tx: log.transactionHash,
  };
}

/**
 * Every `Stepped` this chip has emitted.
 *
 * Scanned backwards in windows from the head of the chain, and — this is the
 * part that makes it terminate honestly — the chip has already said how many
 * there should be. `snapshot()` reports the cycle count, one event was emitted
 * per cycle, so the scan stops when it has that many rather than when it runs
 * out of patience. A short answer is then a real finding rather than the scan
 * having given up early.
 */
async function history(address, opts) {
  var o = opts || {};
  var url = o.rpc || DEFAULT_RPC;
  var want = o.expect;
  var span = o.window || 50000;

  var head = Number(BigInt(await rpc(url, "eth_blockNumber")));
  var to = head;
  var found = [];
  var floor = o.fromBlock === undefined ? 0 : o.fromBlock;

  while (to >= floor && (want === undefined || found.length < want)) {
    var from = Math.max(floor, to - span + 1);
    var logs = await rpc(url, "eth_getLogs", [{
      address: address,
      topics: [ABI.steppedTopic],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    }]);
    for (var i = 0; i < logs.length; i++) found.push(decodeStepped(logs[i]));
    if (from === floor) break;
    to = from - 1;
  }

  found.sort(function (a, b) { return a.cycle - b.cycle; });
  return found;
}

module.exports = {
  ABI: ABI,
  DEFAULT_RPC: DEFAULT_RPC,
  rpc: rpc,
  ethCall: ethCall,
  readChip: readChip,
  history: history,
  decodeStepped: decodeStepped,
  romFromBytes: romFromBytes,
  pad32: pad32,
};
