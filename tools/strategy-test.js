/**
 * Do the four strategy programs actually work on the real netlist?
 *
 * Not "do they assemble" — do they decide the right thing. Each one gets a
 * hand-made series with a known correct answer, and the gate-level run has to
 * produce that answer or the program is wrong and goes back.
 */
const fs = require("fs");
const vm = require("vm");

const ctx = { window: {}, document: { getElementById: () => null }, console };
ctx.window.document = ctx.document;
vm.createContext(ctx);
for (const f of ["st8-data.js", "machine.js", "asm.js"]) {
  vm.runInContext(fs.readFileSync("public/scripts/" + f, "utf8"), ctx, { filename: f });
}

/* Pull the strategy table out of strategy.js without running its DOM half. */
const src = fs.readFileSync("public/scripts/strategy.js", "utf8");
const a = src.indexOf("  var STRATS = [");
const b = src.indexOf("  var ACTION =");
const STRATS = vm.runInContext("(function(){" + src.slice(a, b) + "return STRATS})()", ctx);

const D = ctx.window.ST8_DATA;
const IN = D.ops.IN, OUT = D.ops.OUT;

function run(program, bytes, cap = 60000) {
  const m = new ctx.window.ST8.Machine(program);
  const tape = [];
  let at = 0, cycles = 0;
  while (cycles < cap && !m.halted()) {
    const word = m.program.rom[m.pc()] || 0;
    const op = (word >>> 20) & 0x1f;
    if (op === IN) {
      if (at >= bytes.length) break;
      m.inPort = bytes[at];
    }
    m.step();
    cycles++;
    if (op === IN) at++;
    if (op === OUT) tape.push({ at: at - 1, sample: bytes[at - 1], action: m.out() & 3 });
  }
  return { tape, cycles, halted: m.halted() };
}

const NAME = ["HOLD", "BUY", "SELL"];
const by = (k) => STRATS.find((s) => s.key === k);

/* Each case: a series, and what a correct chip must decide for each sample
   that produces a decision. */
const CASES = [
  {
    key: "breakout",
    bytes: [100, 120, 110, 120, 130, 90, 95, 80],
    want: ["BUY", "BUY", "SELL", "HOLD", "BUY", "SELL", "HOLD", "SELL"],
    why: "the opening sample breaks the initial high, then only real breaks count",
  },
  {
    key: "momentum",
    bytes: [100, 105, 105, 90, 200],
    want: ["BUY", "HOLD", "SELL", "BUY"],
    why: "the first sample is the reference and produces no decision",
  },
  {
    key: "band",
    bytes: [128, 200, 60, 130, 88, 168],
    want: ["HOLD", "SELL", "BUY", "HOLD", "HOLD", "HOLD"],
    why: "88 and 168 are the edges, and an edge counts as inside the band",
  },
  {
    key: "streak",
    bytes: [100, 101, 102, 103, 104, 103, 102, 101, 101],
    want: ["HOLD", "HOLD", "BUY", "HOLD", "HOLD", "HOLD", "SELL", "HOLD"],
    why: "commits on the third consecutive move, then resets the count",
  },
];

let bad = 0;
for (const c of CASES) {
  const s = by(c.key);
  let program;
  try {
    program = ctx.window.ST8_ASM.assemble(s.src);
  } catch (e) {
    console.log("FAIL " + c.key + ": line " + e.line + ": " + e.message);
    bad++;
    continue;
  }
  const r = run(program, c.bytes);
  const got = r.tape.map((t) => NAME[t.action]);
  const ok = got.length === c.want.length && got.every((g, i) => g === c.want[i]);
  console.log(
    (ok ? "  ok  " : "FAIL  ") + c.key.padEnd(9) +
    program.words.toString().padStart(3) + " words  " +
    r.cycles.toString().padStart(4) + " cycles  " +
    (r.cycles / c.bytes.length).toFixed(1) + " cyc/sample"
  );
  if (!ok) {
    bad++;
    console.log("        want " + c.want.join(" "));
    console.log("        got  " + got.join(" "));
    console.log("        (" + c.why + ")");
  }
}

/* And a long soak on a realistic walk, to be sure nothing wedges or halts. */
for (const s of STRATS) {
  const p = ctx.window.ST8_ASM.assemble(s.src);
  const bytes = Array.from({ length: 220 }, (_, i) =>
    Math.max(0, Math.min(255, Math.round(128 + 90 * Math.sin(i / 11) + 30 * Math.sin(i / 3))))
  );
  const r = run(p, bytes);
  const consumed = r.tape.length ? r.tape[r.tape.length - 1].at + 1 : 0;
  const clean = !r.halted && consumed >= 219;
  if (!clean) {
    bad++;
    console.log("FAIL  " + s.key + " soak: halted=" + r.halted + " consumed=" + consumed);
  } else {
    console.log("  ok  " + s.key.padEnd(9) + "soak " + r.tape.length + " decisions over 220 samples");
  }
}

console.log(bad ? "\n" + bad + " failing" : "\nall four decide correctly on the gate-level netlist");
process.exit(bad ? 1 : 0);
