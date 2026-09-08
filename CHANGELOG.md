# Changelog

Notable changes to the processor and its toolchain.

This repository holds the chip and the command line. The website, the brand
assets and the hosting configuration are not published here, so changes to
those do not appear below.

Dates are the day the work landed. Every figure quoted is one a command in
this repository prints.

## Unreleased

### Added

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
