# Runbook

Every command in this project, in the order you would actually run them, with
what each one proves and what it costs. Nothing here assumes you have read the
source first.

---

## 0. What you need

| | |
|---|---|
| **Node ≥ 20** | everything below |
| **A wallet with gas** | only for step 4, and only to send |

The site, the netlist and the terminal runner have **no dependencies at all**:
clone and run. The contract toolchain has dev-only ones — solc, an in-memory
EVM and ethers — so `npm install` before step 3. None of them reach the
browser.

There are **no API keys**. There is no `.env`.

---

## 1. Rebuild the processor

```bash
npm run silicon
```

Places the ST-8 gate by gate, optimises it, runs four checks, and only then
writes `public/scripts/st8-data.js`.

**It will refuse to write the file if any check fails.** That is the point: a
netlist that has not been proved does not reach the site.

| Check | What it proves |
|---|---|
| 1 | Every ALU operation, swept exhaustively against arithmetic |
| 2 | The gates match an independent model, cycle for cycle |
| 3 | Check 2, but through the `machine.js` your browser loads |
| 4 | `ledger` never halts; `selftest` halts having passed |

**Changing the processor:** edit `tools/netlist/st8.js`, run this again. If it
passes, the new netlist is written and everything downstream picks it up. The
gate count it prints is the number every other file quotes, so anything that
repeats it has to be updated to match.

```bash
npm run st16       # the same description at sixteen bits, verified separately
```

---

## 2. Build the launch contracts

```bash
npm run t0
```

Writes `public/scripts/abi.js`. The Solidity is emitted by `npm run array`
and
`public/scripts/abi.js`, and runs two more checks on top of the four above:

| Check | What it proves |
|---|---|
| 5 | The packed gate table decodes and re-executes identically |
| 6 | The chip's ROM encoding, RAM packing and state word are correct |

It also derives every function selector by hashing the contract signature, and
verifies its own Keccak against published vectors before trusting it. **Do not
paste a selector from anywhere.** This is why: the site shipped for weeks
sending `tick(uint256,uint8)` at a contract whose function is `step`.

`abi.js` is generated. Editing it by hand will be overwritten.

---

## 3. Prove it in a real EVM  ⟵ *done*

```bash
npm run array              # emit contracts/ST8GateArray.sol
npm run array -- -w 16     # emit contracts/ST16GateArray.sol
npm run compile            # solc, and the EIP-170 ceiling
npm run evm                # deploy into an EVM and prove every generation
```

This was the last thing standing between "the silicon is proved" and "the
contract is proved", and it is no longer outstanding.

`npm run evm` deploys each gate array into an in-memory EVM, deploys `Chip`
against it, and then, after **every single block**, compares the chip's cycle,
program counter, output port, both flags, the halt bit and all sixteen
registers against an independent reference model of the same width. At the end
it reads all 256 RAM cells back and compares those too. It does this for the
ST-8 and for the ST-16.

It also writes `contracts/out/gas-report.json`, which is where the numbers in
`config.js` come from. They are measured, and the site now says so.

### What it found

Two real bugs that no amount of JavaScript checking would have caught:

- `ST8Chip._rom(uint256 pc)` did not compile. Inside an assembly block `pc`
  is the Yul builtin for the program-counter opcode, and solc refuses to
  compile a block where a variable shadows it.
- The original `step(uint256 state, ...)` signature cannot carry an ST-16 at
  all. 311 flip-flops do not fit in a `uint256`, and the ST-16's program
  counter sits at bit 256 rather than 128, so a chip with `PC_SHIFT = 128`
  compiled into it would read garbage.

Both are fixed. The interface is now `IGateArray`, every width and offset is
read from `spec()`, and one `Chip` bytecode runs both generations.

### Measured

| | ST-8 | ST-16 |
|---|---|---|
| Deploy the gate array | 2,193,536 | 3,599,037 |
| Deploy a chip | 1,237,919 | 1,237,913 |
| One `step()` | 370,085 | 649,074 |
| Deployed size | 11,216 B | 18,339 B |
| Of the 24,576-byte ceiling | 45.6% | 74.6% |

Execution gas. A transaction adds 21,000 intrinsic on top.

---

## 4. T-0: the processor

Everything below is `npm run deploy`. It is documented end to end in
[docs/deploy.md](docs/deploy.md); this is the short version.

### Is it free?

**No, and it is close enough that the difference stops mattering.** The chain
quotes 3,889,645 gas for both deployments, which at the price it was offering
when this was written is **0.0013 ETH**.

The gate array is the expensive half and it is paid **once, by whoever deploys
it first**. Every chip afterwards points at that one address and pays nothing
for the silicon again. That is why the array is `pure` and ownerless.

### The order, and it matters


```bash
npm run deploy -- --network testnet            # preflight the rehearsal
export STEPPER_KEY=0x…                         # never a file, never an argument
npm run deploy -- --network testnet --go --step

npm run deploy -- --network mainnet            # then the real thing
npm run deploy -- --network mainnet --go --step
```

Chain 46630 is the testnet for 4663. It quotes gas at a fortieth of the price
and the sequence is identical, so the rehearsal costs about four hundredths of
a millicent and catches everything the in-memory EVM cannot: signing, nonces,
the chain's own gas accounting, and the write back into `config.js`.

In order, and every step of it verified rather than assumed:

