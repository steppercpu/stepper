# stepper-cli

An 8-bit processor, built from 2,161 NAND gates and 167 flip-flops, running
in your terminal.

```
npx stepper-cli
```

No wallet, no account, no network, no build step. It prints one line per
clock edge: the instruction, the output port, the sixteen registers, the
flags, and how many gates switched on that edge.

## What it actually runs

Not a simulator of an instruction set. The netlist shipped in this package
is the gate list a synthesis pass produced, and every cycle is computed by
evaluating each of those gates in topological order and then latching every
flip-flop at once. The instruction set is what falls out of the gates, not
the other way round.

It is the same netlist the browser at https://steppercpu.tech loads and the
same one a contract walks on chain, which is the point: the claim is
checkable without taking anybody's word for it, including ours.

## Usage

```
stepper                            forty cycles of the default program
stepper --prog selftest             the self-test, to its halt
stepper my.asm --in 42              your own program, your own input byte
stepper my.asm --cycles 500 --quiet
```

| Flag | |
|---|---|
| `--prog <name>` | one of the programs built into the package |
| `--in <byte>` | the value on the input port |
| `--cycles <n>` | how many clock edges to take |
| `--quiet` | the final state only |

## Verifying a chip on chain

```
npx stepper-cli verify 0x…
```

Reads every cycle a deployed chip has logged, replays each one on the
netlist in this package, and checks that every output matches and that the
final state equals the chip's own `snapshot()`. This is the one command that
uses the network.

If the default RPC endpoint cannot be reached from your network, name
another one for the same chain. The replay does not depend on which:

```
npx stepper-cli verify 0x… --rpc https://steppercpu.tech/rpc
```

## Writing a program

```asm
        ldi  r2, #0
loop:   in   r0
        add  r2, r0
        out  r2
        jmp  loop
```

Assemble and run it with `stepper that.asm`. The assembler is the same one
the browser uses.

## Requirements

Node 20 or newer. No dependencies, at all.

## Licence

Apache-2.0. See LICENSE, and NOTICE for what the licence does not grant.
