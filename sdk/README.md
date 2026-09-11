# stepper-sdk

The STEPPER ST-8 processor, as a library: 2,161 NAND gates and 167
flip-flops, evaluated one clock edge at a time.

```
npm i stepper-sdk
```

## Run a program

```js
const stepper = require("stepper-sdk");

const { rom } = stepper.assemble(`
  loop:  in   r0
         out  r0
         jmp  loop
`);

const r = stepper.run(rom, { cycles: 12, inValue: 42 });
console.log(r.out, r.cycles, r.gates);
```

`run()` evaluates the shipped gate list in topological order and latches
every flip-flop at once. It is not a model of an instruction set: the
instruction set is what falls out of the gates.

## Verify a chip on chain

```js
const result = await stepper.verify("0x…");
console.log(result.ok, result.cyclesReplayed);
```

A chip is deterministic and all of its inputs are public. `program()`
returns its ROM; every `step()` emits `Stepped(sponsor, cycle, outPort,
inValue)`. ROM plus those events is the complete tape the machine ran on,
so `verify()` fetches both, replays the whole history on the netlist in
this package, and checks two things:

- the final cycle, program counter, output and flags match `snapshot()`
- **every logged output matches**, cycle by cycle, not just the last one

Nothing in that calculation trusts us. The netlist is here, the events come
from whatever node you name, and the arithmetic happens on your machine.

## What is not here

No launch function, no signer, no key handling. This package reads and
computes. It cannot spend.

## API

| | |
| --- | --- |
| `assemble(source)` | ST-8 assembly to a ROM |
| `run(rom, opts)` | run it on the netlist |
| `programs()` | the shipped programs, as source |
| `readChip(addr, opts)` | cycle, pc, out, flags, registers, ROM |
| `history(addr, opts)` | every `Stepped` event, in cycle order |
| `decodeStepped(log)` | one raw log to its fields |
| `verify(addr, opts)` | replay the history and check the chain agrees |
| `Machine`, `loadNetlist` | the evaluator, for building your own loop |

`opts.rpc` names the node. It defaults to Robinhood Chain mainnet.

## Licence

Apache-2.0. The name and marks are reserved under section 6; see NOTICE.
