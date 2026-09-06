# Going live

What has to be deployed for STEPPER to run on chain 4663, in the order it goes
out, with the numbers measured rather than estimated.

Every figure below came from a command in this repository. Nothing here is
copied from another project and nothing is rounded up.

---

## What gets deployed

Two contracts at T-0. That is the whole launch.

| # | Contract | What it is | Deployed size | Deploy gas |
|---|----------|------------|---------------|------------|
| 1 | `ST8GateArray` | The silicon. Pure, stateless, ownerless. | 11,216 B (45.6% of the EIP-170 ceiling) | 2,431,028 |
| 2 | `Chip` | Chip #1: ROM, RAM, state, and an open `step()`. | 6,036 B (24.6%) | ~1,477,000 |

**Total: ~3,889,645 gas.** At the gas price the chain was quoting when this was
written (0.3475 gwei) that is **0.00135 ETH**.

One `step()` costs **390,975 gas** including the 21,000 intrinsic, which is
**0.00014 ETH** per block.

`IGateArray.sol` is an interface and deploys nothing.
`ST16GateArray.sol` is R2 and is not deployed at T-0, but it is built,
compiled and tested now so that the interface it needs is the interface that
ships today.

### Why the gate array is the expensive one and the only one

It is `pure`, holds no state and has no owner, so every chip that will ever
exist can point at a single deployment. The 2.4 million gas is paid once, by
whoever deploys it first, and never again — not by chip #2, not by the
launchpad at R1, not by the court at R3.

---

## Flexible by construction

The one thing that can never be changed after T-0 is the shape of the
interface, so it was designed against the generation that does not ship yet.

`IGateArray.spec()` returns every width, size and bit offset a reader would
otherwise hardcode. `Chip` reads all of them at construction and stores them as
immutables. The result is that **the same `Chip` bytecode runs both
generations**, verified:

| | ST-8 | ST-16 |
|---|------|-------|
| NAND gates | 2,161 | 3,787 |
| Flip-flops | 167 | 311 |
| State words | 1 | **2** |
| Program counter at bit | 128 | **256** |
| Output port width | 8 | 16 |
| RAM | 256 cells × 8 bits | 256 cells × 16 bits |
| Gate array size | 11,216 B | 18,339 B (74.6%) |
| `step()` execution gas | 369,975 | 648,414 |
| `Chip` bytecode | identical | identical |
| Reentrancy guard | transient, +142 gas | transient, +142 gas |

The program counter moving from bit 128 to bit 256 is the reason this matters.
A chip with `PC_SHIFT = 128` compiled into it reads garbage on an ST-16. A chip
that asks `spec()` does not.

R2 therefore deploys **one** new contract — `ST16GateArray` — and every other
piece is already the piece that handles it.

---

## Before anything is sent

Run these in order. Each one refuses to continue if the one before it was
wrong.

```bash
npm run silicon    # place, optimise, four checks, rewrite st8-data.js
npm run t0         # selectors, packing, checks 5 and 6, rewrite abi.js
npm run array              # emit contracts/ST8GateArray.sol
npm run array -- -w 16     # emit contracts/ST16GateArray.sol
npm run compile    # solc, and the EIP-170 ceiling
npm run evm        # deploy both generations into an EVM and prove them
```

`npm run evm` is the one that used to be missing. It deploys each generation
into an in-memory EVM, calls `step()` once per block, and after **every single
block** compares the chip's cycle, program counter, output port, both flags,
the halt bit and all sixteen registers against an independent reference model
of the same width. Then it reads all 256 RAM cells back and compares those too.

It also writes `contracts/out/gas-report.json`, which is where the gas figures
on this page and in the deploy preflight come from.

---

## Rehearse on the testnet first

Chain 4663 has a testnet at **46630**, and the whole sequence runs there
unchanged:

```bash
npm run deploy -- --network testnet
export STEPPER_KEY=0x...
npm run deploy -- --network testnet --go --step
```

| | mainnet 4663 | testnet 46630 |
|---|---|---|
| RPC | `rpc.mainnet.chain.robinhood.com` | `rpc.testnet.chain.robinhood.com` |
| Gas price, when measured | 0.40 gwei | **0.01 gwei** |
| Both deployments | ~0.0016 ETH | **~0.000043 ETH** |
| One `step()` | ~0.00016 ETH | ~0.0000039 ETH |
| Block explorer | Blockscout | none published |

