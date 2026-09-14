#!/usr/bin/env node
/**
 * feeds.js — find the price feeds on this chain and say what a port would see.
 *
 *   npm run feeds
 *   npm run feeds -- --span 50000
 *   npm run feeds -- --at 0xabc...            one address, inspected directly
 *
 * A FeedPort converts a published quantity into one byte, and to deploy one you
 * need three things: the address that publishes the quantity, the window the
 * byte is spent on, and how old a reading may be. This finds the first and
 * proposes the other two.
 *
 * Nothing here is taken from a document. Feeds are found by the event an
 * aggregator emits when it publishes, and each one is then asked directly what
 * it prices, at what scale, and how long ago. An address that does not answer
 * those three is not listed, because a port wired to it would not work either.
 *
 * The endpoint is reached through tools/rpc.js rather than `fetch`, for the
 * reason that file explains: on at least one consumer network the name resolves
 * to a block page, so the lookup is done over DNS-over-HTTPS and the hostname
 * is pinned for TLS. The certificate is still checked against the real name.
 * What is routed around is a resolver that lies, not the encryption.
 *
 * This is not in CI and must not be added to it. It reads a live chain, so it
 * answers differently every time it runs and is offline on a runner. It is a
 * tool for choosing a deployment argument, not a proof.
 */

"use strict";

const cli = require("./cli.js");
const { client } = require("./rpc.js");

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** AnswerUpdated(int256 indexed, uint256 indexed, uint256). */
const ANSWER_UPDATED =
  "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";

const SEL = {
  decimals: "0x313ce567",
  description: "0x7284e416",
  latestRoundData: "0xfeaf968c",
  aggregator: "0x245a7bfc",
};

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** An ABI string out of a returned word pair. Null when it is not one. */
function decodeString(hex) {
  const s = (hex || "0x").replace(/^0x/, "");
  if (s.length < 128) return null;
  const len = parseInt(s.slice(64, 128), 16);
  if (!Number.isFinite(len) || len === 0 || len > 256) return null;
  const body = s.slice(128, 128 + len * 2);
  if (body.length < len * 2) return null;
  const out = Buffer.from(body, "hex").toString("utf8");
  return /^[\x20-\x7e]+$/.test(out) ? out : null;
}

function signed(hex) {
  let v = BigInt(hex);
  if (v >= 1n << 255n) v -= 1n << 256n;
  return v;
}

/**
 * A window for a byte, proposed from where the price is now.
 *
 * Eight bits are 256 steps and no more, so the window is the whole design: too
 * wide and most of the resolution is spent on prices nothing trades at. A band
 * around the current reading keeps the steps where the movement is, and it is
 * rounded to something a reader can check rather than left at a figure that
 * only makes sense to the script that produced it.
 */
function proposeWindow(price, decimals) {
  const unit = 10 ** decimals;
  const spot = Number(price) / unit;
  if (!(spot > 0)) return null;

  const rawLo = spot * 0.75;
  const rawHi = spot * 1.25;

  /* Round outward to a step that is legible at this magnitude. */
  const mag = Math.pow(10, Math.floor(Math.log10(spot)) - 1);
  const step = mag > 0 ? mag : 1;
  const lo = Math.max(0, Math.floor(rawLo / step) * step);
  const hi = Math.ceil(rawHi / step) * step;

  const byte = Math.min(255, Math.max(0, Math.floor(((spot - lo) / (hi - lo)) * 255)));
  return { lo, hi, spot, byte, perStep: (hi - lo) / 255 };
}

