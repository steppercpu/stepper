# Addresses

Everything this project has deployed on Robinhood Chain, id 4663, with what
each one is and what it can do.

No key material is recorded here and none ever should be. These are public
addresses: the point of writing them down is that anybody can check them, and
the same list the site reads from is `public/scripts/config.js`.

Explorer: `https://robinhoodchain.blockscout.com/address/<address>`

---

## To fund the reserve

    0x94b00a1889a6ca25c578c7fd1ef488aa65ae32cc

Send STEP to that address. That is the whole procedure: there is no deposit
function because the reserve is simply the contract's balance, and there is no
way to take anything back out, including for whoever deployed it.

`edgesRemaining()` then reads how many clock edges it can pay for.

---

## The silicon

| | |
|:--|:--|
| `ST8GateArray` | `0xeB549a6c80698d3e33eA2F9ffEF2555aB918c36F` |

Pure, ownerless and stateless. Deployed once at T-0 and shared by every chip
that has existed since. 2,161 NAND gates, 11,216 bytes of code.

## The chips

| | |
|:--|:--|
| Chip #1 | `0x88d965bccc9265eac8022524723cb1eb13d6960e` |
| Its token, $CHIP1 | `0x847ce1e7505b4323ca6c06caee97d87aa8c481ca` |
| The mother chip | `0x7Fb3A882e801A49C41E678c52BceCF9B05283003` |

Chip #1 was minted through the factory on 10 September 2026 in block
59,386,859 and carries the echo program.

The mother chip was deployed directly on 12 September 2026 and carries the
digest: it folds every sponsor's byte into one number in the order they
arrived, and writes a trace into one of 256 cells each edge. It has no token
of its own, on purpose. Neither chip has an owner and neither program can be
rewritten.

## The port

Two pairs are wired. Each is a bus and the device on the far side of it.

| | ETH / USD | NVDA / USD |
|:--|:--|:--|
| `Bus` | `0x34e83464e6230aaaac358ba650fb3825c48aff0d` | `0xdca942bcf7d75f4cdcc678aa126eda61d45b4b7d` |
| `FeedPort` | `0xa3057cf7f08a2ff485b5f7608e902e1f4bfc4487` | `0x48e375b219f271488cf876d57a62168d0257decf` |
| Source | `0xf0791ed71ccd40b1b749b0aac35528cf16d103c6` | `0x5798d6c6299376aa6b790148b0f049ee570417dd` |
| Window | 1,800 to 3,200 | 150 to 270 |
| One step | 5.49 | 0.47 |
| Stale after | 3,600s | 21,600s |

One edge is: convert, present, run the gates, latch, drive. `tick()` is open to
every address, and `preview()` returns what the next edge would do before
anybody pays for it.

Both clock the mother chip. A chip has no privileged caller and no idea a bus
exists, so two instruments on one processor is the arrangement a bus was made
for. What each pair owns is its own conversion.

The stock port allows a longer silence than the crypto one. An equity does not
trade around the clock, so refusing a reading after an hour would be calling a
closed market a fault.

Neither has an owner, a pause, a setter or an upgrade path. The device is fixed
at construction and so is the window, because an owner able to move either could
rewrite what the processor sensed without touching a gate. To change either,
deploy another bus; the chip is untouched, because the chip has no idea a bus
exists.

---

## The reserve

| | |
|:--|:--|
| `CycleRebate` | `0x94b00a1889a6ca25c578c7fd1ef488aa65ae32cc` |

Advances the mother chip and pays whoever asked. 200 STEP an edge, fixed at
construction along with the token and the chip. One non-view function in the
whole ABI, no owner, no pause, no setter and nothing payable.

## The launchpad

| | |
|:--|:--|
| `ChipFactory` | `0xf209De11d54CF0967496D8eD1C79A47242eF3437` |
| `ChipRenderer`, what the factory calls | `0x371e9803432550b052da01Cb9fd8F0Fed036d83e` |
| `ChipRenderer`, corrected | `0x2f50da98e50369aeb7f08f9a2ff4777ba16d50b2` |
| The venue the factory launches through | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |

Two renderers because there are two contracts and they disagree. The factory
holds its renderer as an immutable, so the deed's own `tokenURI` calls the
first one until a new factory is deployed. The page calls the second directly.

## The token

| | |
|:--|:--|
| STEP | `0xffC3776650cD2c9641cE72838f85c0a535CC440B` |

1,000,000,000 fixed at creation, eighteen decimals, no mint function
afterwards. It pays for the clock. Nothing about holding it entitles the
holder to a payment of any kind.

---

## Not deployed

`FeeRouter`, `StepVerifier` and `ST16GateArray` are written and compiled and
have no address. When one gets one it belongs in this file on the same day,
because a list that is nearly current is worse than no list.
