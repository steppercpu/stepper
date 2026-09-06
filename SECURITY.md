# Security

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository:
*Security → Report a vulnerability*. It is private to the maintainers, it does
not create a public issue, and it needs no email address from either side.

If that is unavailable, a direct message to the account listed on
<https://steppercpu.tech> will do. **Do not open a public issue for anything
that affects deployed contracts or funds.**

Please include what you were running (`npm run silicon` output, a commit hash,
a chain id) and the smallest input that reproduces it. There is no bug bounty
programme.

## What is in scope

| Area | In scope | Notes |
|---|---|---|
| `contracts/` | **yes** | Anything deployed holds value or advances a chip |
| `tools/build-netlist.js` and `tools/netlist/` | **yes** | A wrong gate is a wrong processor everywhere |
| `public/scripts/` | **yes** | Runs in a reader's browser and touches their wallet |
| `server.js` | **yes** | Serves the site; path traversal especially |
| Deployment and DNS | yes, quietly | Report privately, never in an issue |

The most valuable report is a **differential** one: a program, an input, or an
ALU vector where the netlist and the reference model in `tools/netlist/model.js`
disagree. That is the failure this project's entire test discipline exists to
catch, and a case that slips past all five checks is worth more than a dozen
style findings.

## What is not a vulnerability

- **The processor stalling.** A chip advances only when somebody pays for the
  next cycle. Nothing is stuck; nobody thought the cycle was worth the gas.
- **`step()` having no owner check.** That is the design, stated everywhere.
  Any caller may take any cycle and the event records who did.
- **Eight-bit ports being narrow.** The width is the interface between a
  converter and a die, not a limit on what the die can be told.
- **A missing contract address.** `public/scripts/config.js` holds `null`
  until a deployment is real, and the interface renders its disabled state
  rather than pretending.

## Handling secrets

There are no API keys in this project and no `.env` to fill in — see
[`docs/api-keys.md`](docs/api-keys.md).

One private key exists in the workflow and it is never stored: `npm run deploy`
reads `STEPPER_KEY` from the environment, never from a file and never from an
argument, so it cannot reach a shell history, a commit or a log. If you have
ever put a deploy key in a file in this tree, treat it as compromised and
rotate it, whether or not the file was committed.

## Verifying a build yourself

Nothing here asks to be trusted:

```bash
npm run silicon    # rebuild the netlist; refuses to write it unless it passes
npm run evm        # deploy both generations into an EVM and prove them
npm run strategy   # the four programs, on the real gates
```

If `npm run silicon` writes `public/scripts/st8-data.js` and the file differs
from the committed one, that difference is a finding. Please report it.