(async function main() {
  cli.header("FEEDS", "what a port could be wired to");

  const rpc = client(arg("rpc", DEFAULT_RPC));
  const span = BigInt(arg("span", "20000"));
  const only = arg("at", null);

  const chainId = await rpc.chainId();
  const head = await rpc.blockNumber();
  console.log("");
  console.log("  chain " + chainId + " at block " + head.toLocaleString("en-US"));

  let found;
  if (only) {
    found = [only.toLowerCase()];
    console.log("  inspecting one address");
  } else {
    /* Chunked, because a node will refuse one enormous range and a caller who
       asked for a wide span meant it. */
    const CHUNK = 2000n;
    const seen = new Set();
    let scanned = 0n;
    for (let to = head; to > head - span; to -= CHUNK) {
      const from = to - CHUNK + 1n > head - span ? to - CHUNK + 1n : head - span;
      try {
        const logs = await rpc.call("eth_getLogs", [{
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          topics: [ANSWER_UPDATED],
        }]);
        for (const l of logs) seen.add(l.address.toLowerCase());
      } catch (e) {
        console.log("  (a range was refused: " + String(e.message).slice(0, 60) + ")");
      }
      scanned += CHUNK;
      if (from <= head - span) break;
    }
    found = [...seen];
    console.log("  " + found.length + " publishing in the last " +
      Number(span).toLocaleString("en-US") + " blocks");
  }

  if (!found.length) {
    console.log("");
    console.log("  Nothing published in that window. Try a wider --span.");
    console.log("");
    return;
  }

  console.log("");

  const rows = [];
  for (const a of found) {
    const row = { address: a };
    try {
      const [d, dc, lr] = await Promise.all([
        rpc.call("eth_call", [{ to: a, data: SEL.description }, "latest"]),
        rpc.call("eth_call", [{ to: a, data: SEL.decimals }, "latest"]),
        rpc.call("eth_call", [{ to: a, data: SEL.latestRoundData }, "latest"]),
      ]);
      row.description = decodeString(d);
      row.decimals = parseInt(dc, 16);
      const s = lr.replace(/^0x/, "");
      if (s.length < 320) continue;
      row.answer = signed("0x" + s.slice(64, 128));
      row.updatedAt = Number(BigInt("0x" + s.slice(192, 256)));
    } catch (e) {
      continue;
    }
    if (!row.description || !Number.isFinite(row.decimals) || row.answer <= 0n) continue;
    rows.push(row);
  }

  rows.sort((x, y) => x.description.localeCompare(y.description));

  const now = Math.floor(Date.now() / 1000);
  const wide = Math.max(14, ...rows.map((r) => r.description.length));

  console.log("  " + "feed".padEnd(wide) + "  " + "price".padStart(14) +
    "  dec  " + "age".padStart(7) + "  address");
  console.log("  " + "-".repeat(wide + 14 + 7 + 7 + 46));

  for (const r of rows) {
    const px = Number(r.answer) / Math.pow(10, r.decimals);
    const age = now - r.updatedAt;
    console.log("  " + r.description.padEnd(wide) + "  " +
      px.toLocaleString("en-US", { maximumFractionDigits: 4 }).padStart(14) + "  " +
      String(r.decimals).padStart(3) + "  " +
      (age + "s").padStart(7) + "  " + r.address);
  }

  console.log("");
  console.log("  A port converts one of these into a byte. What each would give:");
  console.log("");

  for (const r of rows) {
    const w = proposeWindow(r.answer, r.decimals);
    if (!w) continue;
    const q = (n) => BigInt(Math.round(n * Math.pow(10, r.decimals))).toString();
    console.log("  " + r.description);
    console.log("    now " + w.spot.toLocaleString("en-US", { maximumFractionDigits: 4 }) +
      " would arrive as byte " + w.byte + ", one step = " +
      w.perStep.toLocaleString("en-US", { maximumFractionDigits: 4 }));
    console.log("    --feed " + r.address + " --lo " + q(w.lo) + " --hi " + q(w.hi));
    console.log("");
  }

  console.log("  The window is fixed for the life of the port, so choose it once");
  console.log("  and choose it where the movement is.");
  console.log("");
})().catch((e) => {
  process.stderr.write("\n  " + e.message + "\n\n");
  process.exit(1);
});
