#!/usr/bin/env node
/**
 * sdk-test.js — put the published SDK to the proof.
 *
 *   npm run sdk-test
 *
 * Runs against sdk/, the built package, rather than against the sources it was
 * built from. A package is what people install; testing the ingredients tells
 * you nothing about whether the box was packed correctly.
 *
 * Three things are checked, and the third is the one that matters.
 *
 * 1. The processor in the package is the processor in this repository. Same
 *    programs, same cycles, same registers, same switching counts. If the
 *    build ever ships a stale netlist this is where it shows.
 *
 * 2. The decoders read what the contract writes. A `Stepped` log and a
 *    `program()` return are decoded and compared against values computed the
 *    way the contract computes them.
 *
 * 3. `verify()` fails when it should. This is the whole point. A verifier that
 *    returns "ok" is worthless unless it can be shown to return "not ok" for
 *    data that deserves it, so a fake node is stood up and asked three times:
 *    once with an honest history, once with a single output changed halfway
 *    through, and once with an event removed. The first must pass and the
 *    other two must fail, naming what was wrong.
 *
 * There is no live chip to point this at yet — `config.js` records the chip
 * address as null and says so. The fake node exists because of that, and it
 * tests everything except whether a real node answers, which is the one part
 * a real address will settle later.
 */

"use strict";

var http = require("node:http");
var path = require("node:path");
var cli = require("./cli.js");

cli.header("sdk-test", "the built package, put to the proof");

var ROOT = path.join(__dirname, "..");
var SDK = require(path.join(ROOT, "sdk", "index.js"));
var PORT = 8937;

var pass = 0, fail = 0;
function ok(cond, what, detail) {
  if (cond) { pass++; console.log("  pass  " + what); return; }
  fail++;
  console.log("  FAIL  " + what + (detail ? "   " + detail : ""));
}

/* ---------------------------------------------- 1. the same processor */

function sameProcessor() {
  var progs = SDK.programs();
  ok(progs && progs.ledger && progs.selftest, "the package ships both programs");

  var built = SDK.assemble(progs.ledger);
  ok(Array.isArray(built.rom) && built.rom.length === 1024,
    "ledger assembles to a 1,024 word ROM", "got " + (built.rom || []).length);

  var r = SDK.run(built.rom, { cycles: 12, inValue: 0 });
  ok(r.gates === 2161, "the netlist is the 2,161 gate one", "got " + r.gates);
  ok(r.cycles === 12, "twelve cycles were taken", "got " + r.cycles);

  /* The first edge sets a machine up from nothing and the second changes one
     register, which is the ratio the CLI prints and the marketing quotes. */
  var first = null, second = null;
  SDK.run(built.rom, {
    cycles: 2,
    onCycle: function (c) { if (c.cycle === 1) first = c.switched; else second = c.switched; },
  });
  ok(first === 1393, "1,393 gates switch on the first edge", "got " + first);
  ok(second === 28, "28 on the second", "got " + second);

  var halts = SDK.run(SDK.assemble(progs.selftest).rom, { cycles: 200 });
  ok(halts.halted === true, "selftest halts", "ran " + halts.cycles + " cycles");
}

/* ------------------------------------------------- 2. the decoders */

function decoders() {
  var log = {
    topics: [
      SDK.ABI.steppedTopic,
      "0x000000000000000000000000" + "0c37b19d1c6d2301c4f2a905c0ba5a82d02cfbce",
      "0x0000000000000000000000000000000000000000000000000000000000000007",
    ],
    data: "0x" +
      "000000000000000000000000000000000000000000000000000000000000002a" +
      "00000000000000000000000000000000000000000000000000000000000000ff",
    blockNumber: "0x3a",
    transactionHash: "0xdead",
  };
  var d = SDK.decodeStepped(log);
  ok(d.sponsor === "0x0c37b19d1c6d2301c4f2a905c0ba5a82d02cfbce", "the sponsor comes out of topic 1");
  ok(d.cycle === 7, "the cycle comes out of topic 2", "got " + d.cycle);
  ok(d.outPort === 42, "the output port is the first data word", "got " + d.outPort);
  ok(d.inValue === 255, "the input byte is the second", "got " + d.inValue);
  ok(d.block === 58, "the block number is decoded", "got " + d.block);
}

/* --------------------------------- 3. a fake node, and three questions */

/** A chip's history, computed here so the node has something honest to serve. */
function historyOf(rom, inputs) {
  var D = SDK.loadNetlist();
  var m = new SDK.Machine(D, rom);
  var events = [];
  for (var i = 0; i < inputs.length; i++) {
    m.inPort = inputs[i];
    m.step();
    events.push({ cycle: m.cycle, outPort: m.out(), inValue: inputs[i] });
  }
  return {
    events: events,
    end: { cycle: m.cycle, pc: m.pc(), out: m.out(),
           carry: m.carry() ? 1 : 0, zero: m.zero() ? 1 : 0, halted: m.halted() ? 1 : 0 },
  };
}

