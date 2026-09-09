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
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://robinhoodchain.blockscout.com",
      nativeSymbol: "ETH",

      // ---- T-0: two addresses, and that is the whole launch -------------
      // gateArray is pure and ownerless, so it is deployed once and every
      // chip that ever exists can point at it. chip is Chip: ROM, RAM, the
      // state word, and a step() open to anyone.
      gateArray: null,
      chip: null,
      // ---- R1: the launchpad, not needed for T-0 ------------------------
      factory: null,   // ERC-721 + mint + per-chip tokens
      renderer: null,  // draws the NFT card on-chain

      // The project token, live. Read off this chain before it was written
      // here: Stepper CPU / STEP, eighteen decimals, a total supply of
      // 1,000,000,000, and an address whose EIP-55 checksum verifies. The
      // token pays for the clock; it is not the machine, and the two fields
      // above are still null because the machine is not deployed yet.
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
        { symbol: "WETH", address: null, note: "the chain's base asset" },
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
    launchpadOpen: false,

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