1. `ST8GateArray` goes out, and its on-chain bytecode is compared byte for
   byte against what `npm run compile` produced. A mismatch stops everything.
2. `Chip` goes out against that address, with `ledger` in its ROM.
3. `spec()` is read back through the chip and printed.
4. `program()` is read back and compared to the ROM that went in.
5. `snapshot()` is called exactly the way the website calls it.
6. `--step` takes the first cycle, so the chip is live rather than at zero.
7. `public/scripts/config.js` is rewritten with both addresses.

If `snapshot()` comes back with `cycle = 1` and a program counter that moved,
the processor is alive on chain and T-0 has happened.

The script refuses to send if the chain id does not match `config.js`, if the
balance is under the estimate plus twenty per cent, or if `config.js` already
names an address. `--go` is required; there is no way to send by accident.

---

## 5. R1: the launchpad

R1 was going to wait behind T-0. It no longer does, and the reason is that the
dependency turned out to be smaller than the plan assumed: **the launchpad
needs the gate array, not chip #1.** The factory deploys its own chips against
the array, so chip #1 can be the first chip launched through the launchpad,
with a token and a card like everybody else's, instead of a separate
deployment that has neither.

| Contract | Deployed | What it is |
|---|---|---|
| `ChipRenderer` | 6,668 B | draws a chip's card from the chip's own address. `pure`, no storage, no owner |
| `ChipFactory` | 15,757 B | one call: deploy a processor, launch its token, mint the deed |

```bash
npm run compile          # six contracts, all inside the EIP-170 ceiling
npm run abi              # the page's encoder against an independent one
npm run launchpad        # the R1 contracts, in a real EVM
```

### What the tests are for

Two of them exist because of bugs that were found by writing them, and both
would have been expensive:

**The fee recipient.** The venue reads a zero fee recipient as "whoever called
me", and whoever calls it is the factory. A factory that passed a zero
straight through would have quietly become the creator of every token launched
on it, collecting fees belonging to somebody else, with nothing about the
transaction looking wrong. The factory now replaces a zero with the sender,
and the test asserts it from the venue's side rather than from the factory's.

**The change.** The whole of `msg.value` is forwarded so the opening buy can
be made out of it, and the venue hands back what the buy did not spend. The
factory had no `receive`, so every launch that sent more than the fee reverted
— which is every launch anybody would actually want to make.

### The testnet cannot rehearse a launch

Checked, not assumed: the venue's address **has no code on chain 46630**. The
token half of a chip launch has nothing to call there, so `deploy-launchpad`
refuses on the testnet rather than deploying a factory pointed at nothing.

Rehearse the gate array there anyway. It is the expensive transaction, and the
rehearsal still proves signing, nonces, the chain's gas accounting and the
write back into `config.js`.

### The order

```bash
export STEPPER_KEY=0x…                              # never a file, never an argument

npm run deploy -- --network testnet --array-only            # preflight
npm run deploy -- --network testnet --array-only --go       # rehearse the silicon

npm run deploy -- --array-only                              # preflight, mainnet
npm run deploy -- --array-only --go                         # the silicon, once, for ever

npm run deploy-launchpad                                    # preflight
npm run deploy-launchpad -- --go                            # renderer, then factory
```

Then set `launchpadOpen: true` in `public/scripts/config.js` by hand and
publish. It is deliberately not flipped by a script: the page going live is a
decision, and the addresses being written is not the same thing as being ready
to send people at it.

### What it costs

Priced from the chain, not estimated:

| | gas | |
|---|---|---|
| `ST8GateArray` | 2,487,673 | paid once, by whoever deploys it first |
| `ChipRenderer` | 1,507,649 | |
| `ChipFactory` | 3,474,364 | it carries a whole processor's creation code |
| **total** | **7,469,686** | **about 0.0013 ETH** at the price when this was written |

Every launch after that costs its creator the venue's fee, **0.0005 ETH**,
plus gas and whatever they choose to spend on their opening buy.

### Still not built

| Not built | Why it can wait |
|---|---|
| A per-chip fee router | `FeeRouter` exists and is compiled; it is not tested yet |
| Mining reserve, emission | the clock works without paying anyone |
| A fleet index | the `Launched` event carries everything an index would |

Two traps remain documented and both are permanent if you get them wrong:
**fund a reserve before attaching a token**, and on an L2 be certain which
block number you are counting.

---

## Command reference

| Command | Needs | Writes |
|---|---|---|
| `npm run step` | Node | nothing, prints cycles |
| `npm run array` | Node | `contracts/ST8GateArray.sol` (or ST16) |
| `npm run compile` | Node + solc | `contracts/out/*.json` |
| `npm run evm` | Node | `contracts/out/gas-report.json` |
| `npm run deploy` | Node + chain | `public/scripts/config.js`, once sent |
| `npm run silicon` | Node | `public/scripts/st8-data.js` |
| `npm run t0` | Node | `public/scripts/abi.js` |
| `npm run st16` | Node | nothing, reports only |
| `npm run strategy` | Node | nothing, checks the four programs |
| `npm run launchpad` | Node | `contracts/out/card-preview.svg` |
| `npm run abi` | Node | nothing, checks the page encodes the call |
| `npm run deploy-launchpad` | Node + chain | `public/scripts/config.js`, once sent |
| `npm run cli` | Node | `cli/`, the standalone package |
| `npm test` | Node | same as `npm run silicon` |