function w(n) { return BigInt(n).toString(16).padStart(64, "0"); }

function romToBytes(rom) {
  return rom.map(function (x) { return (x >>> 0).toString(16).padStart(8, "0"); }).join("");
}

function serve(state) {
  return http.createServer(function (req, res) {
    var body = "";
    req.on("data", function (c) { body += c; });
    req.on("end", function () {
      var call = JSON.parse(body);
      var out;

      if (call.method === "eth_blockNumber") {
        out = "0x3e8";
      } else if (call.method === "eth_call") {
        var data = call.params[0].data;
        if (data === SDK.ABI.snapshot) {
          var e = state.end;
          out = "0x" + w(e.cycle) + w(e.pc) + w(e.out) + w(e.carry) + w(e.zero) + w(e.halted);
        } else if (data === SDK.ABI.registers) {
          out = "0x" + w(32) + w(0);
        } else if (data === SDK.ABI.program) {
          var hex = romToBytes(state.rom);
          out = "0x" + w(32) + w(hex.length / 2) + hex;
        } else {
          out = "0x";
        }
      } else if (call.method === "eth_getLogs") {
        out = state.events.map(function (ev) {
          return {
            topics: [SDK.ABI.steppedTopic, "0x" + w(0), "0x" + w(ev.cycle)],
            data: "0x" + w(ev.outPort) + w(ev.inValue),
            blockNumber: "0x" + ev.cycle.toString(16),
            transactionHash: "0x" + ev.cycle.toString(16).padStart(64, "0"),
          };
        });
      } else {
        out = null;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: out }));
    });
  });
}

async function verifier() {
  var rom = SDK.assemble(SDK.programs().ledger).rom;
  var inputs = [];
  for (var i = 0; i < 24; i++) inputs.push((i * 7 + 3) % 256);
  var truth = historyOf(rom, inputs);

  var state = { rom: rom, events: truth.events.slice(), end: truth.end };
  var server = serve(state);
  await new Promise(function (r) { server.listen(PORT, "127.0.0.1", r); });
  var url = "http://127.0.0.1:" + PORT;

  /* An honest history. */
  var good = await SDK.verify("0xchip", { rpc: url, window: 10000 });
  ok(good.ok === true, "an honest history verifies",
    good.problems && good.problems.join("; "));
  ok(good.cyclesReplayed === 24, "all 24 cycles were replayed",
    "got " + good.cyclesReplayed);

  /* One output changed, halfway through. The final state still matches,
     because the tampering is in a log and not in the machine — so only the
     per-cycle check can catch this one. */
  state.events = truth.events.map(function (e) {
    return e.cycle === 12 ? { cycle: e.cycle, outPort: (e.outPort + 1) % 256, inValue: e.inValue } : e;
  });
  var tampered = await SDK.verify("0xchip", { rpc: url, window: 10000 });
  ok(tampered.ok === false, "one altered output is caught");
  ok(tampered.firstMismatch && tampered.firstMismatch.cycle === 12,
    "and it names cycle 12",
    tampered.firstMismatch ? "named " + tampered.firstMismatch.cycle : "named nothing");

  /* An event removed. The count no longer matches the cycle counter, so the
     replay is refused rather than run against the wrong tape. */
  state.events = truth.events.filter(function (e) { return e.cycle !== 5; });
  var short = await SDK.verify("0xchip", { rpc: url, window: 10000 });
  ok(short.ok === false, "a missing event is caught");
  ok(short.problems.join(" ").indexOf("23 Stepped events") >= 0,
    "and the count is reported", short.problems.join("; "));

  /* Every fetch above left a keep-alive socket open, and a server closing
     under them while the process is also tearing down trips an assertion
     inside libuv on Windows. Drop the connections first, then close. */
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise(function (r) { server.close(r); });
}

(async function () {
  sameProcessor();
  console.log("");
  decoders();
  console.log("");
  await verifier();

  console.log("");
  if (fail) {
    console.error("sdk-test: " + fail + " of " + (pass + fail) + " failed.");
  } else {
    console.log("sdk-test: " + pass + " checks, and the verifier refuses what it should.");
  }
  /* An exit code rather than an exit call: the fetch pool is still winding
     itself up and killing the process mid-teardown is what produced a 127
     from a run in which every check had passed. */
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.error("sdk-test: " + e.message);
  process.exitCode = 1;
});
