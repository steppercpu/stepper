/**
 * config.js: which chain, and what is actually deployed on it.
 *
 * Two networks are described here and exactly one is live. NETWORK picks it,
 * and every field below resolves from that, so the site, the deploy script and
 * the wallet prompt can never disagree about which chain they are on.
 *
 * Anything still null is honestly reported as "not deployed" in the UI. A
 * button that pretends to work is worse than a button that says it doesn't.
 */
window.CONFIG = (function () {
  "use strict";

  /**
   * WHICH ONE IS LIVE. Set by hand, or by the deploy script when it writes an
   * address back.
   *
   * Rehearse on the testnet first: `npm run deploy -- --network testnet`.
   * The sequence is identical, the gas is a thirty-fifth of the price, and a
   * mistake there costs a minute.
   *
   * This stays on mainnet until something is actually deployed. The deploy
   * script flips it when it writes an address, so the site names whichever
   * chain it can really read a chip from and never one it cannot.
   */
  var NETWORK = "mainnet";

  /**
   * The id is the identity. EIP-155 chain ids are how networks are actually
   * addressed, they belong to no company, and the id is the only name this
   * page ever prints for the chain it runs on. See BRAND.chainLabel.
   *
   * `rpc` and `explorer` are endpoints, not branding: they are the literal
   * hosts that have to be dialled, so they read the way DNS reads. Nothing
   * renders them as a name.
   */
  var NETWORKS = {
    mainnet: {
      chainId: 4663,
      chainIdHex: "0x1237",
      // The chain, named for anyone who wants to reach it themselves, and
      // handed to a wallet when it is asked to add this network.
      rpc: "https://rpc.mainnet.chain.robinhood.com",

      // Where THIS PAGE reads from, which is not the same thing.
      //
      // A browser asking the address above directly is a browser that depends
      // on its resolver telling the truth, and at least one large Indonesian
      // ISP does not: it hijacks that hostname and answers with a block page,
      // even for lookups aimed at 8.8.8.8. Visitors on those networks saw
      // "NetworkError when attempting to fetch resource" and a table claiming
      // no chip had been minted, which was false.
      //
      // So reads go to this origin and this origin asks the chain. It is one
      // more hop and one more thing that can be down, against a page that
      // could not be read at all by a large number of people. The endpoint
      // above is still the truth and still in this file; nothing here asks
      // anyone to take our copy of the chain on faith.
      read: "/rpc",
      explorer: "https://robinhoodchain.blockscout.com",
      nativeSymbol: "ETH",

      // ---- T-0: two addresses, and that is the whole launch -------------
      // gateArray is pure and ownerless, so it is deployed once and every
      // chip that ever exists can point at it. chip is Chip: ROM, RAM, the
      // state word, and a step() open to anyone.
      gateArray: "0xeB549a6c80698d3e33eA2F9ffEF2555aB918c36F",

      // Chip #1, minted through the factory below on 10 September 2026 in
      // block 59,386,859. It carries the echo program: the byte a sponsor
      // pays with goes to the output port, for ever, so the port is the last
      // sponsor's signature. Four cycles have been paid for so far, and
      // `npx stepper-cli verify 0x88d965bc…` replays all four off the chain
      // and finds they match.
      chip: "0x88d965bccc9265eac8022524723cb1eb13d6960e",
      chipToken: "0x847ce1e7505b4323ca6c06caee97d87aa8c481ca",

      // The chip this project runs itself, deployed 12 September 2026
      // against the gate array above and carrying the digest program.
      //
      // It has no token of its own on purpose. A second token would compete
      // with STEP for the same attention and this machine exists to give
      // STEP something to pay for, not to be paid for.
      //
      // The program folds every sponsor's byte into one number in the order
      // they arrived, so the output port carries the whole of its past
      // rather than its last visitor. It never halts: the build refuses to
      // ship a netlist unless it survives 20,000 cycles of random input.
      motherChip: "0x7Fb3A882e801A49C41E678c52BceCF9B05283003",

      // The cycle reserve for the chip above, deployed 12 September 2026.
      //
      // It advances that one chip and pays whoever asked, 200 STEP an edge,
      // fixed at construction. One non-view function in the whole contract,
      // no owner, no pause, no setter, nothing payable. Filling it is a plain
      // transfer and there is no way to take anything back out, including for
      // whoever deployed it.
      //
      // `edgesRemaining()` is the honest live number: how many more edges the
      // reserve can pay for, which reads zero the moment it cannot cover one.
      rebate: "0x94b00a1889a6ca25c578c7fd1ef488aa65ae32cc",

      // Chips this project runs, and what each one is for.
      //
      // Everything the factory has minted appears in the fleet table, ours and
      // everybody else's, read from the same calls. This map only decides
      // which rows carry a label, so a reader can tell a machine we operate
      // from a machine somebody else launched without having to know our
      // addresses by heart.
      //
      // It is a declaration and not a proof, which is why the label is a word
      // rather than a claim: the address beside it is the thing to check, and
      // a chip is exactly as open to everyone whatever is written here. No
      // entry in this map gives a chip a privilege, because there is no
      // privilege in Chip.sol to give it.
      projectChips: {
        "0x88d965bccc9265eac8022524723cb1eb13d6960e": "first chip",
        "0x7fb3a882e801a49c41e678c52bcecf9b05283003": "the mother chip",
      },
      // ---- R1: the launchpad, not needed for T-0 ------------------------
      factory: "0xf209De11d54CF0967496D8eD1C79A47242eF3437",   // ERC-721 + mint + per-chip tokens
      renderer: "0x371e9803432550b052da01Cb9fd8F0Fed036d83e",  // what the factory calls

      // The same renderer, corrected, deployed on its own.
      //
      // The one above costs 67,533,668 gas to draw a card — about twice an
      // Ethereum block — so every `eth_call` for it runs out of gas and
      // `tokenURI` reverts for wallets, marketplaces and explorers alike.
      // This one draws the same card for 22,092,544 and returns it.
      //
      // Two keys because there are two contracts and they disagree:
      // `ChipFactory` holds its renderer as an immutable, so the deed's own
      // `tokenURI` keeps calling the old one until a new factory is deployed.
      // The page calls `render()` here directly, which is a view function and
      // needs no factory. Do not collapse these into one name.
      cardRenderer: "0x2f50da98e50369aeb7f08f9a2ff4777ba16d50b2",

      // The launch venue our factory calls to create a chip's token, so the
      // chip and the token are born in one transaction rather than asserted
      // to be related afterwards. Read off chain, not copied from a post:
      // this address answers launchFee(), canLaunch(address) and the
      // launchToken(...) our ChipFactory encodes against.
      venue: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",

      // The project token, live. Read off this chain before it was written
      // here: Stepper CPU / STEP, eighteen decimals, a total supply of
      // 1,000,000,000, and an address whose EIP-55 checksum verifies. The
      // token pays for the clock; it is not the machine, which is the chip
      // above and has its own token of its own.
      token: "0xffC3776650cD2c9641cE72838f85c0a535CC440B",
      market: "https://www.ponsfamily.com/launchpad/0xffC3776650cD2c9641cE72838f85c0a535CC440B",

      // ---- pairs --------------------------------------------------------
      // A chip's pool is created against an ERC-20, and any ERC-20 on this
      // chain will do: the base asset, a tokenised equity, or another chip's
      // token. So this is a shortcut list, not a whitelist, and the launchpad
      // takes a pasted address for everything that is not on it.
      //
      // `address` stays null until it has been read off the chain rather than
      // copied from somewhere. A label with no address is a shortcut the
      // launchpad can show and cannot act on, which is the same rule every
      // other address in this file follows.
      pairs: [
        { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
          note: "the chain's base asset" },
        { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
          note: "a dollar, six decimals" },
        { symbol: "NVDA", address: null, note: "a tokenised equity" },
        { symbol: "TSM", address: null, note: "a tokenised equity" },
        { symbol: "MU", address: null, note: "a tokenised equity" },
        { symbol: "SNDK", address: null, note: "a tokenised equity" },
      ],
    },

    testnet: {
      chainId: 46630,
      chainIdHex: "0xb626",
      rpc: "https://rpc.testnet.chain.robinhood.com",
      // No public block explorer answered for this network when this was
      // written, so the deploy script verifies over eth_call rather than
      // pointing anybody at a page that does not exist.
      explorer: null,
      nativeSymbol: "ETH",

      gateArray: null,
      chip: null,
      factory: null,
      renderer: null,
      token: null,
      market: null,

      // No launch venue answers on this network: the address that runs the
      // launchpad on mainnet has no code here, checked rather than assumed.
      // So the token half of a chip launch cannot be rehearsed on the testnet
      // at all, and deploy-launchpad refuses instead of deploying a factory
      // pointed at nothing. The gate array can and should still be rehearsed
      // here: it is the expensive transaction and the one worth practising.
      venue: null,

      // Nothing is listed here. On a testnet the shortcut list would be a
      // guess, and the pasted-address path works without one.
      pairs: [],
    },
  };

  var net = NETWORKS[NETWORK] || NETWORKS.mainnet;

  var cfg = {
    network: NETWORK,
    networks: NETWORKS,
    isTestnet: NETWORK !== "mainnet",

    defaultChip: 1,

    // ---- gates ---------------------------------------------------------
    // Flip to true at T-0. Until then MINT stays dark on the public site.
    launchpadOpen: true,

    // ---- measured, not estimated ---------------------------------------
    // From `npm run evm`, which deploys the contracts into a real EVM and
    // runs the processor through them. Execution gas: a transaction adds the
    // 21,000 intrinsic cost on top, which is why the site prints the sum.
    //
    // mint stays null because the factory does not exist yet. A number there
    // would be a claim about a contract nobody has written.
    gas: {
      deployArray: 2245595,
      deployChip: 1256739,
      step: 380144,
      intrinsic: 21000,
      mint: null,
    },
  };

  // The active network's fields are lifted to the top, so every reader that
  // already says CONFIG.chip or CONFIG.rpc keeps working and none of them has
  // to know a network switch exists.
  for (var k in net) {
    if (Object.prototype.hasOwnProperty.call(net, k)) cfg[k] = net[k];
  }

  return cfg;
})();
