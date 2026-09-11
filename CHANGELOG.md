# Changelog

Notable changes to the processor and its toolchain.

This repository holds the chip and the command line. The website, the brand
assets and the hosting configuration are not published here, so changes to
those do not appear below.

Dates are the day the work landed. Every figure quoted is one a command in
this repository prints.

## Unreleased

### Added

- **`stepper-cli` 0.2.0: `verify`.** `npx stepper-cli verify 0x…` reads every
  cycle a deployed chip has logged, replays each one on the netlist in the
  package, and checks every output and the final `snapshot()`. 0.1.0 shipped
  without it, so on that version the address was read as a program file.
  `--rpc` names another endpoint for the same chain when the default one
  cannot be reached, and the error for an unreachable endpoint now says so.

## 0.3.0

One chip becomes many. This release adds the contracts that let anybody
deploy their own processor and its token in a single transaction, a package
that runs the machine with no chain involved at all, and a router for the
fees the arrangement produces.

### Added

- **`stepper-cli`, published on npm at 0.1.0.** `npx stepper-cli` assembles a
  program and runs it against the same netlist the contracts carry — no
  wallet, no account, nothing cloned. It keeps its own version line because
  it is its own package; the number above this section is the repository's.

- **`ChipFactory` and `ChipRenderer`.** One transaction deploys a chip and
  launches its token, and the factory keeps neither: the chip, the tokens it
  bought and any change all go back to the caller. `ChipRenderer` is `pure`
  from end to end and returns the card as a data URI, so a chip's image is
  read off the chain rather than fetched from a server that has to stay up.

- **`FeeRouter`.** Creator fees land in escrow, and this collects and splits
  them along shares fixed at construction. It has no withdrawal function at
  all — a claim worth testing rather than a comment, so `npm run router`
  deploys it into a real EVM and puts 25 checks to it, one of which is that
  no withdrawal path exists anywhere in the ABI.

- **`npm run router` and `npm run launchpad`.** Two suites over the new
  contracts. The launchpad one also writes `contracts/out/card-preview.svg`,
  so the card a chip would own can be looked at before anything is deployed.

- **Event topics in `abi.js`.** The generated ABI file carried function
  selectors only. It now also carries the topic hash for `Stepped`, derived
  at build time by `tools/build-contract.js` from the same keccak
  implementation the selectors use, and checked against published vectors
  before anything is written.

  This is what makes a chip's history readable without an indexer.
  `Stepped(address indexed sponsor, uint40 indexed cycle, uint256 outPort,
  uint256 inValue)` records the input byte and the cycle it went in on, so
  the log plus `program()` is the complete tape a deterministic machine ran
  on. Anyone holding the netlist can recompute the whole history and compare
  it against `snapshot()`.

- **A pair list in `config.js`.** A chip's liquidity pool is created against
  an ERC-20, and any ERC-20 on the chain will do. The new `pairs` field is a
  list of shortcuts rather than a whitelist, and every entry keeps a `null`
  address until one has been read off the chain, which is the rule every
  other address in that file already follows.

### Changed

- `tools/build-contract.js` derives event topics alongside selectors. A topic
  is the whole digest rather than its first four bytes, so it could not come
  from `selector()` and has its own path.

## 0.2.0

First public commit: the processor, the toolchain that builds and proves it,
and the contracts it runs inside.

- **2,425 gates placed, 2,161 shipped.** The optimiser folds constants, shares
  repeated logic and drops what nothing reads. Eleven per cent of the die was
  doing no work, and building it first was the only way to find that out.
- **167 flip-flops**, 16 registers, 256 bytes of RAM, 32 instructions, all of
  them used.
- **Verified before it ships.** `npm run silicon` runs an exhaustive 1,052,672
  vector sweep of the ALU, a cycle-for-cycle differential run against an
  independent model, that same run through the shipped runner, and a liveness
  check. It writes nothing at all unless every one of them passes.
- **Both generations proved in a real EVM.** `npm run evm` deploys the gate
  array and a chip into an in-memory EVM and compares every observable after
  every block, then reads all 256 RAM cells back. ST-8 and ST-16 from one
  description, with zero contract rewrites between them.
- Licensed Apache-2.0, with the name and marks reserved under section 6.
  `NOTICE` records which is which and travels with any fork.
