/**
 * verify.js — replay a chip's whole history and check the chain agrees.
 *
 * This is the one function in the package that is worth installing it for.
 *
 * A STEPPER chip is deterministic and its inputs are all public. `program()`
 * returns the ROM. Every `step()` emits `Stepped(sponsor, cycle, outPort,
 * inValue)`, so the log carries the byte that went in and the cycle it went in
 * on. ROM plus those events is the complete tape a deterministic machine ran
 * on — which means the entire history can be recomputed from scratch by
 * anybody, on their own machine, and compared against what the contract now
 * says about itself.
 *
 * Two claims are checked, and the second is the stronger one:
 *
 *   The end state matches. Cycle, program counter, output port and all three
 *   flags, against `snapshot()`.
 *
 *   Every intermediate step matches. The output port the contract logged on
 *   cycle N is compared with the output port this netlist produces on cycle N,
 *   for every N. A chip whose final state happened to agree but whose history
 *   did not would fail here, and that is exactly the chip worth catching.
 *
 * Nothing in here trusts us. The netlist is in the package, the events come
 * from whatever node the caller names, and the arithmetic happens locally. A
 * false answer would require the reader's own copy of the processor to be
 * wrong, which is what `npm run silicon` exists to rule out.
 */

"use strict";

var machine = require("../netlist/machine.js");
var chain = require("./chain.js");

/**
 * @param {string} address  the chip
 * @param {object} [opts]   { rpc, window, fromBlock }
 * @returns {Promise<object>} the verdict, with everything it rests on
 */
async function verify(address, opts) {
  var o = opts || {};

  var chip = await chain.readChip(address, o);
  var logs = await chain.history(address, {
    rpc: o.rpc,
    window: o.window,
    fromBlock: o.fromBlock,
    expect: chip.cycle,
  });

  var problems = [];

  /* A machine that has taken N cycles emitted N events. Fewer means the scan
     did not reach far enough back or the chain is missing something; more
     means something is emitting events that are not cycles. Either way the
     replay below would be running on the wrong tape, so it is refused rather
     than reported as a mismatch. */
  if (logs.length !== chip.cycle) {
    problems.push(chip.cycle + " cycles on chain but " + logs.length +
      " Stepped events found");
  }

  /* The cycles must be 1..N with nothing missing and nothing twice. */
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].cycle !== i + 1) {
      problems.push("cycle " + (i + 1) + " is missing or out of order");
      break;
    }
  }

  if (problems.length) {
    return {
      ok: false, address: address, onChain: chip,
      cyclesReplayed: 0, events: logs.length, problems: problems,
    };
  }

  /* The replay. One event, one clock edge, in the order they were mined. */
  var D = machine.loadNetlist();
  var m = new machine.Machine(D, chip.rom);
  var firstMismatch = null;

  for (i = 0; i < logs.length; i++) {
    m.inPort = logs[i].inValue;
    m.step();
    if (firstMismatch === null && m.out() !== logs[i].outPort) {
      firstMismatch = {
        cycle: logs[i].cycle,
        chain: logs[i].outPort,
        replay: m.out(),
        tx: logs[i].tx,
      };
    }
  }

  if (firstMismatch) {
    problems.push("cycle " + firstMismatch.cycle + ": the chain logged output " +
      firstMismatch.chain + ", this netlist produces " + firstMismatch.replay);
  }

  /* And the state the contract reports right now. */
  var ended = {
    cycle: m.cycle, pc: m.pc(), out: m.out(),
    carry: !!m.carry(), zero: !!m.zero(), halted: m.halted(),
  };
  ["cycle", "pc", "out", "carry", "zero", "halted"].forEach(function (k) {
    if (ended[k] !== chip[k]) {
      problems.push("final " + k + ": chain says " + chip[k] + ", replay says " + ended[k]);
    }
  });

  return {
    ok: problems.length === 0,
    address: address,
    cyclesReplayed: logs.length,
    events: logs.length,
    gates: D.gateCount,
    onChain: {
      cycle: chip.cycle, pc: chip.pc, out: chip.out,
      carry: chip.carry, zero: chip.zero, halted: chip.halted,
    },
    replayed: ended,
    firstMismatch: firstMismatch,
    problems: problems,
  };
}

module.exports = { verify: verify };