The addresses are written back into that network's own block in
`config.js`, and `NETWORK` is flipped to it, so a rehearsal can never leave
an address sitting in the mainnet slot. Whichever network is live, the site
names it: on anything but mainnet the chain label reads
`CHAIN 46630 · TESTNET`, because a rehearsal that looks like a launch is the
one thing this page must not be.

### What the rehearsal actually proves

`npm run evm` already runs the contracts in an EVM, so the testnet is not
there to re-check the arithmetic. It is there for everything the EVM harness
cannot touch:

- transaction encoding, signing and nonces against a real node
- the chain's own gas accounting, which is not the EVM's: it quoted
  2,759,185 for the gate array where the in-memory EVM measured 2,193,536,
  because an Orbit chain prices calldata separately
- the DNS-over-HTTPS path in `tools/rpc.js`, against a real endpoint
- the bytecode comparison, the `spec()` and `program()` read-backs, and the
  write into `config.js` — the parts of the script that only run on `--go`

### What it does not give you

No public block explorer answered for 46630 when this was written, so there is
no page to link a transaction to. The deploy script does not need one: it
reads the deployed bytecode back and compares it byte for byte, reads
`spec()` and `program()` through the chip, and calls `snapshot()` exactly the
way the website does. If those four agree, the chip is live whether or not
anybody has built an explorer for it.

You will need testnet ETH on 46630. There is no faucet documented here because
none was found; that part is yours to arrange.

---

## The deploy

### 1. Preflight

```bash
npm run deploy                        # whichever network config.js says is live
npm run deploy -- --network testnet   # or name one
```

Sends nothing. It dials the chain, checks the chain id against `config.js`,
reads the current gas price, prices both deployments against the live chain and
prints the total in ETH. Run it with no key set and it still prices everything.

### 2. The key

```bash
export STEPPER_KEY=0x...
```

Read from the environment only. Never from a file in the repository, never as a
command-line argument, because arguments end up in shell history.

Fund that address with a little more than the preflight quotes. The script
refuses to send if the balance is under the estimate plus twenty per cent.

### 3. Send

```bash
npm run deploy -- --go --step
```

In order:

1. `ST8GateArray` is deployed and its on-chain bytecode is compared, byte for
   byte, against what `npm run compile` produced. A mismatch stops everything.
2. `Chip` is deployed against that address, with `ledger` in its ROM.
3. `spec()` is read back through the chip and printed.
4. `program()` is read back and compared to the ROM that went in.
5. `snapshot()` is called exactly the way the website calls it.
6. With `--step`, the first cycle is taken so the chip is live rather than
   sitting at zero.
7. `public/scripts/config.js` is rewritten with both addresses.

### 4. Publish

Deploy the site however it is hosted. It reads `config.js`, so the moment the
addresses are in it, the clock panel stops saying "opens at T-0" and starts
reading the real chip over `eth_call`.

Nothing about the chain deployment depends on where the site runs. The
contracts are live from step 3; publishing is only how a reader sees them.

---

## What you need

| | |
|---|---|
| **Chain** | 4663, an Arbitrum Orbit chain |
| **RPC** | `https://rpc.mainnet.chain.robinhood.com` |
| **Explorer** | `https://robinhoodchain.blockscout.com` |
| **Funds** | ~0.002 ETH on chain 4663 covers the deploy with room to spare |
| **Node** | 20 or newer |
| **Everything else** | `npm install`, which pulls solc, an EVM and ethers as dev dependencies |

Nothing else. No Foundry, no Docker, no hosted node, no API key.

### If the RPC will not resolve

Some consumer ISPs answer a lookup for the RPC host with their own block page:

```
$ nslookup rpc.mainnet.chain.robinhood.com
Name:    rpz.biznet                          <- not the chain

$ nslookup rpc.mainnet.chain.robinhood.com 8.8.8.8
Name:    customer-origin.offchainlabs.com    <- the chain
```

`tools/rpc.js` resolves the host over DNS-over-HTTPS and connects to the address
that comes back, with the real hostname pinned as the TLS server name. The
certificate is still verified against the real host, so this routes around a
hijacked resolver without weakening anything. It is on by default; set
`STEPPER_NO_DOH=1` to use the system resolver instead.

---

## After T-0

`config.js` also holds `factory`, `renderer`, `token` and `launchpadOpen`.
Those are R1 and every one of them is `null` until the contract behind it
exists. The site renders its honest disabled state from exactly those fields,
so nothing on the page can claim to be live before it is.

The gate array deployed at T-0 does not move again. R1 adds a factory that
mints more `Chip`s against it; R2 adds `ST16GateArray` beside it. Neither
touches what is already there, because neither can: it is `pure` and it has no
owner.
