<div align="center">

<img src="https://steppercpu.tech/brand/raster/mark-256.png" alt="STEPPER" width="120">

# STEPPER

**A real 8-bit processor, built gate by gate, that runs inside a smart contract.**

*The chain is the clock.*

[![Licence](https://img.shields.io/badge/licence-Apache--2.0-2f6f4e)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-2f6f4e)](package.json)
[![Gates](https://img.shields.io/badge/NAND%20gates-2%2C161-1f5c8b)](public/scripts/st8-data.js)
[![Flip-flops](https://img.shields.io/badge/flip--flops-167-1f5c8b)](tools/netlist/st8.js)
[![Vectors](https://img.shields.io/badge/vectors-1%2C052%2C672%20passing-1f5c8b)](tools/build-netlist.js)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-none-6b7280)](package.json)

[**steppercpu.tech**](https://steppercpu.tech) &nbsp;·&nbsp; [Telegram](https://t.me/steppercpu) &nbsp;·&nbsp; [X](https://x.com/steppercpu) &nbsp;·&nbsp; [Runbook](RUNBOOK.md) &nbsp;·&nbsp; [Security](SECURITY.md)

</div>

---

Most "on-chain CPU" projects ship a picture of a processor. This one ships the
processor: **2,161 NAND gates and 167 flip-flops**, placed one at a time by a
program in this repository, verified against an independent model, and walked
gate by gate by a contract.

No Verilog. No synthesiser. No imported netlist. No runtime dependencies.

Or run it without cloning anything at all:

```bash
npx stepper-cli
```

```bash
git clone https://github.com/steppercpu/stepper && cd stepper
npm install        # dev-only: solc, an in-memory EVM, ethers
npm run silicon    # place 2,425 gates, optimise to 2,161, verify all of them
npm run step       # watch it execute, one clock edge per line
```

If `npm run silicon` writes a netlist that differs from the committed one, that
is a finding. [SECURITY.md](SECURITY.md) says where to send it.

---

## What is in here

|  | |
|---|---|
| **The description** | `tools/netlist/st8.js` composes an 8-bit CPU out of one primitive |
| **The toolchain** | place, optimise, prove, emit as Solidity, run in an EVM, deploy |
| **The contracts** | the gate array, the chip that walks it, the interfaces between |
| **The netlist** | 2,161 gates, walked identically by a terminal, a browser and a contract |

The website, the brand assets and the hosting configuration are deliberately
not published here. They are a different job from the processor, and this
repository is about the processor.

---

## How it is built

One primitive, and everything else composed from it.

```
   tools/netlist/builder.js     nand(a, b)                    one primitive
              |
   tools/netlist/st8.js         ALU, regfile, decoder, PC     2,425 gates placed
              |
   tools/netlist/optimise.js    fold, share, drop dead nets     264 removed
              |
   public/scripts/st8-data.js   topological gate table        2,161 gates shipped
              |
   contracts/ST8GateArray.sol   the same table, on chain      11,216 of 24,576 B
```

Topological order comes free: a gate can only name nets that already exist, so
emitting in call order emits in dependency order.

**2,425 placed, 2,161 shipped.** The optimiser found that eleven per cent of the
die was doing no work, and the only way to know that was to build it first.

### The build refuses to ship unverified

`npm run silicon` writes nothing at all unless every check passes. A test suite
you can skip is decoration.

| # | Check | What it proves |
|:--|:--|:--|
| **1** | Combinational sweep, driving the gates directly | 1,052,672 vectors over 21 operations, exhaustive in every operand |
| **2** | Netlist against an independent behavioural model | the gates implement the ISA, cycle for cycle, RAM included |
| **3** | Check 2 through the shipped `machine.js` | the real runner works, not a copy of it |
| **4** | Liveness | `ledger` never halts in 20,000 cycles; `selftest` halts having passed |

The model in check 2 is deliberately written the ordinary way, in `+` and `&`,
so that it *can* disagree with the gates. Four variations of the same check
would only prove the check.

---

## The clock is the chain

A processor needs something to tell it when to advance. This one has blocks.

```solidity
function step(uint256 cycles) external;
```

No owner check. No keeper. No schedule. Whoever pays the gas takes the step, and
the event records them as that cycle's sponsor.

> A chip runs exactly as fast as somebody is willing to pay for, and stalls when
> nobody thinks the next cycle is worth it. That is not a limitation being
> worked around. It is a price signal on a machine whose clock belongs to
> nobody.

<details>
<summary><b>Why put a processor on a chain at all, when it is slower?</b></summary>

<br>

Not for speed, and anyone claiming otherwise is selling a thermodynamics that
does not exist. A chain does not replace silicon, it runs on silicon, once per
validator. On-chain compute is a datacenter multiplied by the size of the
validator set.

Redundancy is the cost. What it buys is the one thing no amount of silicon gives
you on its own: **a chip in a datacenter cannot prove what it did.** This one
can. Every cycle is public, deterministic, and re-executable by anyone straight
from the gate table.

</details>

---

## Commands

```bash
npm run silicon    # place, optimise, verify, emit the netlist
npm run step       # the processor in your terminal, on the shipped table
npm run strategy   # four real programs, decided on the real gates
npm run array      # emit a gate array contract   (-- -w 16 for the next one)
npm run t0         # selectors, packing checks, emit the ABI
npm run compile    # solc, and the EIP-170 ceiling
npm run evm        # both generations, deployed into an EVM and proved
npm run st16       # build and verify the 16-bit generation
npm run deploy     # preflight; -- --network testnet to rehearse, --go to send
npm run cli        # assemble cli/, the processor as a standalone package
npm run launchpad  # the R1 contracts, in a real EVM
npm run router     # the fee router, in a real EVM
npm run abi        # the page encoder against an independent one
npm test           # same as npm run silicon
```

[**RUNBOOK.md**](RUNBOOK.md) is every one of them in the order you would
actually run it, with what each proves and what it costs.

Node 20 or newer. The processor and the terminal runner have **no dependencies
at all** — clone and run. Only the contract toolchain needs `npm install`, and
none of what it pulls in ever reaches a browser.

<details>
<summary><b><code>npm run step</code> — the ST-8 in a terminal</b></summary>

<br>

The same table the browser walks and the contract walks.

```bash
npm run step                         # 40 cycles of the program chip #1 carries
npm run step -- --prog selftest -q   # the self-test, to its halt
npm run step -- fib.asm --in 42      # your own file, your own input byte
npm run step -- --help
```

Each line is one clock edge: the instruction, the output port, the first three
registers, the flags, and how many gates flipped on that edge.

</details>

<details>
<summary><b><code>npm run cli</code> — the same processor, as a package</b></summary>

<br>

`npm run step` needs this repository. Not everybody who wants to see a
processor run wants to clone one, so `npm run cli` assembles `cli/`: a
self-contained package holding the runner, the assembler and the netlist, with
no dependencies and nothing else in it.

It is generated rather than written, and that is the point. The published
processor has to be the processor this repository demonstrates and the
contract walks; copying those files by hand is how the two quietly stop being
the same machine. Rebuild it after `npm run silicon` and the package ships the
netlist that was just verified.

```bash
npm run cli                     # writes cli/
node cli/bin/stepper.js         # run it exactly as a stranger would
```

**Nothing is published.** Publishing is `npm publish` from `cli/`, and it is a
decision rather than a build step, so no script in here performs it.

</details>

---

## The instruction set

**Five bits of opcode. Thirty-two instructions. All thirty-two used** — which is
arithmetic rather than ambition: a five-bit field addresses thirty-two things.

- `nand` is in the set because it is the only primitive the die is built from.
  Everything else on the chip is composed out of it, so the one instruction that
  is not composed of anything is the one worth naming.
- `ld` takes two cycles and everything else takes one. The address latches on
  one edge and the data arrives on the next, which is how synchronous memory has
  behaved since the first one was built. A design that pretended otherwise would
  be lying about where its state lives.

---

## Generations

The core is width-parameterised, so a generation is a **deployment rather than a
migration**.

| | ST-8 | ST-16 |
|:--|--:|--:|
| NAND gates | 2,161 | 3,787 |
| Flip-flops | 167 | 311 |
| Contract rewrites between them | — | **zero** |

```bash
npm run array -- -w 16
```

`IGateArray.spec()` returns every width, size and bit offset a reader would
otherwise hardcode, and `Chip` reads all of them at construction. One `Chip`
bytecode runs both generations, and `npm run evm` proves it rather than this
file asserting it.

There is no v2 because there is nothing to migrate. The contracts holding the
silicon are pure and ownerless, so new generations land beside the old rather
than over them.

---

## Layout

```
tools/
  netlist/
    builder.js       the NAND primitive, and everything derived from it
    st8.js           the processor, described structurally
    optimise.js      constant folding, shared logic, dead nets
    asm.js           the assembler, and the shipped programs
    model.js         the reference model, written to disagree
    keccak.js        selectors, with no dependency
  build-netlist.js   fabricate, optimise, verify, emit
  build-array.js     the netlist as a Solidity contract
  emit-array.js      the packing, and the EIP-170 arithmetic
  build-contract.js  selectors, ABI, and the packing checks
  build-st16.js      the same description at sixteen bits
  compile.js         solc, and the deployed-size ceiling
  evm-test.js        both generations, in a real EVM, block by block
  deploy.js          preflight, rehearsal, and the send
  run.js             the processor in a terminal
  rpc.js             JSON-RPC over Node's own http
  cli.js             the banner every script prints
  strategy-test.js   the four programs, on the gates
  build-cli.js       assemble cli/ from the sources above

cli/                 GENERATED. the processor as one installable package:
                     the runner, the assembler and the netlist, and nothing
                     else. Not published.

contracts/
  IGateArray.sol     spec() and step(), generation-agnostic
  IBus.sol           sense() / window() / drive(), and the bus that ticks them
  Chip.sol           one chip: ROM, RAM, state, and an open step()
  ST8GateArray.sol   generated, 2,161 gates
  ST16GateArray.sol  generated, 3,787 gates

public/scripts/      the parts of the site that are the processor itself
  st8-data.js        the netlist. GENERATED, never edit by hand
  machine.js         the gate walk and the latch
  asm.js             the assembler, in the browser
  strategy.js        four programs that decide
  abi.js             GENERATED by npm run t0
  config.js          chain endpoints and addresses, null until real

docs/deploy.md       what goes on chain, in what order, at what measured cost
```

**Changing the processor:** edit `tools/netlist/st8.js` and run
`npm run silicon`. If the checks pass the new netlist is written. If they do
not, nothing is written and the old netlist stands.

---

## Status

| | |
|:--|:--|
| The processor: placed, optimised, verified | **2,161 gates, ours** |
| The optimiser | 2,425 placed, 2,161 shipped |
| ST-16, from the same description | 3,787 gates, builds and holds |
| `ST8GateArray.sol` and the packing check | 11,216 B of the 24,576 B ceiling |
| Compiled and proved in a real EVM | **done**, both generations |
| The token, on Robinhood Chain 4663 | **live.** `0xffC3776650cD2c9641cE72838f85c0a535CC440B` |
| The processor, deployed on chain | **not yet.** `config.js` holds `null` for it, and the interface says so |
| Gas figures | measured by `npm run evm`, never estimated |

> A button that pretends to work is worse than a button that says it does not.

### The token

| | |
|:--|:--|
| Name | Stepper CPU |
| Symbol | STEP |
| Decimals | 18 |
| Total supply | 1,000,000,000, fixed at creation, no mint function after |
| Chain | Robinhood Chain, id 4663 |
| Contract | `0xffC3776650cD2c9641cE72838f85c0a535CC440B` |
| Explorer | [blockscout](https://robinhoodchain.blockscout.com/address/0xffC3776650cD2c9641cE72838f85c0a535CC440B) |
| Market | [pons](https://www.ponsfamily.com/launchpad/0xffC3776650cD2c9641cE72838f85c0a535CC440B) |
| Curve | **graduated.** `graduated()` on the curve reads true and it holds no supply and no ether |

Every field was read off the chain rather than copied from a launch form, and
the address carries a valid EIP-55 checksum.

The curve has since graduated: it holds nothing, and the liquidity it raised
sits in the venue's locked pool rather than anywhere the creator can reach.
That is the venue's rule and not a promise of ours, which is why it is stated
as a thing you can read off `graduated()` rather than as an assurance.

The processor here ran before the token existed and runs now with no wallet
attached, in a browser and in a terminal. The token does one job: it pays for
the clock. A processor with no oscillator needs somebody to want the next edge
enough to buy it, and `step()` is open to anyone.

There is no staking, no emissions schedule, no revenue share and no
governance, and nothing about holding STEP entitles the holder to a payment of
any kind. What it buys is clock edges.

---

## Licence

**Apache License 2.0** — see [LICENSE](LICENSE).

The code is open: the netlist, the toolchain, the contracts. Fork it, run it,
build on it, sell what you make with it. That is why it is published.

The **name and the marks are not licensed.** Apache-2.0 section 6 grants no
trademark rights, and [NOTICE](NOTICE) records what that covers: the name
STEPPER, the part names ST-8 and ST-16, the ticker, the logo, and the domain.

A fork is welcome to be a processor on a chain. It may not present itself as
this one. This project is associated with a token, and that is exactly where the
distinction stops being cosmetic and starts mattering to somebody deciding what
to buy.

Naming STEPPER in documentation, comparison or commentary needs no permission
from anyone. Section 6 says so explicitly.

[NOTICE](NOTICE) travels with any fork under clause 4(d), so the reservation
above cannot be quietly dropped downstream. Build dependencies are declared in
[package.json](package.json), fetched by npm, and never vendored here.

<div align="center">

<br>

**[steppercpu.tech](https://steppercpu.tech)**

*One block, one step.*

</div>
